"""Defer takeaway kitchen/captain/receipt steps until Razorpay prepay succeeds."""

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
)
from tools.payment_tools import wants_online_payment, is_placeholder_payment_link
from tools.whatsapp_tools import send_whatsapp_message
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
    notify_manager_order_alert,
    assign_and_notify_captain_takeaway,
)

logger = logging.getLogger(__name__)

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
    "order_mode",
    "payment_mode",
)


def prepay_fulfillment_required(session_state: dict[str, Any]) -> bool:
    """True when a real Razorpay link was issued and fulfillment must wait for payment."""
    link = session_state.get("payment_link")
    return bool(
        wants_online_payment(session_state)
        and link
        and not is_placeholder_payment_link(str(link))
    )


def stash_prepay_payload(
    session_state: dict[str, Any],
    booking_id: str,
    payload: dict[str, Any],
) -> None:
    pending = session_state.setdefault("pending_prepay_fulfillment", {})
    pending[str(booking_id)] = payload


async def load_and_clear_prepay_payload(
    restaurant_id: str,
    customer_phone: str,
    booking_id: str,
) -> dict[str, Any] | None:
    state = await get_session_state(restaurant_id, customer_phone)
    pending = dict(state.get("pending_prepay_fulfillment") or {})
    payload = pending.pop(str(booking_id), None)
    if payload is None:
        return None
    state["pending_prepay_fulfillment"] = pending
    await save_session_state(restaurant_id, customer_phone, state)
    return payload


async def fulfill_takeaway_after_payment(payload: dict[str, Any]) -> bool:
    """Captain alert, portal sync, manager/KDS notify, receipt — after Razorpay paid."""
    restaurant_id = payload["restaurant_id"]
    customer_phone = payload["customer_phone"]
    customer_name = payload["customer_name"]
    booking_id = payload["booking_id"]
    cart_snapshot = payload["cart_snapshot"]
    order_text_display = payload["order_text_display"]
    total = float(payload["total"])
    totals = payload.get("totals") or {}
    booking_time = payload["booking_time"]
    token = payload.get("token") or payload.get("display_token")

    portal_token_id = await sync_token_to_portal(
        customer_name=customer_name,
        customer_phone=customer_phone,
        token_type="takeaway",
        pax=1,
        restaurant_id=restaurant_id,
    )
    display_token = portal_token_id or token

    captain_result = await assign_and_notify_captain_takeaway(
        restaurant_id,
        token_number=display_token,
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text_display,
        total=total,
        booking_time=booking_time,
    )

    captain_line = ""
    if captain_result and captain_result.get("captain_name"):
        display = captain_result.get("display_name") or captain_result["captain_name"]
        captain_line = (
            f"\n\n👤 *{display}* is your captain and will coordinate "
            f"your pickup at the counter."
        )

    await send_whatsapp_message(
        customer_phone,
        f"Payment received! ✅\n────────────────────\n"
        f"Token: {display_token}\n"
        f"Your takeaway order is confirmed and sent to the kitchen.{captain_line}",
        restaurant_id,
    )

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

    await notify_kds(
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text_display,
        cart=cart_snapshot,
        table_number=None,
        token_number=display_token,
        service_type="takeaway",
        restaurant_id=restaurant_id,
    )

    try:
        await get_http().post(
            "https://api.autom8.works/api/feedback/queue",
            json={
                "restaurant_id": restaurant_id,
                "customer_phone": customer_phone,
                "customer_name": customer_name,
                "token_number": display_token,
                "table_number": None,
            },
            headers={"Authorization": f"Bearer {KDS_SECRET}"},
            timeout=aiohttp.ClientTimeout(total=5),
        )
    except Exception as exc:
        logger.warning(f"[prepay-fulfill] feedback queue non-fatal: {exc}")

    if RECEIPT_AVAILABLE:
        try:
            r_info = await fetch_restaurant_info(restaurant_id)
            receipt_data = _ReceiptData(
                restaurant_name=r_info.get("name", ""),
                restaurant_address=r_info.get("address", ""),
                restaurant_phone=r_info.get("phone", ""),
                restaurant_gstin=r_info.get("gstin", ""),
                restaurant_wa_number=r_info.get("whatsapp_number", ""),
                restaurant_website=r_info.get("website", ""),
                receipt_url=receipt_qr_url(display_token),
                token_number=display_token,
                service_type="takeaway",
                customer_name=customer_name,
                customer_phone=customer_phone,
                items=_LineItem.from_cart(cart_snapshot),
                gst_rate=5.0,
                gst_inclusive=False,
                parcel_charge=totals.get("parcel_charge", 0),
                payment_mode="Online",
            )
            receipt_path = _generate_receipt(receipt_data)
            logger.info(f"[prepay-fulfill] Receipt saved: {receipt_path}")
            asyncio.create_task(
                upload_and_send_receipt(
                    receipt_path, customer_phone, restaurant_id, display_token,
                )
            )
        except Exception as exc:
            logger.warning(f"[prepay-fulfill] receipt failed (non-fatal): {exc}")

    await update_booking_status(booking_id, "confirmed")
    logger.info(f"[prepay-fulfill] Booking {booking_id} confirmed after payment")
    return True


async def fulfill_takeaway_from_webhook(booking_id: str) -> bool:
    """Load stashed prepay payload and run post-payment takeaway fulfillment."""
    booking = await get_booking_with_customer(booking_id)
    if not booking:
        logger.warning(f"[prepay-fulfill] Booking {booking_id} not found")
        return False
    if booking.get("service_type") != "takeaway":
        return False
    if booking.get("status") == "confirmed":
        logger.info(f"[prepay-fulfill] Booking {booking_id} already confirmed — skip")
        return True

    payload = await load_and_clear_prepay_payload(
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

    return await fulfill_takeaway_after_payment(payload)


def build_prepay_payload(
    *,
    session_state: dict[str, Any],
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    booking_id: str,
    token: str,
    cart_snapshot: dict,
    order_text_display: str,
    total: float,
    totals: dict,
    booking_time: str,
) -> dict[str, Any]:
    return {
        "restaurant_id": restaurant_id,
        "customer_id": customer_id,
        "customer_name": customer_name,
        "customer_phone": customer_phone,
        "booking_id": booking_id,
        "token": token,
        "cart_snapshot": cart_snapshot,
        "order_text_display": order_text_display,
        "total": total,
        "totals": totals,
        "booking_time": booking_time,
        "session_hints": {k: session_state.get(k) for k in _SESSION_HINT_KEYS},
    }
