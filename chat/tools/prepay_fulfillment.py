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
    mark_booking_kds_sent,
    patch_walk_in_token_meta_for_booking,
    patch_walk_in_token_meta,
    save_prepay_fulfillment_payload,
    load_prepay_fulfillment_payload,
    clear_prepay_fulfillment_payload,
)
from tools.scheduled_kds import (
    is_deferred_scheduled_order,
    format_kds_defer_customer_note,
)
from tools.payment_tools import wants_online_payment, is_placeholder_payment_link
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
    "scheduled_kds_lead_minutes",
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


def restore_dine_in_kitchen_from_prepay(
    session_state: dict[str, Any],
    payload: dict[str, Any],
) -> None:
    """Keep order payload available for KDS even if session fields were lost."""
    cart = dict(payload.get("cart_snapshot") or {})
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
    """Return (defer, customer_note) when KDS should wait until the lead window."""
    restaurant_info = None
    if restaurant_id:
        restaurant_info = await fetch_restaurant_info(restaurant_id)
    defer, scheduled_at, release_at = is_deferred_scheduled_order(
        session_hints.get("scheduled_at"),
        session_state=session_hints,
        restaurant_info=restaurant_info,
    )
    if not defer or scheduled_at is None or release_at is None:
        return False, None
    return True, format_kds_defer_customer_note(scheduled_at, release_at)


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

    await notify_kds(
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text,
        cart=cart,
        table_number=None,
        token_number=token,
        service_type=service_type,
        restaurant_id=restaurant_id,
    )
    await mark_booking_kds_sent(booking_id)
    return True


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
    hints = payload.get("session_hints") or {}
    if portal_token_id and hints.get("scheduled_at"):
        await patch_walk_in_token_meta(
            portal_token_id,
            restaurant_id,
            {
                "booking_id": booking_id,
                "order_text": order_text_display,
                "cart": cart_snapshot,
                "scheduled_at": hints.get("scheduled_at"),
            },
        )

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
    kitchen_line = (
        "Your takeaway order is confirmed."
        if defer
        else "Your takeaway order is confirmed and sent to the kitchen."
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

    dispatched_now = await _finalize_kds_for_scheduled_order(
        booking_id=booking_id,
        restaurant_id=restaurant_id,
        customer_phone=customer_phone,
        customer_name=customer_name,
        token=str(display_token),
        order_text=order_text_display,
        cart=cart_snapshot,
        service_type="takeaway",
        session_hints=hints,
        booking_time=booking_time,
        total=total,
    )
    if dispatched_now:
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
    defer, defer_note = await _should_defer_kds_for_scheduled(
        hints, restaurant_id=restaurant_id,
    )
    kitchen_line = (
        "Your delivery order is confirmed."
        if defer
        else "Your delivery order is confirmed and sent to the kitchen."
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
            header = "📅 *Scheduled delivery — paid* ✅" if defer else "🛵 *Deliver Now — paid* ✅"
            await send_whatsapp_message(
                manager_phone,
                f"{header}\n────────────────────\n"
                f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
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
    if dispatched_now:
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
    from agents.customer.booking_helpers import stop_special_notes_timer
    from agents.customer.dine_in_flow import _finalize_special_notes_and_kitchen

    restaurant_id = payload["restaurant_id"]
    customer_phone = payload["customer_phone"]
    customer_name = payload["customer_name"]
    booking_id = payload["booking_id"]

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


async def fulfill_from_webhook(booking_id: str) -> bool:
    booking = await get_booking_with_customer(booking_id)
    if not booking:
        logger.warning(f"[prepay-fulfill] Booking {booking_id} not found")
        return False
    if booking.get("status") == "confirmed":
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

    if payload.get("service_type") == "dine_in":
        state = await get_session_state(booking["restaurant_id"], booking["customer_phone"])
        restore_dine_in_kitchen_from_prepay(state, payload)
        await save_session_state(booking["restaurant_id"], booking["customer_phone"], state)

    success = await fulfill_after_payment(payload)
    if success:
        await clear_prepay_payload(
            booking["restaurant_id"],
            booking["customer_phone"],
            booking_id,
        )
    return success
