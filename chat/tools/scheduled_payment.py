"""Send Razorpay payment links after scheduled order manager approval."""

from __future__ import annotations

import logging
import re
from typing import Any

from tools.db_tools import (
    get_customer,
    get_session_state,
    save_session_state,
    get_scheduled_takeaway_token,
    get_scheduled_delivery_token,
)
from tools.booking_mechanisms import cache_restaurant_pricing
from tools.restaurant_config import get_manager_phone
from agents.customer.booking_helpers import touch_session_activity

logger = logging.getLogger(__name__)

_SCHEDULED_PAYMENT_STEPS = frozenset({
    "awaiting_scheduled_takeaway_approval",
    "awaiting_scheduled_takeaway_payment",
    "awaiting_scheduled_delivery_approval",
    "awaiting_scheduled_delivery_payment",
})

from tools.shortcuts import is_pay_keyword


def is_scheduled_payment_step(step: str | None) -> bool:
    return (step or "") in _SCHEDULED_PAYMENT_STEPS


def _phone_variants(phone: str) -> list[str]:
    digits = re.sub(r"\D", "", phone or "")
    out: list[str] = []
    if digits:
        out.append(digits)
    if len(digits) == 10:
        out.append(f"91{digits}")
    if len(digits) > 10:
        out.append(digits[-10:])
    seen: set[str] = set()
    unique: list[str] = []
    for p in out:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique


async def _load_session_for_phone(restaurant_id: str, phone: str) -> tuple[dict[str, Any], str]:
    """Load conversation context; try phone variants. Returns (session, stored_phone)."""
    for variant in _phone_variants(phone):
        ctx = await get_session_state(restaurant_id, variant)
        if ctx:
            return dict(ctx), variant
    return {}, _phone_variants(phone)[0] if _phone_variants(phone) else phone


def _merge_token_meta_into_session(
    session_state: dict[str, Any],
    token: dict[str, Any],
    *,
    service_type: str,
) -> None:
    meta = token.get("meta") or {}
    if isinstance(meta, str):
        meta = {}
    token_id = token.get("id") or ""

    session_state["restaurant_id"] = session_state.get("restaurant_id")
    session_state["display_token"] = token_id or session_state.get("display_token")
    session_state["token_number"] = session_state.get("display_token")
    session_state["service_type"] = service_type
    session_state["last_service_type"] = service_type
    session_state["booking_id"] = meta.get("booking_id") or session_state.get("booking_id")
    session_state["scheduled_at"] = meta.get("scheduled_at") or session_state.get("scheduled_at")
    session_state["scheduled_at_label"] = (
        meta.get("scheduled_at_label") or session_state.get("scheduled_at_label")
    )
    session_state["kitchen_start_at"] = (
        meta.get("kitchen_start_at") or session_state.get("kitchen_start_at")
    )
    session_state["kitchen_start_at_label"] = (
        meta.get("kitchen_start_at_label") or session_state.get("kitchen_start_at_label")
    )
    session_state["total_cook_minutes"] = (
        meta.get("total_cook_minutes") or session_state.get("total_cook_minutes")
    )
    session_state["order_total"] = meta.get("total") or session_state.get("order_total")
    session_state["order_totals"] = meta.get("totals") or session_state.get("order_totals")
    session_state["pending_order_text"] = (
        meta.get("order_text") or session_state.get("pending_order_text")
    )
    session_state["pending_cart"] = meta.get("cart") or session_state.get("pending_cart")
    if service_type == "delivery":
        session_state["delivery_address"] = (
            meta.get("delivery_address") or session_state.get("delivery_address")
        )
        session_state["scheduled_delivery_approved"] = True
        session_state["booking_step"] = "awaiting_scheduled_delivery_payment"
    else:
        session_state["scheduled_takeaway_approved"] = True
        session_state["booking_step"] = "awaiting_scheduled_takeaway_payment"


async def trigger_scheduled_payment_after_approval(
    restaurant_id: str,
    token: dict[str, Any],
    *,
    manager_phone: str | None = None,
) -> dict[str, Any]:
    """
    After manager approves a scheduled takeaway/delivery token, send the Razorpay
    payment link to the customer and persist session for prepay fulfillment.
    """
    token_type = (token or {}).get("type") or ""
    customer_phone = (token or {}).get("phone") or ""
    if token_type not in ("scheduled_takeaway", "scheduled_delivery"):
        return {"ok": False, "error": f"unsupported token type {token_type!r}"}
    if not customer_phone:
        return {"ok": False, "error": "token missing customer phone"}

    session_state, stored_phone = await _load_session_for_phone(restaurant_id, customer_phone)
    if session_state.get("_scheduled_payment_sent"):
        logger.info(
            f"[scheduled-payment] skip {token.get('id')} — payment already sent"
        )
        return {"ok": True, "skipped": "already_sent"}

    service_type = "takeaway" if token_type == "scheduled_takeaway" else "delivery"
    _merge_token_meta_into_session(session_state, token, service_type=service_type)
    session_state["restaurant_id"] = restaurant_id

    await cache_restaurant_pricing(session_state, restaurant_id)

    customer = await get_customer(restaurant_id, stored_phone)
    customer_id = str((customer or {}).get("id") or session_state.get("customer_id") or "")
    customer_name = (
        (customer or {}).get("name")
        or session_state.get("customer_name")
        or token.get("name")
        or "Guest"
    )
    if customer_id:
        session_state["customer_id"] = customer_id
    session_state["customer_name"] = customer_name

    mgr = (
        manager_phone
        or session_state.get("manager_phone")
        or ""
    )
    if not mgr:
        try:
            mgr = (await get_manager_phone(restaurant_id) or "").strip()
        except Exception:
            mgr = ""
    if mgr:
        session_state["manager_phone"] = mgr

    try:
        if service_type == "takeaway":
            from agents.customer.takeaway_flow import _complete_scheduled_takeaway_after_approval

            result = await _complete_scheduled_takeaway_after_approval(
                restaurant_id, customer_id, customer_name, stored_phone, session_state,
            )
        else:
            from agents.customer.delivery_flow import _complete_scheduled_delivery_after_approval

            result = await _complete_scheduled_delivery_after_approval(
                restaurant_id, customer_id, customer_name, stored_phone,
                mgr, session_state,
            )
    except Exception as exc:
        logger.error(f"[scheduled-payment] failed for {token.get('id')}: {exc}")
        return {"ok": False, "error": str(exc)}

    touch_session_activity(session_state)
    session_state["current_state"] = "booking"
    await save_session_state(restaurant_id, stored_phone, session_state)
    logger.info(
        f"[scheduled-payment] sent payment for {token.get('id')} → {stored_phone} "
        f"status={result.get('status')}"
    )
    return {"ok": True, "result": result}


async def try_trigger_scheduled_payment_on_pay(
    restaurant_id: str,
    customer_phone: str,
    customer_id: str,
    customer_name: str,
    session_state: dict[str, Any],
    manager_phone: str,
) -> dict[str, Any] | None:
    """
    When customer replies PAY — resend link if they have an approved scheduled order.
    Returns a flow result dict, or None if this handler does not apply.
    """
    step = session_state.get("booking_step") or ""

    if step == "awaiting_prepay":
        from agents.customer.booking_helpers import handle_awaiting_prepay
        return await handle_awaiting_prepay(
            customer_phone, restaurant_id, customer_name, "pay", session_state,
        )

    if step in ("awaiting_scheduled_takeaway_payment", "awaiting_scheduled_takeaway_approval"):
        from agents.customer.takeaway_flow import handle_takeaway_flow
        return await handle_takeaway_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, "pay", session_state,
        )

    if step in ("awaiting_scheduled_delivery_payment", "awaiting_scheduled_delivery_approval"):
        from agents.customer.delivery_flow import handle_delivery_flow
        return await handle_delivery_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, "pay", session_state,
        )

    takeaway = await get_scheduled_takeaway_token(restaurant_id, customer_phone)
    if takeaway and takeaway.get("status") == "takeaway":
        return await trigger_scheduled_payment_after_approval(
            restaurant_id, takeaway, manager_phone=manager_phone,
        )

    delivery = await get_scheduled_delivery_token(restaurant_id, customer_phone)
    if delivery and delivery.get("status") == "takeaway":
        return await trigger_scheduled_payment_after_approval(
            restaurant_id, delivery, manager_phone=manager_phone,
        )

    return None
