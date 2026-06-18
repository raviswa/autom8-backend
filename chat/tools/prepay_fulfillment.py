"""Defer KDS, receipt, and staff alerts until Razorpay prepay succeeds."""

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
    "order_mode",
    "payment_mode",
    "delivery_address",
    "delivery_distance_km",
    "delivery_distance_method",
)


def prepay_fulfillment_required(session_state: dict[str, Any]) -> bool:
    link = session_state.get("payment_link")
    return bool(
        wants_online_payment(session_state)
        and link
        and not is_placeholder_payment_link(str(link))
    )


def kitchen_blocked_pending_payment(session_state: dict[str, Any]) -> bool:
    return bool(
        session_state.get("_prepay_blocks_kitchen")
        and not session_state.get("_payment_received")
    )


def stash_prepay_payload(
    session_state: dict[str, Any],
    booking_id: str,
    payload: dict[str, Any],
) -> None:
    pending = session_state.setdefault("pending_prepay_fulfillment", {})
    pending[str(booking_id)] = payload
    session_state["_prepay_blocks_kitchen"] = True


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
    state["_payment_received"] = True
    state.pop("_prepay_blocks_kitchen", None)
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
) -> None:
    if not RECEIPT_AVAILABLE:
        return
    try:
        r_info = await fetch_restaurant_info(restaurant_id)
        receipt_data = _ReceiptData(
            restaurant_name=r_info.get("name", ""),
            restaurant_address=r_info.get("address", ""),
            restaurant_phone=r_info.get("phone", ""),
            restaurant_gstin=r_info.get("gstin", ""),
            restaurant_wa_number=r_info.get("whatsapp_number", ""),
            restaurant_website=r_info.get("website", ""),
            receipt_url=receipt_qr_url(token),
            token_number=token,
            table_number=table_number,
            service_type=service_type,
            customer_name=customer_name,
            customer_phone=customer_phone,
            delivery_address=delivery_address,
            items=_LineItem.from_cart(cart_snapshot) if cart_snapshot else [],
            gst_rate=gst_rate,
            gst_inclusive=False,
            delivery_charge=delivery_charge,
            parcel_charge=parcel_charge,
            payment_mode=payment_mode,
            footer_message=footer_message,
        )
        receipt_path = _generate_receipt(receipt_data)
        logger.info(f"[prepay-fulfill] Receipt saved: {receipt_path}")
        asyncio.create_task(
            upload_and_send_receipt(receipt_path, customer_phone, restaurant_id, token)
        )
    except Exception as exc:
        logger.warning(f"[prepay-fulfill] receipt failed (non-fatal): {exc}")


async def _fulfill_takeaway(payload: dict[str, Any]) -> bool:
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
    cart_snapshot = payload["cart_snapshot"]
    order_text_display = payload["order_text_display"]
    total = float(payload["total"])
    totals = payload.get("totals") or {}
    booking_time = payload["booking_time"]
    token = str(payload.get("token") or "—")
    manager_phone = payload.get("manager_phone") or ""
    delivery_address = payload.get("delivery_address") or ""
    hints = payload.get("session_hints") or {}
    delivery_address = delivery_address or hints.get("delivery_address") or ""

    await send_whatsapp_message(
        customer_phone,
        f"Payment received! ✅\n────────────────────\n"
        f"Token: {token}\n"
        f"Your delivery order is confirmed and sent to the kitchen.\n"
        f"────────────────────\n"
        f"{format_order_total_lines(totals)}",
        restaurant_id,
    )

    dist_note = ""
    if hints.get("delivery_distance_km") is not None:
        from tools.delivery_distance import format_distance_label
        dist_note = (
            f"Distance: {format_distance_label(float(hints['delivery_distance_km']), hints.get('delivery_distance_method'))}\n"
        )
    if manager_phone:
        try:
            await send_whatsapp_message(
                manager_phone,
                f"🛵 *Deliver Now — paid* ✅\n────────────────────\n"
                f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                f"Address: {delivery_address}\n{dist_note}"
                f"Booking Time: {booking_time}\n"
                f"Order: {order_text_display}\n"
                f"Total: ₹{total:.0f}\n────────────────────",
                restaurant_id,
            )
        except Exception as exc:
            logger.warning(f"[prepay-fulfill] delivery manager notify failed: {exc}")

    await notify_kds(
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text_display,
        cart=cart_snapshot,
        table_number=None,
        token_number=token,
        service_type="delivery",
        restaurant_id=restaurant_id,
    )
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
    )
    await update_booking_status(booking_id, "confirmed")
    logger.info(f"[prepay-fulfill] Delivery booking {booking_id} confirmed after payment")
    return True


async def _fulfill_dine_in(payload: dict[str, Any]) -> bool:
    restaurant_id = payload["restaurant_id"]
    customer_phone = payload["customer_phone"]
    customer_name = payload["customer_name"]

    await send_whatsapp_message(
        customer_phone,
        "Payment received! ✅\n\n"
        "Your dine-in order will be sent to the kitchen once you finish "
        "the optional kitchen notes step (or after the 2-minute wait).",
        restaurant_id,
    )

    state = await get_session_state(restaurant_id, customer_phone)
    state["_payment_received"] = True
    state.pop("_prepay_blocks_kitchen", None)
    await save_session_state(restaurant_id, customer_phone, state)

    if state.get("_notes_finalized_pending_payment"):
        from agents.customer.dine_in_flow import _finalize_special_notes_and_kitchen

        await _finalize_special_notes_and_kitchen(
            restaurant_id=restaurant_id,
            customer_phone=customer_phone,
            customer_name=customer_name,
            session_state=state,
            special_notes=state.get("_deferred_special_notes"),
            notify_customer=True,
        )
        await save_session_state(restaurant_id, customer_phone, state)

    logger.info(f"[prepay-fulfill] Dine-in booking {payload['booking_id']} payment received")
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


async def fulfill_from_webhook(booking_id: str) -> bool:
    booking = await get_booking_with_customer(booking_id)
    if not booking:
        logger.warning(f"[prepay-fulfill] Booking {booking_id} not found")
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

    return await fulfill_after_payment(payload)
