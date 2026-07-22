"""Defer KDS, receipt, and staff alerts until Razorpay prepay succeeds.

FIX (scheduled-order-leaks-to-live, Issue 2): _dispatch_to_kds() is the function that
actually creates kds_items for prepay/scheduled orders reached via the webhook
fulfillment path. Previously it trusted the caller's defer/dispatch decision
(_should_defer_kds_for_scheduled), which is computed off session_hints — a dict
snapshotted into the persisted prepay_fulfillment_payload at submission time. If
kitchen_start_at never made it into that snapshot (e.g. a swallowed exception during
schedule computation), the defer check could return False even for a booking whose
real kitchen_start_at (the DB row) is hours in the future, and the order would be
dispatched to Live immediately. _dispatch_to_kds() now re-checks the persisted
booking row directly, right before writing anything, and refuses to dispatch if that
fresh read says the slot hasn't arrived yet — regardless of what the caller believed.
See matching Node-side fix in src/helpers/scheduledJobs.js::dispatchBookingToKds.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import aiohttp

from tools.db_tools import (
    get_session_state,
    save_session_state,
    update_booking_status,
    get_booking_with_customer,
    mark_booking_kds_sent,
    patch_walk_in_token_meta_for_booking,
    patch_walk_in_token_meta,
    save_prepay_fulfillment_payload,
    load_prepay_fulfillment_payload,
    clear_prepay_fulfillment_payload,
    enqueue_scheduled_jobs,
)
from tools.scheduled_kds import (
    is_deferred_scheduled_order,
    format_kds_defer_customer_note,
)
from tools.payment_tools import (
    wants_online_payment,
    is_placeholder_payment_link,
    is_scheduled_order_session,
)
from tools.whatsapp_tools import send_whatsapp_message
from agents.customer.booking_helpers import format_captain_pickup_line, _HOME_HINT
from tools.booking_mechanisms import (
    RECEIPT_AVAILABLE,
    KDS_SECRET,
    _generate_receipt,
    _ReceiptData,
    _LineItem,
    get_http,
    notify_kds,
    sync_token_to_portal,
    fetch_restaurant_info,
    upload_and_send_receipt,
    receipt_qr_url,
    _restaurant_receipt_fields,
    notify_manager_order_alert,
    assign_and_notify_captain_takeaway,
)

logger = logging.getLogger(__name__)

PREPAY_PENDING_FOOTER = (
    "_Your order will be sent to the kitchen after payment is received._"
)
RESERVE_PREPAY_FOOTER = (
    "_Your table will be secured after payment is received._"
)

_SESSION_HINT_KEYS = (
    "pickup_address",
    "pickup_latitude",
    "pickup_longitude",
    "restaurant_city",
    "restaurant_state",
    "restaurant_type",
    "takeaway_ready_range",
    "delivery_ready_range",
    "kitchen_busy",
    "scheduled_at",
    "scheduled_at_label",
    "order_mode",
    "service_type",
    "scheduled_kds_lead_minutes",
    "kitchen_start_at",
    "kitchen_start_at_label",
    "total_cook_minutes",
    "payment_mode",
    "delivery_address",
    "delivery_distance_km",
    "delivery_distance_method",
    "delivery_travel_minutes",
    "delivery_travel_traffic_aware",
)


def _normalize_cart_snapshot(cart_snapshot: Any) -> dict[str, dict[str, Any]]:
    """Coerce cart payloads into canonical cart format keyed by item id.

    Supports legacy/cross-service shapes:
    - {"ITEM_ID": {"title": ..., "qty": ..., "unit_price": ...}}
    - {"items": [{"id"|"retailer_id"|"name", "qty", "unit_price"|"price", ...}]}
    - [{...}, {...}] (same row shape as above)
    """
    if not cart_snapshot:
        return {}

    rows: list[dict[str, Any]] = []
    if isinstance(cart_snapshot, dict):
        maybe_items = cart_snapshot.get("items")
        if isinstance(maybe_items, list):
            rows = [r for r in maybe_items if isinstance(r, dict)]
        else:
            out: dict[str, dict[str, Any]] = {}
            for item_id, line in cart_snapshot.items():
                if not isinstance(line, dict):
                    continue
                title = str(line.get("title") or line.get("name") or item_id).strip() or str(item_id)
                out[str(item_id)] = {
                    "title": title,
                    "name": title,
                    "qty": int(line.get("qty") or line.get("quantity") or 1),
                    "unit_price": float(line.get("unit_price") or line.get("price") or 0),
                }
            return out
    elif isinstance(cart_snapshot, list):
        rows = [r for r in cart_snapshot if isinstance(r, dict)]
    else:
        return {}

    out: dict[str, dict[str, Any]] = {}
    for idx, row in enumerate(rows, start=1):
        item_id = str(
            row.get("retailer_id")
            or row.get("id")
            or row.get("sku")
            or row.get("name")
            or f"item_{idx}"
        ).strip()
        if not item_id:
            item_id = f"item_{idx}"
        title = str(row.get("title") or row.get("name") or item_id).strip() or item_id
        out[item_id] = {
            "title": title,
            "name": title,
            "qty": int(row.get("qty") or row.get("quantity") or 1),
            "unit_price": float(row.get("unit_price") or row.get("price") or 0),
        }
    return out


def prepay_fulfillment_required(session_state: dict[str, Any]) -> bool:
    link = session_state.get("payment_link")
    if not link or is_placeholder_payment_link(str(link)):
        return False
    if is_scheduled_order_session(session_state):
        return True
    return wants_online_payment(session_state)


def restore_dine_in_kitchen_from_prepay(
    session_state: dict[str, Any],
    payload: dict[str, Any],
) -> None:
    """Keep order payload available for KDS even if session fields were lost."""
    cart = _normalize_cart_snapshot(payload.get("cart_snapshot") or {})
    order_text = payload.get("order_text_display") or ""
    if not cart and not order_text:
        return
    snapshot = {"order_text": order_text, "cart": cart}
    session_state.setdefault("_pending_kitchen", snapshot)
    session_state["_prepay_kitchen_snapshot"] = snapshot
    if payload.get("token"):
        session_state.setdefault("display_token", payload["token"])
        session_state.setdefault("token_number", payload["token"])
    if payload.get("table_number") is not None:
        session_state.setdefault("table_number", payload["table_number"])
    if payload.get("manager_phone"):
        session_state.setdefault("manager_phone", payload["manager_phone"])


def kitchen_blocked_pending_payment(session_state: dict[str, Any]) -> bool:
    return bool(
        session_state.get("_prepay_blocks_kitchen")
        and not session_state.get("_payment_received")
    )


def reset_kitchen_state_for_new_checkout(session_state: dict[str, Any]) -> None:
    """Clear flags from a prior paid/served checkout so reorders start fresh."""
    for key in (
        "_kitchen_sent",
        "_kds_order_id",
        "_receipt_sent",
        "_kitchen_send_claimed",
        "_customer_finalize_sent",
        "_notes_finalized_pending_payment",
        "_deferred_special_notes",
        "_payment_received",
        "booking_id",
        "_manager_order_notified_for",
    ):
        session_state.pop(key, None)


def stash_prepay_payload(
    session_state: dict[str, Any],
    booking_id: str,
    payload: dict[str, Any],
) -> None:
    pending = session_state.setdefault("pending_prepay_fulfillment", {})
    pending[str(booking_id)] = payload
    session_state["_prepay_blocks_kitchen"] = True


async def persist_prepay_payload(booking_id: str, payload: dict[str, Any]) -> None:
    """Write payload to session stash and booking row."""
    await save_prepay_fulfillment_payload(booking_id, payload)


async def stash_and_persist_prepay_payload(
    session_state: dict[str, Any],
    booking_id: str,
    payload: dict[str, Any],
) -> None:
    stash_prepay_payload(session_state, booking_id, payload)
    await persist_prepay_payload(booking_id, payload)


async def load_prepay_payload(
    restaurant_id: str,
    customer_phone: str,
    booking_id: str,
) -> dict[str, Any] | None:
    """Load prepay payload from session or booking row (does not clear)."""
    state = await get_session_state(restaurant_id, customer_phone)
    pending = state.get("pending_prepay_fulfillment") or {}
    payload = pending.get(str(booking_id))
    if payload:
        return payload
    return await load_prepay_fulfillment_payload(booking_id)


async def clear_prepay_payload(
    restaurant_id: str,
    customer_phone: str,
    booking_id: str,
) -> None:
    """Remove prepay payload from session and booking row after successful fulfillment."""
    state = await get_session_state(restaurant_id, customer_phone)
    pending = dict(state.get("pending_prepay_fulfillment") or {})
    pending.pop(str(booking_id), None)
    state["pending_prepay_fulfillment"] = pending
    state["_payment_received"] = True
    state.pop("_prepay_blocks_kitchen", None)
    await save_session_state(restaurant_id, customer_phone, state)
    await clear_prepay_fulfillment_payload(booking_id)


async def load_and_clear_prepay_payload(
    restaurant_id: str,
    customer_phone: str,
    booking_id: str,
) -> dict[str, Any] | None:
    """Legacy alias — prefer load_prepay_payload + clear_prepay_payload after success."""
    payload = await load_prepay_payload(restaurant_id, customer_phone, booking_id)
    if payload is None:
        return None
    if payload.get("service_type") == "dine_in":
        state = await get_session_state(restaurant_id, customer_phone)
        restore_dine_in_kitchen_from_prepay(state, payload)
        await save_session_state(restaurant_id, customer_phone, state)
    return payload


def build_prepay_payload(
    *,
    service_type: str,
    session_state: dict[str, Any],
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    booking_id: str,
    token: str,
    total: float,
    booking_time: str,
    order_text_display: str = "",
    cart_snapshot: dict | None = None,
    totals: dict | None = None,
    **extra: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "service_type": service_type,
        "restaurant_id": restaurant_id,
        "customer_id": customer_id,
        "customer_name": customer_name,
        "customer_phone": customer_phone,
        "booking_id": booking_id,
        "token": token,
        "cart_snapshot": cart_snapshot or {},
        "order_text_display": order_text_display,
        "total": total,
        "totals": totals or {},
        "booking_time": booking_time,
        "session_hints": {k: session_state.get(k) for k in _SESSION_HINT_KEYS},
    }
    payload.update(extra)
    return payload


async def _should_defer_kds_for_scheduled(
    session_hints: dict[str, Any],
    *,
    restaurant_id: str | None = None,
) -> tuple[bool, str | None]:
    """Return (defer, customer_note) when KDS should wait until kitchen_start or lead window."""
    kitchen_start = session_hints.get("kitchen_start_at")
    if kitchen_start:
        from datetime import datetime, timezone
        from tools.kitchen_scheduler import format_ist_label, parse_slot_datetime

        ks = parse_slot_datetime(kitchen_start)
        if ks and ks > datetime.now(tz=ks.tzinfo):
            label = session_hints.get("kitchen_start_at_label") or format_ist_label(ks)
            return True, (
                f"👨‍🍳 We'll start your order at *{label}*. "
                "You'll get a message when prep begins and when it's ready."
            )

    restaurant_info = None
    if restaurant_id:
        restaurant_info = await fetch_restaurant_info(restaurant_id)
    defer, scheduled_at, release_at = is_deferred_scheduled_order(
        session_hints.get("scheduled_at"),
        session_state=session_hints,
        restaurant_info=restaurant_info,
        service_type=session_hints.get("service_type"),
    )
    if not defer or scheduled_at is None or release_at is None:
        return False, None
    return True, format_kds_defer_customer_note(scheduled_at, release_at)


async def _refuse_and_reenqueue_if_still_future(
    *,
    booking_id: str | None,
    restaurant_id: str,
    token: str,
    customer_name: str,
    customer_phone: str,
    service_type: str,
) -> bool:
    """
    Hard release-gate re-check, independent of session_hints / the earlier defer
    decision. Reads kitchen_start_at fresh from the bookings row and refuses to let
    dispatch proceed if it's still in the future — closing the gap where a stale or
    lost in-memory hint could otherwise send a scheduled order live too early.

    Returns True if dispatch was refused (caller must not proceed to notify_kds).
    """
    if not booking_id:
        return False
    try:
        fresh = await get_booking_with_customer(booking_id)
    except Exception as exc:
        logger.warning(f"[scheduled-release] fresh booking read failed for {booking_id}: {exc}")
        return False

    ks_raw = fresh.get("kitchen_start_at") if fresh else None
    slot_raw = None
    if fresh:
        slot_raw = fresh.get("scheduled_slot_at") or fresh.get("booking_datetime")

    from datetime import datetime
    from tools.kitchen_scheduler import parse_slot_datetime

    ks_dt = parse_slot_datetime(ks_raw)
    slot_dt = parse_slot_datetime(slot_raw)

    # Prefer cook-based kitchen_start; otherwise treat a still-future pickup/delivery
    # slot as deferred so we never fail-open into live KDS.
    gate_dt = ks_dt
    if gate_dt is None and slot_dt is not None:
        # Conservative: start kitchen at least 45 minutes before slot if timings missing.
        from datetime import timedelta
        gate_dt = slot_dt - timedelta(minutes=45)

    if not gate_dt:
        return False

    if gate_dt <= datetime.now(tz=gate_dt.tzinfo):
        return False

    logger.warning(
        f"[scheduled-release] REFUSED early dispatch booking={booking_id} "
        f"kitchen_start_at={ks_raw} slot={slot_raw} gate={gate_dt.isoformat()} "
        f"(still future, source=fresh DB read) — re-enqueuing instead of live-dispatching"
    )
    try:
        import json

        meta = (fresh or {}).get("schedule_meta") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        cart = _normalize_cart_snapshot(meta.get("cart") or {})
        items: list[dict] = []
        for rid, line in cart.items():
            if not isinstance(line, dict):
                continue
            items.append(
                {
                    "retailer_id": rid,
                    "name": line.get("title") or line.get("name") or "Item",
                    "qty": int(line.get("qty") or 1),
                    "unit_price": float(line.get("unit_price") or 0),
                }
            )
        order_text = (meta.get("order_text") or "").strip()
        if not items and order_text:
            items = [{"retailer_id": "manual", "name": order_text, "qty": 1, "unit_price": 0}]

        await enqueue_scheduled_jobs(
            restaurant_id,
            booking_id,
            token,
            gate_dt.isoformat(),
            {
                "customer_name": customer_name,
                "customer_phone": customer_phone,
                "token_number": token,
                "service_type": service_type,
                "items": items,
                "order_text": order_text,
                "slot_label": meta.get("scheduled_at_label") or "",
                "kitchen_start_label": meta.get("kitchen_start_label") or "",
            },
        )
    except Exception as exc:
        logger.error(f"[scheduled-release] re-enqueue failed for {booking_id}: {exc}")
    return True


async def _dispatch_to_kds(
    *,
    restaurant_id: str,
    customer_name: str,
    customer_phone: str,
    order_text: str,
    cart: dict,
    token: str,
    service_type: str,
    booking_id: str | None = None,
    special_notes: str | None = None,
) -> str | None:
    """Push order to KDS; return order_id only when items were created.

    Hard chokepoint (see module docstring): re-checks the persisted booking row's
    kitchen_start_at right before writing anything, regardless of what the caller's
    defer decision concluded. This is the single enforced gate on the Python side —
    every caller (webhook fulfillment, manual retry) funnels through here.
    """
    if await _refuse_and_reenqueue_if_still_future(
        booking_id=booking_id,
        restaurant_id=restaurant_id,
        token=token,
        customer_name=customer_name,
        customer_phone=customer_phone,
        service_type=service_type,
    ):
        return None

    cart_copy = _normalize_cart_snapshot(cart or {})
    if cart_copy:
        from tools.cart_tools import enrich_cart_titles
        await enrich_cart_titles(cart_copy, restaurant_id)

    order_id = None
    for attempt in range(3):
        order_id = await notify_kds(
            customer_name=customer_name,
            customer_phone=customer_phone,
            order_text=order_text,
            cart=cart_copy,
            table_number=None,
            token_number=token,
            service_type=service_type,
            restaurant_id=restaurant_id,
            special_notes=special_notes,
            booking_id=booking_id,
        )
        if order_id:
            if booking_id:
                await mark_booking_kds_sent(booking_id)
            logger.info(
                f"[scheduled-release] booking={booking_id} released to KDS "
                f"service={service_type} token={token} order_id={order_id}"
            )
            return order_id
        if attempt < 2:
            await asyncio.sleep(0.75 * (attempt + 1))

    logger.error(
        f"[prepay-kds] KDS dispatch FAILED for {service_type} token {token} "
        f"booking={booking_id} restaurant={restaurant_id} "
        f"(cart_lines={len(cart_copy)}, order_text={order_text[:80]!r})"
    )
    return None


async def _build_retry_payload_from_booking(
    booking_id: str,
    booking: dict[str, Any],
) -> dict[str, Any] | None:
    """Rebuild KDS dispatch payload from persisted booking data when session stash is gone."""
    import json

    payload = await load_prepay_fulfillment_payload(booking_id)
    if payload and (payload.get("cart_snapshot") or payload.get("order_text_display")):
        return payload

    meta = booking.get("schedule_meta") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:
            meta = {}

    cart = _normalize_cart_snapshot(meta.get("cart") or {})
    order_text = (meta.get("order_text") or "").strip()

    if not cart and not order_text:
        from tools.db_tools import _portal_meta_for_booking

        portal_meta = await _portal_meta_for_booking(booking["restaurant_id"], booking_id)
        cart = dict(portal_meta.get("cart") or {})
        order_text = (portal_meta.get("order_text") or "").strip()

    if not cart and not order_text:
        return None

    return {
        "restaurant_id": booking["restaurant_id"],
        "customer_phone": booking["customer_phone"],
        "customer_name": booking.get("customer_name") or "Guest",
        "booking_id": booking_id,
        "token": booking.get("token_number"),
        "cart_snapshot": cart,
        "order_text_display": order_text,
        "service_type": booking.get("service_type") or "takeaway",
        "session_hints": {
            "kitchen_start_at": booking.get("kitchen_start_at"),
            "scheduled_at": booking.get("scheduled_slot_at") or booking.get("booking_datetime"),
            "order_mode": meta.get("order_mode") or (
                "scheduled" if (booking.get("kitchen_start_at") or booking.get("scheduled_slot_at")) else None
            ),
            "service_type": booking.get("service_type"),
        },
    }


async def _retry_kds_for_confirmed_booking(
    booking_id: str,
    booking: dict[str, Any],
) -> bool:
    """Re-dispatch KDS when payment confirmed but kitchen board never received items."""
    from tools.scheduled_kds import is_booking_on_kds_future_tab

    if is_booking_on_kds_future_tab(
        kitchen_start_at=booking.get("kitchen_start_at"),
        scheduled_slot_at=booking.get("scheduled_slot_at"),
        booking_datetime=booking.get("booking_datetime"),
        kds_sent_at=booking.get("kds_sent_at"),
        service_type=booking.get("service_type"),
        schedule_meta=booking.get("schedule_meta"),
    ):
        logger.info(
            f"[prepay-kds] Booking {booking_id} on KDS Future tab — no live ticket needed yet"
        )
        return True

    payload = await load_prepay_payload(
        booking["restaurant_id"],
        booking["customer_phone"],
        booking_id,
    )
    if not payload:
        payload = await _build_retry_payload_from_booking(booking_id, booking)
    if not payload:
        logger.error(f"[prepay-kds] No payload to retry KDS for confirmed booking {booking_id}")
        return False

    hints = payload.get("session_hints") or {}
    defer, _ = await _should_defer_kds_for_scheduled(
        hints, restaurant_id=payload["restaurant_id"],
    )
    if defer:
        logger.info(f"[prepay-kds] Booking {booking_id} KDS deferred (scheduled) — OK")
        return True

    # Always use booking portal token for KDS — not walk-in queue #097.
    token = str(
        booking.get("token_number")
        or payload.get("token")
        or payload.get("display_token")
        or "—"
    )
    order_id = await _dispatch_to_kds(
        restaurant_id=payload["restaurant_id"],
        customer_name=payload.get("customer_name") or booking.get("customer_name") or "Guest",
        customer_phone=payload["customer_phone"],
        order_text=payload.get("order_text_display") or "",
        cart=payload.get("cart_snapshot") or {},
        token=token,
        service_type=payload.get("service_type") or booking.get("service_type") or "takeaway",
        booking_id=booking_id,
    )
    return bool(order_id)


async def retry_kds_for_confirmed_booking(
    booking_id: str,
    booking: dict[str, Any] | None = None,
) -> bool:
    if booking is None:
        booking = await get_booking_with_customer(booking_id)
    if not booking:
        return False
    return await _retry_kds_for_confirmed_booking(booking_id, booking)


async def _finalize_kds_for_scheduled_order(
    *,
    booking_id: str,
    restaurant_id: str,
    customer_phone: str,
    customer_name: str,
    token: str,
    order_text: str,
    cart: dict,
    service_type: str,
    session_hints: dict[str, Any],
    manager_phone: str = "",
    delivery_address: str = "",
    booking_time: str = "",
    total: float = 0,
) -> bool:
    """
    Push to KDS now or defer until scheduled_kds_lead_minutes before the slot.
    Returns True when dispatch happened immediately.

    Note: even when this function's own defer check says "go ahead", the actual
    write in _dispatch_to_kds() re-verifies against the persisted booking row and
    will refuse/re-enqueue if that fresh read disagrees. This function's defer
    check remains the primary decision (for correct customer messaging / manager
    alerts), but is no longer the only gate standing between a request and a
    live KDS write.
    """
    defer, defer_note = await _should_defer_kds_for_scheduled(
        session_hints, restaurant_id=restaurant_id,
    )
    if defer:
        logger.info(
            f"[scheduled-kds] Deferred KDS for booking {booking_id} "
            f"(service={service_type}, token={token})"
        )
        await patch_walk_in_token_meta_for_booking(
            booking_id,
            {
                "booking_id": booking_id,
                "order_text": order_text,
                "cart": cart,
                "service_type": service_type,
                "token": token,
                "customer_name": customer_name,
                "customer_phone": customer_phone,
            },
        )
        if manager_phone:
            try:
                await send_whatsapp_message(
                    manager_phone,
                    f"📅 *Scheduled {service_type} — paid* ✅\n"
                    f"Token: {token}\nCustomer: {customer_name}\n"
                    f"Kitchen dispatch is queued for closer to the delivery slot.\n"
                    f"{defer_note}",
                    restaurant_id,
                )
            except Exception as exc:
                logger.warning(f"[scheduled-kds] manager defer notify failed: {exc}")
        return False

    order_id = await _dispatch_to_kds(
        restaurant_id=restaurant_id,
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text,
        cart=cart,
        token=token,
        service_type=service_type,
        booking_id=booking_id,
    )
    return bool(order_id)


async def _queue_feedback(
    restaurant_id: str,
    customer_phone: str,
    customer_name: str,
    token: str,
    table_number: str | None = None,
) -> None:
    try:
        await get_http().post(
            "https://api.autom8.works/api/feedback/queue",
            json={
                "restaurant_id": restaurant_id,
                "customer_phone": customer_phone,
                "customer_name": customer_name,
                "token_number": token,
                "table_number": table_number,
            },
            headers={"Authorization": f"Bearer {KDS_SECRET}"},
            timeout=aiohttp.ClientTimeout(total=5),
        )
    except Exception as exc:
        logger.warning(f"[prepay-fulfill] feedback queue non-fatal: {exc}")


async def _notify_manager_kds_dispatch_failed(
    *,
    restaurant_id: str,
    booking_id: str,
    token: str,
    service_type: str,
    customer_name: str,
    customer_phone: str,
    order_text: str = "",
    total: float | None = None,
    booking_time: str = "",
    manager_phone: str = "",
) -> None:
    """Escalate paid orders that failed KDS dispatch so staff can intervene quickly."""
    from tools.restaurant_config import get_manager_phone

    alert_phone = (manager_phone or "").strip()
    if not alert_phone:
        alert_phone = (await get_manager_phone(restaurant_id) or "").strip()
    if not alert_phone:
        logger.warning(
            f"[prepay-fulfill] Manager KDS failure alert skipped — no manager phone "
            f"for restaurant {restaurant_id}"
        )
        return

    service_label = {
        "takeaway": "Takeaway",
        "delivery": "Delivery",
        "dine_in": "Dine-in",
    }.get((service_type or "").lower(), service_type or "Order")

    total_line = ""
    if total is not None:
        total_line = f"Total: ₹{float(total):.0f}\n"

    order_preview = (order_text or "—").strip()
    if len(order_preview) > 120:
        order_preview = f"{order_preview[:117]}..."

    body = (
        f"⚠️ *KDS Dispatch Failed — Paid Order*\n"
        f"────────────────────\n"
        f"Service: {service_label}\n"
        f"Token: {token}\n"
        f"Booking ID: {booking_id}\n"
        f"Customer: {customer_name}\n"
        f"Phone: {customer_phone}\n"
        + (f"Booking Time: {booking_time}\n" if booking_time else "")
        + total_line
        + f"Order: {order_preview}\n"
        f"────────────────────\n"
        f"Payment is received. Please check the KDS/portal and push this order to kitchen immediately."
    )
    try:
        await send_whatsapp_message(alert_phone, body, restaurant_id)
        logger.info(
            f"[prepay-fulfill] Manager KDS failure alert sent for booking {booking_id} "
            f"token {token}"
        )
    except Exception as exc:
        logger.warning(
            f"[prepay-fulfill] Manager KDS failure alert failed for {booking_id}: {exc}"
        )


async def _send_receipt(
    *,
    restaurant_id: str,
    customer_phone: str,
    customer_name: str,
    token: str,
    service_type: str,
    cart_snapshot: dict,
    totals: dict,
    payment_mode: str = "Online",
    table_number: str = "",
    delivery_address: str = "",
    delivery_charge: float = 0,
    parcel_charge: float = 0,
    footer_message: str = "",
    gst_rate: float = 5.0,
    order_text: str = "",
) -> None:
    if not RECEIPT_AVAILABLE:
        logger.warning("[prepay-fulfill] receipt skipped — generate_receipt unavailable")
        return
    try:
        r_info = await fetch_restaurant_info(restaurant_id)
        r_info = r_info or {}
        token_str = str(token or "—")
        token_clean = token_str.lstrip("#").replace("T-", "")
        items = _LineItem.from_cart(cart_snapshot) if cart_snapshot else []
        if not items and order_text:
            items = _LineItem.from_order_text(order_text)
        receipt_data = _ReceiptData(
            **(_restaurant_receipt_fields(r_info) if _restaurant_receipt_fields else {}),
            receipt_url=receipt_qr_url(token_str),
            token_number=token_str,
            bill_number=token_clean[-6:] if token_clean else "",
            table_number=table_number,
            service_type=service_type,
            customer_name=customer_name,
            customer_phone=customer_phone,
            delivery_address=delivery_address,
            items=items,
            gst_rate=float(totals.get("gst_rate", gst_rate) if totals else gst_rate),
            gst_inclusive=False,
            delivery_charge=float((totals or {}).get("delivery_charge", delivery_charge)),
            parcel_charge=float((totals or {}).get("parcel_charge", parcel_charge)),
            payment_mode=payment_mode,
            footer_message=footer_message or None,
            round_to_integer=True,
        )
        receipt_path = _generate_receipt(receipt_data)
        logger.info(f"[prepay-fulfill] Receipt saved: {receipt_path}")
        # Await so payment webhooks cannot finish before WhatsApp send starts.
        await upload_and_send_receipt(receipt_path, customer_phone, restaurant_id, token_str)
    except Exception as exc:
        logger.warning(f"[prepay-fulfill] receipt failed (non-fatal): {exc}")


async def _ensure_scheduled_schedule_persisted(payload: dict[str, Any]) -> dict[str, Any]:
    """Recompute kitchen_start_at when schedule fields failed to persist at submit time."""
    hints = dict(payload.get("session_hints") or {})
    svc = hints.get("service_type") or payload.get("service_type") or "takeaway"
    if hints.get("kitchen_start_at") and (svc != "delivery" or hints.get("transit_minutes")):
        return hints

    sched_raw = hints.get("scheduled_at")
    booking_id = payload.get("booking_id")
    restaurant_id = payload.get("restaurant_id")
    if not sched_raw or not booking_id or not restaurant_id:
        return hints

    try:
        from datetime import datetime
        from tools.booking_mechanisms import fetch_restaurant_info
        from tools.db_tools import fetch_menu_timing_map, update_booking_schedule
        from tools.kitchen_scheduler import (
            compute_kitchen_start_at,
            format_ist_label,
            parse_slot_datetime,
            resolve_transit_minutes,
        )
        from tools.cart_tools import cart_lines_from_snapshot

        rest = await fetch_restaurant_info(restaurant_id)
        menu_map = await fetch_menu_timing_map(restaurant_id)
        slot_dt = parse_slot_datetime(sched_raw)
        if not slot_dt:
            slot_dt = datetime.fromisoformat(str(sched_raw).replace("Z", "+00:00"))
        cart_snapshot = _normalize_cart_snapshot(payload.get("cart_snapshot") or {})
        order_text = payload.get("order_text_display") or ""
        transit = resolve_transit_minutes(
            svc,
            explicit_minutes=hints.get("delivery_travel_minutes"),
            distance_km=hints.get("delivery_distance_km"),
        )

        schedule = compute_kitchen_start_at(
            slot_dt,
            service_type=svc,
            cart_lines=cart_lines_from_snapshot(cart_snapshot),
            menu_by_retailer_id=menu_map,
            buffer_minutes=int(rest.get("schedule_buffer_minutes") or 15),
            rounding_minutes=int(rest.get("schedule_rounding_minutes") or 30),
            transit_minutes=transit,
        )

        kitchen_start = schedule["kitchen_start_at"]
        slot_at = schedule["scheduled_slot_at"]
        schedule_meta = {
            "order_mode": "scheduled",
            "order_text": order_text,
            "cart": cart_snapshot,
            "kitchen_start_at": kitchen_start.isoformat(),
            "kitchen_start_label": format_ist_label(kitchen_start),
            "scheduled_at": slot_at.isoformat(),
            "scheduled_at_label": hints.get("scheduled_at_label") or "",
            "station_breakdown": schedule.get("station_breakdown") or {},
            "service_type": svc,
            "transit_minutes": transit,
        }

        await update_booking_schedule(
            booking_id,
            kitchen_start_at=kitchen_start.isoformat(),
            scheduled_slot_at=slot_at.isoformat(),
            total_cook_minutes=schedule["total_cook_minutes"],
            total_packing_minutes=schedule["total_packing_minutes"],
            schedule_meta=schedule_meta,
        )

        hints["order_mode"] = "scheduled"
        hints["kitchen_start_at"] = kitchen_start.isoformat()
        hints["scheduled_at"] = slot_at.isoformat()
        hints["scheduled_slot_at"] = slot_at.isoformat()
        hints["kitchen_start_at_label"] = format_ist_label(kitchen_start)
        hints["total_cook_minutes"] = schedule["total_cook_minutes"]
        hints["transit_minutes"] = transit
        payload["session_hints"] = hints
        logger.info(f"[prepay-fulfill] Recovered schedule for booking {booking_id}")
    except Exception as exc:
        # Deliberately non-fatal here (unlike the submit-time computation, see
        # takeaway_flow.py / delivery_flow.py): this is the last recovery chance
        # before the webhook path's own hard release-gate in _dispatch_to_kds()
        # takes over as the final safety net if hints still end up incomplete.
        logger.error(f"[prepay-fulfill] schedule recovery failed for {booking_id}: {exc}")

    return hints


async def _enqueue_scheduled_kds_jobs(payload: dict[str, Any]) -> bool:
    """Persist KDS + prep-start WhatsApp jobs when kitchen_start_at is in the future."""
    from datetime import datetime
    from tools.db_tools import enqueue_scheduled_jobs
    from tools.kitchen_scheduler import format_ist_label, parse_slot_datetime

    hints = payload.get("session_hints") or {}
    kitchen_start = hints.get("kitchen_start_at")
    if not kitchen_start:
        return False

    ks = parse_slot_datetime(kitchen_start)
    if not ks or ks <= datetime.now(tz=ks.tzinfo):
        return False

    booking_id = payload["booking_id"]
    restaurant_id = payload["restaurant_id"]
    token = str(payload.get("token") or payload.get("display_token") or "—")
    cart = _normalize_cart_snapshot(payload.get("cart_snapshot") or {})

    items = []
    for item_id, line in cart.items():
        if not isinstance(line, dict):
            continue
        items.append({
            "retailer_id": str(item_id),
            "name": line.get("title") or line.get("name") or str(item_id),
            "qty": int(line.get("qty") or 1),
            "unit_price": float(line.get("unit_price") or 0),
        })

    service_type = (
        hints.get("service_type")
        or payload.get("service_type")
        or "takeaway"
    )
    job_payload = {
        "customer_name": payload.get("customer_name"),
        "customer_phone": payload.get("customer_phone"),
        "token_number": token,
        "service_type": service_type,
        "items": items,
        "special_notes": None,
        "slot_label": hints.get("scheduled_at_label") or hints.get("scheduled_at") or "",
        "kitchen_start_label": hints.get("kitchen_start_at_label") or format_ist_label(ks),
    }

    await enqueue_scheduled_jobs(
        restaurant_id,
        booking_id,
        token,
        ks.isoformat(),
        job_payload,
    )
    logger.info(
        f"[prepay-fulfill] Enqueued scheduled jobs for {service_type} booking {booking_id} "
        f"at {ks.isoformat()}"
    )
    return True


async def _enqueue_scheduled_takeaway_jobs(payload: dict[str, Any]) -> bool:
    """Backward-compatible alias."""
    return await _enqueue_scheduled_kds_jobs(payload)


async def _fulfill_takeaway(payload: dict[str, Any]) -> bool:
    restaurant_id = payload["restaurant_id"]
    customer_phone = payload["customer_phone"]
    customer_name = payload["customer_name"]
    booking_id = payload["booking_id"]
    cart_snapshot = _normalize_cart_snapshot(payload.get("cart_snapshot") or {})
    order_text_display = payload["order_text_display"]
    total = float(payload["total"])
    totals = payload.get("totals") or {}
    booking_time = payload["booking_time"]
    token = payload.get("token") or payload.get("display_token")
    hints = dict(payload.get("session_hints") or {})
    scheduled_flow = bool(
        hints.get("kitchen_start_at")
        or hints.get("scheduled_at")
        or hints.get("scheduled_slot_at")
        or (hints.get("order_mode") or "").lower() == "scheduled"
    )

    # Always try to recover cook-based kitchen_start before deciding live vs deferred.
    if scheduled_flow or hints.get("scheduled_at") or hints.get("kitchen_start_at"):
        hints = await _ensure_scheduled_schedule_persisted(payload)
        payload["session_hints"] = hints
        scheduled_flow = True
        hints["order_mode"] = hints.get("order_mode") or "scheduled"

    portal_token_id = None
    if not scheduled_flow:
        portal_token_id = await sync_token_to_portal(
            customer_name=customer_name,
            customer_phone=customer_phone,
            token_type="takeaway",
            pax=1,
            restaurant_id=restaurant_id,
        )
    display_token = portal_token_id or token
    kds_token = str(token or display_token)

    jobs_enqueued = await _enqueue_scheduled_takeaway_jobs(payload) if scheduled_flow else False
    defer, defer_note = await _should_defer_kds_for_scheduled(
        hints, restaurant_id=restaurant_id,
    )

    # Fail closed: future scheduled slots must never hit captain + live KDS path.
    if scheduled_flow and (jobs_enqueued or defer or hints.get("kitchen_start_at") or hints.get("scheduled_at")):
        if not jobs_enqueued and not defer:
            # Still have schedule context but defer check said "now" incorrectly —
            # re-check via hard gate before any live write.
            refused = await _refuse_and_reenqueue_if_still_future(
                booking_id=booking_id,
                restaurant_id=restaurant_id,
                token=kds_token,
                customer_name=customer_name,
                customer_phone=customer_phone,
                service_type="takeaway",
            )
            if refused:
                defer = True
                defer_note = defer_note or (
                    "👨‍🍳 Kitchen prep is scheduled for closer to your pickup time."
                )

    if scheduled_flow and (jobs_enqueued or defer):
        sched_label = hints.get("scheduled_at_label") or hints.get("scheduled_at") or "your slot"
        confirm_body = (
            f"Payment received! ✅\n────────────────────\n"
            f"Token: {display_token}\n"
            f"Your scheduled take-away is confirmed for *{sched_label}*."
        )
        if defer_note:
            confirm_body += f"\n\n{defer_note}"
        await send_whatsapp_message(customer_phone, confirm_body, restaurant_id)

        try:
            await notify_manager_order_alert(
                restaurant_id,
                token_number=display_token,
                customer_name=customer_name,
                customer_phone=customer_phone,
                order_text=order_text_display,
                total=total,
                table_number=None,
                party_size=None,
                booking_time=booking_time,
                service_type="takeaway",
            )
        except Exception as exc:
            logger.warning(f"[prepay-fulfill] manager alert failed (non-fatal): {exc}")

        await _send_receipt(
            restaurant_id=restaurant_id,
            customer_phone=customer_phone,
            customer_name=customer_name,
            token=display_token,
            service_type="takeaway",
            cart_snapshot=cart_snapshot,
            totals=totals,
            parcel_charge=float(totals.get("parcel_charge") or 0),
            order_text=order_text_display,
        )
        await update_booking_status(booking_id, "confirmed")
        logger.info(f"[prepay-fulfill] Scheduled takeaway {booking_id} confirmed — jobs queued")
        return True

    if scheduled_flow:
        # Absolute last resort: still refuse live board if DB says future.
        refused = await _refuse_and_reenqueue_if_still_future(
            booking_id=booking_id,
            restaurant_id=restaurant_id,
            token=kds_token,
            customer_name=customer_name,
            customer_phone=customer_phone,
            service_type="takeaway",
        )
        if refused:
            sched_label = hints.get("scheduled_at_label") or hints.get("scheduled_at") or "your slot"
            await send_whatsapp_message(
                customer_phone,
                f"Payment received! ✅\n────────────────────\n"
                f"Token: {display_token}\n"
                f"Your scheduled take-away is confirmed for *{sched_label}*.\n\n"
                f"👨‍🍳 Kitchen prep is scheduled for closer to your pickup time.",
                restaurant_id,
            )
            await _send_receipt(
                restaurant_id=restaurant_id,
                customer_phone=customer_phone,
                customer_name=customer_name,
                token=display_token,
                service_type="takeaway",
                cart_snapshot=cart_snapshot,
                totals=totals,
                parcel_charge=float(totals.get("parcel_charge") or 0),
                order_text=order_text_display,
            )
            await update_booking_status(booking_id, "confirmed")
            logger.info(
                f"[prepay-fulfill] Scheduled takeaway {booking_id} confirmed — "
                "early KDS refused, jobs re-enqueued"
            )
            return True

    captain_result = await assign_and_notify_captain_takeaway(
        restaurant_id,
        token_number=display_token,
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text_display,
        total=total,
        booking_time=booking_time,
    )

    captain_line = format_captain_pickup_line(captain_result)

    hints = payload.get("session_hints") or {}
    defer, defer_note = await _should_defer_kds_for_scheduled(
        hints, restaurant_id=restaurant_id,
    )

    dispatched_now = await _finalize_kds_for_scheduled_order(
        booking_id=booking_id,
        restaurant_id=restaurant_id,
        customer_phone=customer_phone,
        customer_name=customer_name,
        token=kds_token,
        order_text=order_text_display,
        cart=cart_snapshot,
        service_type="takeaway",
        session_hints=hints,
        booking_time=booking_time,
        total=total,
    )

    if defer:
        kitchen_line = "Your takeaway order is confirmed."
    elif dispatched_now:
        kitchen_line = "Your takeaway order is confirmed and sent to the kitchen."
    else:
        kitchen_line = (
            "Your takeaway order is confirmed. "
            "We're pushing it to the kitchen display — please alert staff if it doesn't appear shortly."
        )

    confirm_body = (
        f"Payment received! ✅\n────────────────────\n"
        f"Token: {display_token}\n"
        f"{kitchen_line}{captain_line}"
    )
    if defer and defer_note:
        confirm_body += f"\n\n{defer_note}"
    await send_whatsapp_message(customer_phone, confirm_body, restaurant_id)

    try:
        await notify_manager_order_alert(
            restaurant_id,
            token_number=display_token,
            customer_name=customer_name,
            customer_phone=customer_phone,
            order_text=order_text_display,
            total=total,
            table_number=None,
            party_size=None,
            booking_time=booking_time,
            service_type="takeaway",
        )
    except Exception as exc:
        logger.warning(f"[prepay-fulfill] manager alert failed (non-fatal): {exc}")

    if not defer and not dispatched_now:
        from tools.db_tools import get_booking_with_customer

        booking_row = await get_booking_with_customer(booking_id)
        if booking_row:
            dispatched_now = await retry_kds_for_confirmed_booking(booking_id, booking_row)
    if not defer and not dispatched_now:
        logger.error(
            f"[prepay-fulfill] Takeaway KDS failed for booking {booking_id} token {kds_token}"
        )
        await _notify_manager_kds_dispatch_failed(
            restaurant_id=restaurant_id,
            booking_id=booking_id,
            token=str(display_token),
            service_type="takeaway",
            customer_name=customer_name,
            customer_phone=customer_phone,
            order_text=order_text_display,
            total=total,
            booking_time=booking_time,
            manager_phone=str(payload.get("manager_phone") or ""),
        )
        logger.warning(
            f"[prepay-fulfill] Continuing customer post-payment steps for {booking_id} "
            "despite KDS dispatch failure"
        )

    if not defer:
        await _queue_feedback(restaurant_id, customer_phone, customer_name, display_token)
    await _send_receipt(
        restaurant_id=restaurant_id,
        customer_phone=customer_phone,
        customer_name=customer_name,
        token=display_token,
        service_type="takeaway",
        cart_snapshot=cart_snapshot,
        totals=totals,
        parcel_charge=float(totals.get("parcel_charge") or 0),
        order_text=order_text_display,
    )
    await update_booking_status(booking_id, "confirmed")
    logger.info(f"[prepay-fulfill] Takeaway booking {booking_id} confirmed after payment")
    return True


async def _fulfill_delivery(payload: dict[str, Any]) -> bool:
    from tools.order_pricing import format_order_total_lines

    restaurant_id = payload["restaurant_id"]
    customer_phone = payload["customer_phone"]
    customer_name = payload["customer_name"]
    booking_id = payload["booking_id"]
    cart_snapshot = _normalize_cart_snapshot(payload.get("cart_snapshot") or {})
    order_text_display = payload["order_text_display"]
    total = float(payload["total"])
    totals = payload.get("totals") or {}
    booking_time = payload["booking_time"]
    token = str(payload.get("token") or "—")
    manager_phone = payload.get("manager_phone") or ""
    delivery_address = payload.get("delivery_address") or ""
    hints = dict(payload.get("session_hints") or {})
    delivery_address = delivery_address or hints.get("delivery_address") or ""
    scheduled_flow = bool(
        hints.get("kitchen_start_at")
        or hints.get("scheduled_at")
        or hints.get("scheduled_slot_at")
        or (hints.get("order_mode") or "").lower() == "scheduled"
    )
    if scheduled_flow or hints.get("scheduled_at") or hints.get("kitchen_start_at"):
        hints = await _ensure_scheduled_schedule_persisted(payload)
        payload["session_hints"] = hints
        scheduled_flow = True
        hints["order_mode"] = hints.get("order_mode") or "scheduled"

    jobs_enqueued = await _enqueue_scheduled_kds_jobs(payload) if scheduled_flow else False
    defer, defer_note = await _should_defer_kds_for_scheduled(
        hints, restaurant_id=restaurant_id,
    )

    if scheduled_flow and (jobs_enqueued or defer or hints.get("kitchen_start_at") or hints.get("scheduled_at")):
        if not jobs_enqueued and not defer:
            refused = await _refuse_and_reenqueue_if_still_future(
                booking_id=booking_id,
                restaurant_id=restaurant_id,
                token=token,
                customer_name=customer_name,
                customer_phone=customer_phone,
                service_type="delivery",
            )
            if refused:
                defer = True
                defer_note = defer_note or (
                    "👨‍🍳 Kitchen prep is scheduled for closer to your delivery slot."
                )

    if scheduled_flow and (jobs_enqueued or defer):
        sched_label = hints.get("scheduled_at_label") or hints.get("scheduled_at") or "your slot"
        confirm_body = (
            f"Payment received! ✅\n────────────────────\n"
            f"Token: {token}\n"
            f"Your scheduled delivery is confirmed for *{sched_label}*."
        )
        if defer_note:
            confirm_body += f"\n\n{defer_note}"
        await send_whatsapp_message(customer_phone, confirm_body, restaurant_id)
        if manager_phone:
            try:
                await send_whatsapp_message(
                    manager_phone,
                    f"📅 *Scheduled delivery — paid* ✅\n"
                    f"Token: {token}\nCustomer: {customer_name}\n"
                    f"Kitchen dispatch is queued for closer to the delivery slot.\n"
                    f"{defer_note or ''}",
                    restaurant_id,
                )
            except Exception as exc:
                logger.warning(f"[prepay-fulfill] delivery manager defer notify failed: {exc}")
        await _send_receipt(
            restaurant_id=restaurant_id,
            customer_phone=customer_phone,
            customer_name=customer_name,
            token=token,
            service_type="delivery",
            cart_snapshot=cart_snapshot,
            totals=totals,
            delivery_address=delivery_address,
            delivery_charge=float(totals.get("delivery_charge") or payload.get("delivery_fee") or 0),
            parcel_charge=float(totals.get("parcel_charge") or 0),
            order_text=order_text_display,
        )
        await update_booking_status(booking_id, "confirmed")
        logger.info(f"[prepay-fulfill] Scheduled delivery {booking_id} confirmed — jobs queued")
        return True

    if scheduled_flow:
        refused = await _refuse_and_reenqueue_if_still_future(
            booking_id=booking_id,
            restaurant_id=restaurant_id,
            token=token,
            customer_name=customer_name,
            customer_phone=customer_phone,
            service_type="delivery",
        )
        if refused:
            sched_label = hints.get("scheduled_at_label") or hints.get("scheduled_at") or "your slot"
            await send_whatsapp_message(
                customer_phone,
                f"Payment received! ✅\n────────────────────\n"
                f"Token: {token}\n"
                f"Your scheduled delivery is confirmed for *{sched_label}*.\n\n"
                f"👨‍🍳 Kitchen prep is scheduled for closer to your delivery slot.",
                restaurant_id,
            )
            await _send_receipt(
                restaurant_id=restaurant_id,
                customer_phone=customer_phone,
                customer_name=customer_name,
                token=token,
                service_type="delivery",
                cart_snapshot=cart_snapshot,
                totals=totals,
                delivery_address=delivery_address,
                delivery_charge=float(totals.get("delivery_charge") or payload.get("delivery_fee") or 0),
                parcel_charge=float(totals.get("parcel_charge") or 0),
                order_text=order_text_display,
            )
            await update_booking_status(booking_id, "confirmed")
            logger.info(
                f"[prepay-fulfill] Scheduled delivery {booking_id} confirmed — "
                "early KDS refused, jobs re-enqueued"
            )
            return True

    dispatched_now = await _finalize_kds_for_scheduled_order(
        booking_id=booking_id,
        restaurant_id=restaurant_id,
        customer_phone=customer_phone,
        customer_name=customer_name,
        token=token,
        order_text=order_text_display,
        cart=cart_snapshot,
        service_type="delivery",
        session_hints=hints,
        manager_phone=manager_phone,
        delivery_address=delivery_address,
        booking_time=booking_time,
        total=total,
    )

    if not dispatched_now and not defer:
        from tools.db_tools import get_booking_with_customer

        booking_row = await get_booking_with_customer(booking_id)
        if booking_row:
            dispatched_now = await retry_kds_for_confirmed_booking(booking_id, booking_row)

    if defer:
        kitchen_line = "Your delivery order is confirmed."
    elif dispatched_now:
        kitchen_line = "Your delivery order is confirmed and sent to the kitchen."
    else:
        kitchen_line = (
            "Your delivery order is confirmed. "
            "We're pushing it to the kitchen display — please alert staff if it doesn't appear shortly."
        )

    confirm_body = (
        f"Payment received! ✅\n────────────────────\n"
        f"Token: {token}\n"
        f"{kitchen_line}\n"
        f"────────────────────\n"
        f"{format_order_total_lines(totals)}"
    )
    if defer and defer_note:
        confirm_body += f"\n\n{defer_note}"
    await send_whatsapp_message(customer_phone, confirm_body, restaurant_id)

    dist_note = ""
    if hints.get("delivery_distance_km") is not None:
        from tools.delivery_distance import format_distance_label
        dist_note = (
            f"Distance: {format_distance_label(float(hints['delivery_distance_km']), hints.get('delivery_distance_method'))}\n"
        )
    if manager_phone:
        try:
            is_scheduled = bool(hints.get("scheduled_at"))
            header = (
                "📅 *Scheduled delivery — paid* ✅"
                if is_scheduled
                else "🛵 *Deliver Now — paid* ✅"
            )
            sched_line = ""
            if is_scheduled and hints.get("scheduled_at"):
                try:
                    from datetime import datetime
                    raw = str(hints["scheduled_at"]).replace("Z", "+00:00")
                    dt = datetime.fromisoformat(raw)
                    h = dt.hour % 12 or 12
                    ampm = "PM" if dt.hour >= 12 else "AM"
                    sched_line = f"Deliver by: {dt.strftime('%d %b %Y')}, {h}:{dt.minute:02d} {ampm}\n"
                except (ValueError, TypeError):
                    sched_line = f"Deliver by: {hints.get('scheduled_at')}\n"
            await send_whatsapp_message(
                manager_phone,
                f"{header}\n────────────────────\n"
                f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                f"{sched_line}"
                f"Address: {delivery_address}\n{dist_note}"
                f"Booking Time: {booking_time}\n"
                f"Order: {order_text_display}\n"
                f"Total: ₹{total:.0f}\n"
                + (f"{defer_note}\n" if defer and defer_note else "")
                + "────────────────────",
                restaurant_id,
            )
        except Exception as exc:
            logger.warning(f"[prepay-fulfill] delivery manager notify failed: {exc}")

    if not defer and not dispatched_now:
        logger.error(
            f"[prepay-fulfill] Delivery KDS failed for booking {booking_id} token {token}"
        )
        await _notify_manager_kds_dispatch_failed(
            restaurant_id=restaurant_id,
            booking_id=booking_id,
            token=token,
            service_type="delivery",
            customer_name=customer_name,
            customer_phone=customer_phone,
            order_text=order_text_display,
            total=total,
            booking_time=booking_time,
            manager_phone=manager_phone,
        )
        logger.warning(
            f"[prepay-fulfill] Continuing customer post-payment steps for {booking_id} "
            "despite KDS dispatch failure"
        )

    if not defer:
        await _queue_feedback(restaurant_id, customer_phone, customer_name, token)
    await _send_receipt(
        restaurant_id=restaurant_id,
        customer_phone=customer_phone,
        customer_name=customer_name,
        token=token,
        service_type="delivery",
        cart_snapshot=cart_snapshot,
        totals=totals,
        delivery_address=delivery_address,
        delivery_charge=float(totals.get("delivery_charge") or payload.get("delivery_fee") or 0),
        parcel_charge=float(totals.get("parcel_charge") or 0),
        order_text=order_text_display,
    )
    await update_booking_status(booking_id, "confirmed")
    logger.info(f"[prepay-fulfill] Delivery booking {booking_id} confirmed after payment")
    return True


async def _fulfill_dine_in(payload: dict[str, Any]) -> bool:
    from agents.customer.booking_helpers import stop_special_notes_timer
    from agents.customer.dine_in_flow import _finalize_special_notes_and_kitchen

    restaurant_id = payload["restaurant_id"]
    customer_phone = payload["customer_phone"]
    customer_name = payload["customer_name"]
    booking_id = payload["booking_id"]
    cart_snapshot = _normalize_cart_snapshot(payload.get("cart_snapshot") or {})
    totals = payload.get("totals") or {}
    token = str(payload.get("token") or payload.get("display_token") or "—")
    table_number = payload.get("table_number")
    order_text_display = payload.get("order_text_display") or ""
    booking_time = str(payload.get("booking_time") or "")
    total = float(payload.get("total") or 0)

    state = await get_session_state(restaurant_id, customer_phone)
    state["_payment_received"] = True
    state.pop("_prepay_blocks_kitchen", None)
    restore_dine_in_kitchen_from_prepay(state, payload)

    stop_special_notes_timer(customer_phone)

    state.pop("_customer_finalize_sent", None)
    state.pop("_kitchen_send_claimed", None)
    state.pop("_kitchen_sent", None)
    state.pop("_kds_order_id", None)

    notes = (
        state.get("_deferred_special_notes")
        if state.get("_notes_finalized_pending_payment")
        else None
    )
    await _finalize_special_notes_and_kitchen(
        restaurant_id=restaurant_id,
        customer_phone=customer_phone,
        customer_name=customer_name,
        session_state=state,
        special_notes=notes,
        notify_customer=False,
        force_kitchen_send=True,
    )
    dispatched = bool(state.get("_kitchen_sent"))

    if not dispatched:
        from tools.db_tools import get_booking_with_customer

        booking_row = await get_booking_with_customer(booking_id)
        if booking_row:
            dispatched = await retry_kds_for_confirmed_booking(booking_id, booking_row)

    if dispatched:
        await send_whatsapp_message(
            customer_phone,
            "Payment received! ✅\n\n"
            "Your order is confirmed and sent to the kitchen. Enjoy your meal! 🍽️",
            restaurant_id,
        )
    else:
        await send_whatsapp_message(
            customer_phone,
            "Payment received! ✅\n\n"
            "We're sending your order to the kitchen now — "
            "please alert staff if it doesn't appear on the display within a minute."
            + _HOME_HINT,
            restaurant_id,
        )
        await _notify_manager_kds_dispatch_failed(
            restaurant_id=restaurant_id,
            booking_id=booking_id,
            token=token,
            service_type="dine_in",
            customer_name=customer_name,
            customer_phone=customer_phone,
            order_text=order_text_display,
            total=total,
            booking_time=booking_time,
            manager_phone=str(payload.get("manager_phone") or state.get("manager_phone") or ""),
        )

    await save_session_state(restaurant_id, customer_phone, state)
    await _queue_feedback(
        restaurant_id,
        customer_phone,
        customer_name,
        token,
        table_number=str(table_number) if table_number is not None else None,
    )
    # Kitchen finalize already sends the receipt via _fire_kitchen_and_receipt;
    # only send here if that path did not (e.g. missing pending kitchen payload).
    if not state.get("_receipt_sent"):
        await _send_receipt(
            restaurant_id=restaurant_id,
            customer_phone=customer_phone,
            customer_name=customer_name,
            token=token,
            service_type="dine_in",
            cart_snapshot=cart_snapshot,
            totals=totals,
            table_number=str(table_number or ""),
            order_text=order_text_display,
        )
        state["_receipt_sent"] = True
        await save_session_state(restaurant_id, customer_phone, state)
    await update_booking_status(booking_id, "confirmed")
    logger.info(
        f"[prepay-fulfill] Dine-in booking {booking_id} payment received "
        f"(kds={'sent' if dispatched else 'pending'})"
    )
    return True


async def _fulfill_reserve_table(payload: dict[str, Any]) -> bool:
    restaurant_id = payload["restaurant_id"]
    customer_phone = payload["customer_phone"]
    customer_name = payload["customer_name"]
    booking_id = payload["booking_id"]
    token = payload.get("token") or ""
    party_size = payload.get("party_size")
    display_dt = payload.get("display_dt") or ""
    advance_amount = float(payload.get("advance_amount") or payload.get("total") or 0)

    await sync_token_to_portal(
        customer_name=customer_name,
        customer_phone=customer_phone,
        token_type="dinein",
        pax=party_size or 1,
        restaurant_id=restaurant_id,
    )

    await send_whatsapp_message(
        customer_phone,
        f"Payment received! ✅\n────────────────────\n"
        f"Token: {token}\n"
        f"Your table reservation is confirmed for *{display_dt}* "
        f"({party_size} guests).\n\n"
        f"Tell our staff your token *{token}* when you arrive!",
        restaurant_id,
    )

    await _send_receipt(
        restaurant_id=restaurant_id,
        customer_phone=customer_phone,
        customer_name=customer_name,
        token=token,
        service_type="reserve_table",
        cart_snapshot={},
        totals={},
        gst_rate=0.0,
        footer_message=f"Reservation for {display_dt} — {party_size} guests 😊",
    )
    await update_booking_status(booking_id, "confirmed")
    logger.info(f"[prepay-fulfill] Reservation booking {booking_id} confirmed after payment")
    return True


async def fulfill_after_payment(payload: dict[str, Any]) -> bool:
    handlers = {
        "takeaway": _fulfill_takeaway,
        "delivery": _fulfill_delivery,
        "dine_in": _fulfill_dine_in,
        "reserve_table": _fulfill_reserve_table,
    }
    handler = handlers.get(payload.get("service_type"))
    if not handler:
        logger.error(f"[prepay-fulfill] Unknown service_type: {payload.get('service_type')}")
        return False
    return await handler(payload)


def _hydrate_schedule_hints_from_booking(
    payload: dict[str, Any],
    booking: dict[str, Any],
) -> dict[str, Any]:
    """Backfill schedule hints from booking row to keep scheduled orders off Live before release."""
    hints = dict(payload.get("session_hints") or {})

    kitchen_start = booking.get("kitchen_start_at")
    slot_at = booking.get("scheduled_slot_at") or booking.get("booking_datetime")
    service_type = booking.get("service_type") or payload.get("service_type")

    if kitchen_start and not hints.get("kitchen_start_at"):
        hints["kitchen_start_at"] = kitchen_start
    if slot_at and not hints.get("scheduled_at"):
        hints["scheduled_at"] = slot_at
    if service_type and not hints.get("service_type"):
        hints["service_type"] = service_type

    # If schedule times exist, force scheduled mode so defer checks are applied.
    if (kitchen_start or slot_at) and not hints.get("order_mode"):
        hints["order_mode"] = "scheduled"

    payload["session_hints"] = hints
    if service_type and not payload.get("service_type"):
        payload["service_type"] = service_type
    if booking.get("token_number") and not payload.get("token"):
        payload["token"] = str(booking.get("token_number"))
    return payload


async def fulfill_from_webhook(booking_id: str) -> bool:
    booking = await get_booking_with_customer(booking_id)
    if not booking:
        logger.warning(f"[prepay-fulfill] Booking {booking_id} not found")
        return False
    if booking.get("status") == "confirmed":
        if booking.get("service_type") in ("takeaway", "delivery", "dine_in"):
            logger.warning(
                f"[prepay-fulfill] Booking {booking_id} confirmed — verify/repair KDS dispatch"
            )
            return await _retry_kds_for_confirmed_booking(booking_id, booking)
        logger.info(f"[prepay-fulfill] Booking {booking_id} already confirmed — skip")
        return True

    payload = await load_prepay_payload(
        booking["restaurant_id"],
        booking["customer_phone"],
        booking_id,
    )
    if not payload:
        logger.error(
            f"[prepay-fulfill] No pending payload for booking {booking_id} "
            f"(customer {booking.get('customer_phone')})"
        )
        return False

    # Rehydrate scheduling hints from durable booking fields.
    # This prevents scheduled takeaway/delivery from being pushed to live KDS
    # immediately when session-scoped hints are missing in the saved payload.
    payload.setdefault("service_type", booking.get("service_type"))
    hints = dict(payload.get("session_hints") or {})
    schedule_meta = booking.get("schedule_meta") or {}
    if not isinstance(schedule_meta, dict):
        schedule_meta = {}

    has_scheduled_context = bool(
        booking.get("kitchen_start_at")
        or booking.get("scheduled_slot_at")
        or booking.get("booking_datetime")
        or schedule_meta.get("scheduled_at")
        or schedule_meta.get("kitchen_start_at")
    )
    if booking.get("service_type") in ("takeaway", "delivery") and has_scheduled_context:
        hints.setdefault("order_mode", "scheduled")
        hints.setdefault("service_type", booking.get("service_type"))
        hints.setdefault(
            "scheduled_at",
            booking.get("scheduled_slot_at")
            or booking.get("booking_datetime")
            or schedule_meta.get("scheduled_at"),
        )
        hints.setdefault(
            "kitchen_start_at",
            booking.get("kitchen_start_at")
            or schedule_meta.get("kitchen_start_at"),
        )
        hints.setdefault("scheduled_at_label", schedule_meta.get("scheduled_at_label"))
        hints.setdefault("kitchen_start_at_label", schedule_meta.get("kitchen_start_at_label"))
        if schedule_meta.get("delivery_travel_minutes") is not None:
            hints.setdefault("delivery_travel_minutes", schedule_meta.get("delivery_travel_minutes"))
        if schedule_meta.get("transit_minutes") is not None:
            hints.setdefault("transit_minutes", schedule_meta.get("transit_minutes"))
        payload["session_hints"] = hints

    if payload.get("service_type") == "dine_in":
        state = await get_session_state(booking["restaurant_id"], booking["customer_phone"])
        restore_dine_in_kitchen_from_prepay(state, payload)
        await save_session_state(booking["restaurant_id"], booking["customer_phone"], state)

    payload = _hydrate_schedule_hints_from_booking(payload, booking)

    logger.info(
        f"[prepay-fulfill] webhook fulfilling booking={booking_id} "
        f"service_type={payload.get('service_type')} "
        f"kitchen_start_at={payload.get('session_hints', {}).get('kitchen_start_at')}"
    )
    success = await fulfill_after_payment(payload)
    if success:
        await clear_prepay_payload(
            booking["restaurant_id"],
            booking["customer_phone"],
            booking_id,
        )
    return success