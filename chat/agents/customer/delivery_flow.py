"""
agents/customer/delivery_flow.py
──────────────────────────────────
Delivery booking flow — immediate and scheduled delivery.

Scheduled delivery: WhatsApp Flow calendar only (no typed date/time).
Manager approval before payment/KDS when scheduled_at is set.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Dict, Any

import aiohttp

from tools.db_tools import (
    get_next_token_number,
    create_booking,
    update_booking_status,
    get_scheduled_delivery_token,
)
from tools.payment_tools import build_payment_line
from tools.prepay_fulfillment import (
    prepay_fulfillment_required,
    build_prepay_payload,
    stash_and_persist_prepay_payload,
    PREPAY_PENDING_FOOTER,
    _finalize_kds_for_scheduled_order,
)
from tools.whatsapp_tools import send_whatsapp_message, send_location_request, send_whatsapp_flow
from tools.cart_tools import cart_to_order_text, clear_cart
from tools.order_pricing import (
    compute_order_totals,
    format_order_total_lines,
    resolve_delivery_charge,
    check_min_order,
    parse_scheduled_delivery_time,
    format_scheduled_note,
)
from tools.order_timing import ready_time_note_from_session
from tools.delivery_distance import finalize_delivery_address, format_distance_label
from tools.booking_mechanisms import (
    RECEIPT_AVAILABLE,
    _generate_receipt,
    _ReceiptData,
    _LineItem,
    KDS_SECRET,
    get_http,
    notify_kds,
    fetch_restaurant_info,
    upload_and_send_receipt,
    receipt_qr_url,
    cache_restaurant_pricing,
    sync_scheduled_delivery_to_portal,
)
from agents.customer.booking_helpers import (
    _HOME_HINT,
    now_display,
    send_catalog_with_fallback,
    strip_order_quantity,
    parse_booking_datetime,
    parse_flow_datetime,
    handle_unknown_booking_step,
)
from agents.customer.conversation_helpers import safe_build_order_suggestion
from config.settings import settings

logger = logging.getLogger(__name__)

_MANAGER_APPROVAL_NOTE = (
    "\n\n📋 *Scheduled door deliveries need manager approval before payment.* "
    "We'll message you once confirmed."
)


def _requires_scheduled_delivery_approval(session_state: Dict[str, Any]) -> bool:
    """Calendar-scheduled deliveries always need manager approval before payment."""
    return bool(session_state.get("scheduled_at"))


async def offer_delivery_schedule(
    customer_phone: str,
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    session_state: Dict[str, Any],
    *,
    kitchen_closed: bool = True,
) -> Dict[str, Any]:
    """WhatsApp Flow calendar only — platform rule: no typed date/time input."""
    from tools.kitchen_hours import is_kitchen_open, next_open_label

    closed = kitchen_closed or not is_kitchen_open()
    flow_id = (
        settings.meta_flow_delivery_schedule_id
        or settings.meta_flow_reservation_id
    )
    needs_approval = bool(session_state.get("scheduled_delivery_enabled"))
    approval_note = (
        "\n\nScheduled deliveries need manager approval before payment."
        if needs_approval else ""
    )
    if flow_id and flow_id != "your_flow_id_here":
        flow_token = f"delivery_{customer_id}_{int(time.time())}"
        session_state["flow_token"] = flow_token
        if closed:
            flow_body = (
                f"Hi {customer_name}! We're not taking immediate delivery orders yet "
                f"— we open at *{next_open_label()}*.\n\n"
                f"Tap below to pick when you'd like your food delivered.{approval_note}"
            )
        else:
            flow_body = (
                f"Hi {customer_name}! Tap below to pick your delivery date and time "
                f"on the calendar.{approval_note}"
            )
        ok = await send_whatsapp_flow(
            phone=customer_phone,
            flow_id=flow_id,
            flow_token=flow_token,
            flow_cta="Select Date & Time",
            flow_header="🛵 Scheduled Door Delivery",
            flow_body=flow_body,
            flow_footer="Calendar — pick date and time",
            restaurant_id=restaurant_id,
        )
        if ok:
            session_state["booking_step"] = "awaiting_scheduled_flow"
            session_state["last_service_type"] = "delivery"
            session_state["service_type"] = "delivery"
            session_state["order_mode"] = "scheduled"
            session_state["schedule_flow_sent"] = True
            session_state.pop("schedule_text_fallback", None)
            return {"status": "awaiting_scheduled_flow"}

        if not session_state.get("_schedule_flow_retry"):
            session_state["_schedule_flow_retry"] = True
            return await offer_delivery_schedule(
                customer_phone, restaurant_id, customer_id, customer_name, session_state,
                kitchen_closed=kitchen_closed,
            )

    logger.warning(f"[delivery] schedule Flow unavailable for {customer_phone}")
    session_state["schedule_text_fallback"] = True
    await send_whatsapp_message(
        customer_phone,
        "We couldn't open the date picker. You can type your preferred date and time "
        "(e.g. *tomorrow 7:30 PM* or *18 Jun 7pm*).\n\n"
        "Or reply *Home* and choose *Schedule Delivery 📅* again.",
        restaurant_id,
    )
    session_state["booking_step"] = "awaiting_scheduled_flow"
    session_state["last_service_type"] = "delivery"
    session_state["service_type"] = "delivery"
    session_state["order_mode"] = "scheduled"
    return {"status": "awaiting_scheduled_flow"}


async def _prompt_delivery_schedule(
    customer_phone: str,
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Ask for delivery time when kitchen is closed or scheduling is enabled."""
    from tools.kitchen_hours import is_kitchen_open

    return await offer_delivery_schedule(
        customer_phone, restaurant_id, customer_id, customer_name, session_state,
        kitchen_closed=not is_kitchen_open(),
    )


async def _parse_delivery_schedule(message: str) -> datetime | None:
    """Parse flow picker, full datetime, or simple time (e.g. 11:30 AM)."""
    scheduled = parse_flow_datetime(message)
    if scheduled is not None:
        return scheduled
    scheduled = parse_booking_datetime(message.strip())
    if scheduled is not None:
        return scheduled
    return parse_scheduled_delivery_time(message)


async def _advance_after_delivery_time_set(
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
    scheduled: datetime | None,
) -> Dict[str, Any]:
    """Continue delivery flow once a delivery time (or NOW) is chosen."""
    session_state["scheduled_at"] = scheduled.isoformat() if scheduled else None

    if scheduled is not None:
        h = scheduled.hour % 12 or 12
        ampm = "PM" if scheduled.hour >= 12 else "AM"
        when = f"{scheduled.strftime('%d %b %Y')}, {h}:{scheduled.minute:02d} {ampm}"
        note = ""
        if session_state.get("scheduled_delivery_enabled"):
            note = _MANAGER_APPROVAL_NOTE
        await send_whatsapp_message(
            customer_phone,
            f"Got it — we'll deliver on *{when}*.{note}",
            restaurant_id,
        )

    if not session_state.get("delivery_address"):
        sent = await send_location_request(customer_phone, restaurant_id)
        if not sent:
            await send_whatsapp_message(
                customer_phone,
                "Great! Please *share your location pin* on WhatsApp (tap 📎 → Location) "
                "so we can calculate delivery charge accurately.\n"
                "You can also type your full address if needed.",
                restaurant_id,
            )
        session_state["booking_step"] = "awaiting_address"
        return {"status": "awaiting_address"}

    return await _proceed_to_delivery_menu(customer_phone, restaurant_id, session_state)


def _scheduled_delivery_label(session_state: Dict[str, Any]) -> str:
    raw = session_state.get("scheduled_at")
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
        h = dt.hour % 12 or 12
        ampm = "PM" if dt.hour >= 12 else "AM"
        return f"{dt.strftime('%d %b %Y')}, {h}:{dt.minute:02d} {ampm}"
    except (ValueError, TypeError):
        return str(raw)


async def _complete_scheduled_delivery_after_approval(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Send payment link and push an approved scheduled delivery to KDS."""
    cart = session_state.get("pending_cart") or session_state.get("cart") or {}
    order_text = (
        session_state.get("pending_order_text")
        or (cart_to_order_text(cart) if cart else "")
    )
    if not order_text:
        await send_whatsapp_message(
            customer_phone,
            "Sorry, we couldn't find your order details. Please contact the restaurant." + _HOME_HINT,
            restaurant_id,
        )
        return {"status": "error"}

    totals = session_state.get("order_totals") or {}
    total = float(session_state.get("order_total") or totals.get("grand_total") or 0)
    delivery_fee = float(totals.get("delivery_charge") or session_state.get("delivery_charge") or 0)
    token = session_state.get("display_token") or session_state.get("token_number") or "—"
    booking_id = session_state.get("booking_id")
    cart_snapshot = dict(cart)

    payment_line = await build_payment_line(
        booking_id or "", total, customer_name, customer_phone,
        f"Scheduled delivery {token}", session_state, service_type="delivery",
    ) if booking_id else "💳 Payment can be made on delivery."

    confirmation = (
        f"Your scheduled delivery is confirmed! 🎉\n────────────────────\n"
        f"Token: {token}\nOrder: {order_text}\n"
        f"────────────────────\n"
        f"{format_order_total_lines(totals, session_state=session_state)}\n\n{payment_line}"
    )
    sched_note = format_scheduled_note(session_state.get("scheduled_at"))
    if sched_note:
        confirmation += f"\n\n{sched_note}"
    timing_note = ready_time_note_from_session(session_state, "delivery")
    if timing_note:
        confirmation += f"\n\n{timing_note}"

    prepay_pending = prepay_fulfillment_required(session_state)
    if prepay_pending and booking_id:
        confirmation += f"\n\n{PREPAY_PENDING_FOOTER}"

    await send_whatsapp_message(customer_phone, confirmation, restaurant_id)
    session_state["_scheduled_payment_sent"] = True

    if prepay_pending and booking_id:
        await stash_and_persist_prepay_payload(
            session_state,
            booking_id,
            build_prepay_payload(
                service_type="delivery",
                session_state=session_state,
                restaurant_id=restaurant_id,
                customer_id=customer_id,
                customer_name=customer_name,
                customer_phone=customer_phone,
                booking_id=booking_id,
                token=str(token),
                cart_snapshot=cart_snapshot,
                order_text_display=order_text,
                total=total,
                totals=totals,
                booking_time=session_state.get("booking_time", now_display()),
                manager_phone=manager_phone,
                delivery_address=session_state.get("delivery_address"),
                delivery_fee=delivery_fee,
            ),
        )
        session_state["order_confirmed_summary"] = (
            f"Scheduled delivery *{token}* — {order_text[:40]} (₹{total:.0f}) — awaiting payment"
        )
        _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
        session_state["last_order_summary"] = _first_item
        session_state["is_returning_customer"] = True
        session_state["visit_count"] = session_state.get("visit_count", 0) + 1
        session_state["booking_step"] = "awaiting_prepay"
        clear_cart(session_state)
        return {"status": "awaiting_prepay", "booking_id": booking_id, "total": total}

    dist_note = ""
    if session_state.get("delivery_distance_km") is not None:
        dist_note = (
            f"Distance: {format_distance_label(float(session_state['delivery_distance_km']), session_state.get('delivery_distance_method'))}\n"
        )
    try:
        await send_whatsapp_message(
            manager_phone,
            f"🛵 Scheduled Delivery Approved — payment pending\n────────────────────\n"
            f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
            f"Address: {session_state.get('delivery_address')}\n{dist_note}"
            f"Order: {order_text}\nTotal: ₹{total:.0f}\n────────────────────",
            restaurant_id,
        )
    except Exception as _md:
        logger.warning(f"[delivery] manager post-approval notify failed (non-fatal): {_md}")

    session_state["order_confirmed_summary"] = (
        f"Scheduled delivery *{token}* — {order_text[:40]} (₹{total:.0f})"
    )
    _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
    session_state["last_order_summary"] = _first_item
    session_state["is_returning_customer"] = True
    session_state["visit_count"] = session_state.get("visit_count", 0) + 1
    session_state["booking_step"] = "visit_complete"
    clear_cart(session_state)

    hints = {k: session_state.get(k) for k in (
        "scheduled_at", "order_mode", "scheduled_kds_lead_minutes",
        "delivery_address", "delivery_distance_km", "delivery_distance_method",
    )}
    dispatched_now = await _finalize_kds_for_scheduled_order(
        booking_id=booking_id,
        restaurant_id=restaurant_id,
        customer_phone=customer_phone,
        customer_name=customer_name,
        token=str(token),
        order_text=order_text,
        cart=cart_snapshot,
        service_type="delivery",
        session_hints=hints,
        manager_phone=manager_phone,
        delivery_address=session_state.get("delivery_address", ""),
        booking_time=session_state.get("booking_time", now_display()),
        total=total,
    )

    if dispatched_now:
        try:
            await get_http().post(
                "https://api.autom8.works/api/feedback/queue",
                json={
                    "restaurant_id": restaurant_id,
                    "customer_phone": customer_phone,
                    "customer_name": customer_name,
                    "token_number": str(token),
                    "table_number": None,
                },
                headers={"Authorization": f"Bearer {KDS_SECRET}"},
                timeout=aiohttp.ClientTimeout(total=5),
            )
        except Exception as fb_err:
            logger.warning(f"[feedback-queue] Non-fatal: {fb_err}")

    if RECEIPT_AVAILABLE and booking_id:
        try:
            r_info = await fetch_restaurant_info(restaurant_id)
            receipt_data = _ReceiptData(
                restaurant_name=r_info.get("name", ""),
                restaurant_address=r_info.get("address", ""),
                restaurant_phone=r_info.get("phone", ""),
                restaurant_gstin=r_info.get("gstin", ""),
                restaurant_wa_number=r_info.get("whatsapp_number", ""),
                restaurant_website=r_info.get("website", ""),
                receipt_url=receipt_qr_url(str(token)),
                token_number=str(token),
                service_type="delivery",
                customer_name=customer_name,
                customer_phone=customer_phone,
                delivery_address=session_state.get("delivery_address", ""),
                items=_LineItem.from_cart(cart_snapshot),
                gst_rate=5.0,
                gst_inclusive=False,
                delivery_charge=totals.get("delivery_charge", delivery_fee),
                parcel_charge=totals.get("parcel_charge", 0),
                payment_mode=session_state.get("payment_mode", "Cash"),
            )
            receipt_path = _generate_receipt(receipt_data)
            asyncio.create_task(
                upload_and_send_receipt(receipt_path, customer_phone, restaurant_id, str(token))
            )
        except Exception as _re:
            logger.warning(f"[receipt] scheduled delivery receipt failed (non-fatal): {_re}")

    return {"status": "visit_complete", "booking_id": booking_id, "total": total}


async def _submit_scheduled_delivery_for_approval(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    session_state: Dict[str, Any],
    *,
    order_text: str,
    cart_snapshot: dict,
    totals: dict,
    total: float,
    delivery_fee: float,
    token: str,
    booking_id: str,
) -> Dict[str, Any]:
    """Hold payment until manager approves a scheduled delivery."""
    sched_label = _scheduled_delivery_label(session_state)
    portal_meta = {
        "booking_id": booking_id,
        "scheduled_at": session_state.get("scheduled_at"),
        "scheduled_at_label": sched_label,
        "delivery_address": session_state.get("delivery_address"),
        "order_text": order_text,
        "total": total,
        "totals": totals,
        "cart": cart_snapshot,
        "delivery_distance_km": session_state.get("delivery_distance_km"),
        "delivery_distance_method": session_state.get("delivery_distance_method"),
    }

    portal_token = await sync_scheduled_delivery_to_portal(
        customer_name, customer_phone, restaurant_id, portal_meta,
    )
    if portal_token:
        session_state["display_token"] = portal_token
        session_state["token_number"] = portal_token
    else:
        logger.error(
            f"[delivery] scheduled delivery portal token missing for {customer_phone} "
            f"(booking={booking_id}) — manager portal approval unavailable"
        )
        try:
            await send_whatsapp_message(
                manager_phone,
                f"⚠️ *Scheduled delivery needs portal setup*\n"
                f"Customer: {customer_name} ({customer_phone})\n"
                f"Order: {order_text[:120]}\n"
                f"Run migration add_scheduled_delivery_portal_and_kds.sql if approvals are missing.",
                restaurant_id,
            )
        except Exception as alert_err:
            logger.warning(f"[delivery] manager portal-failure alert failed: {alert_err}")
        await send_whatsapp_message(
            customer_phone,
            "We couldn't submit your scheduled delivery for manager approval right now. "
            "Please contact the restaurant directly, or reply *Home* to try again later."
            + _HOME_HINT,
            restaurant_id,
        )
        session_state["booking_step"] = "visit_complete"
        clear_cart(session_state)
        return {"status": "error", "reason": "portal_token_missing"}

    session_state["pending_order_text"] = order_text
    session_state["pending_cart"] = cart_snapshot
    session_state["booking_step"] = "awaiting_scheduled_delivery_approval"

    confirmation = (
        f"Your scheduled delivery request has been submitted! 📋\n────────────────────\n"
        f"Token: {session_state.get('token_number', token)}\n"
        f"Order: {order_text}\n"
        f"────────────────────\n"
        f"{format_order_total_lines(totals, session_state=session_state)}"
    )
    if sched_label:
        confirmation += f"\n\n🕐 Door delivery at: *{sched_label}*"
    confirmation += (
        "\n\n⏳ *Manager approval required* before payment.\n"
        "We'll message you as soon as your slot is confirmed — usually within a few minutes."
    )
    await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

    return {"status": "awaiting_scheduled_delivery_approval", "booking_id": booking_id}


async def _continue_after_address_validated(
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
    *,
    customer_id: str = "",
    customer_name: str = "Guest",
) -> Dict[str, Any]:
    """Route to calendar or catalog once address + distance checks pass."""
    from tools.feature_gate import ORDER_MODE_SCHEDULED

    mode = session_state.get("order_mode", "immediate")
    if mode == ORDER_MODE_SCHEDULED and not session_state.get("scheduled_at"):
        return await _prompt_delivery_schedule(
            customer_phone, restaurant_id, customer_id, customer_name, session_state,
        )

    return await _proceed_to_delivery_menu(customer_phone, restaurant_id, session_state)


async def _proceed_to_delivery_menu(
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Send catalog after scheduled time (and address) are collected."""
    intro = "Thank you! Browse today's menu below and add items to your basket 🛒"
    if session_state.get("scheduled_at") and session_state.get("scheduled_delivery_enabled"):
        intro = (
            "Thank you! Add items for your scheduled delivery below 🛒"
            + _MANAGER_APPROVAL_NOTE
        )
    elif session_state.get("scheduled_at"):
        intro = "Thank you! Add items for your scheduled delivery below 🛒"
    await send_whatsapp_message(customer_phone, intro, restaurant_id)
    clear_cart(session_state)
    session_state["booking_step"] = "awaiting_order"
    await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
    return {"status": session_state["booking_step"]}


async def handle_delivery_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    # ── awaiting_address ──────────────────────────────────────────────────────
    if booking_step == "awaiting_address":
        raw = message.strip()
        if raw.startswith("LOCATION:"):
            try:
                coords_part, label = raw[len("LOCATION:"):].split("|", 1)
                lat, lng = coords_part.split(",", 1)
                session_state["delivery_lat"] = float(lat.strip())
                session_state["delivery_lng"] = float(lng.strip())
                maps_link = f"https://maps.google.com/?q={lat.strip()},{lng.strip()}"
                delivery_address = f"{label.strip()} ({maps_link})"
            except Exception:
                delivery_address = raw
        else:
            delivery_address = raw

        session_state["delivery_address"] = delivery_address
        await cache_restaurant_pricing(session_state, restaurant_id)

        addr_result = await finalize_delivery_address(
            session_state,
            address_text=delivery_address if not raw.startswith("LOCATION:") else None,
        )
        if not addr_result.get("ok"):
            await send_whatsapp_message(customer_phone, addr_result.get("message", ""), restaurant_id)
            session_state["booking_step"] = "awaiting_address"
            return {"status": "awaiting_address"}

        if addr_result.get("message"):
            await send_whatsapp_message(customer_phone, addr_result["message"], restaurant_id)

        return await _continue_after_address_validated(
            customer_phone, restaurant_id, session_state,
            customer_id=customer_id, customer_name=customer_name,
        )

    # ── awaiting_scheduled_flow (calendar picker only — no text time) ─────────
    elif booking_step == "awaiting_scheduled_flow":
        scheduled = parse_flow_datetime(message)
        if scheduled is None and session_state.get("schedule_text_fallback"):
            scheduled = await _parse_delivery_schedule(message)

        if scheduled is not None:
            if scheduled <= datetime.now():
                await send_whatsapp_message(
                    customer_phone,
                    "That time has already passed. Please tap *Select Date & Time* "
                    "to pick a future slot on the calendar.",
                    restaurant_id,
                )
                return {"status": "awaiting_scheduled_flow"}
            return await _advance_after_delivery_time_set(
                customer_phone, restaurant_id, session_state, scheduled,
            )

        if not session_state.get("_schedule_flow_resend"):
            session_state["_schedule_flow_resend"] = True
            return await offer_delivery_schedule(
                customer_phone, restaurant_id, customer_id, customer_name, session_state,
            )

        await send_whatsapp_message(
            customer_phone,
            "Please tap *Select Date & Time* above to choose your delivery slot from the calendar.\n\n"
            "For immediate delivery, reply *Home* and choose *Deliver Now 🛵*.",
            restaurant_id,
        )
        return {"status": "awaiting_scheduled_flow"}

    # ── awaiting_scheduled_time (legacy sessions — redirect to calendar) ──────
    elif booking_step == "awaiting_scheduled_time":
        session_state["order_mode"] = "scheduled"
        return await offer_delivery_schedule(
            customer_phone, restaurant_id, customer_id, customer_name, session_state,
        )

    # ── awaiting_scheduled_delivery_approval ──────────────────────────────────
    elif booking_step == "awaiting_scheduled_delivery_approval":
        token = await get_scheduled_delivery_token(restaurant_id, customer_phone)
        if token and token.get("status") == "takeaway":
            meta = token.get("meta") or {}
            session_state["display_token"] = token.get("id") or session_state.get("token_number")
            session_state["token_number"] = session_state["display_token"]
            session_state["booking_id"] = meta.get("booking_id") or session_state.get("booking_id")
            session_state["scheduled_at"] = meta.get("scheduled_at") or session_state.get("scheduled_at")
            session_state["delivery_address"] = meta.get("delivery_address") or session_state.get("delivery_address")
            session_state["order_total"] = meta.get("total") or session_state.get("order_total")
            session_state["order_totals"] = meta.get("totals") or session_state.get("order_totals")
            session_state["pending_order_text"] = meta.get("order_text") or session_state.get("pending_order_text")
            session_state["pending_cart"] = meta.get("cart") or session_state.get("pending_cart")
            session_state["scheduled_delivery_approved"] = True
            session_state["booking_step"] = "awaiting_scheduled_delivery_payment"
            return await _complete_scheduled_delivery_after_approval(
                restaurant_id, customer_id, customer_name, customer_phone,
                manager_phone, session_state,
            )

        if token and token.get("status") == "completed":
            await send_whatsapp_message(
                customer_phone,
                "Your scheduled delivery request was not approved. "
                "Please try a different time or contact the restaurant." + _HOME_HINT,
                restaurant_id,
            )
            session_state["booking_step"] = "visit_complete"
            clear_cart(session_state)
            return {"status": "visit_complete"}

        await send_whatsapp_message(
            customer_phone,
            "⏳ Your scheduled delivery is with our manager for approval.\n\n"
            "We'll message you as soon as it's confirmed — no payment is needed until then."
            + _HOME_HINT,
            restaurant_id,
        )
        return {"status": "awaiting_scheduled_delivery_approval"}

    # ── awaiting_scheduled_delivery_payment ───────────────────────────────────
    elif booking_step == "awaiting_scheduled_delivery_payment":
        if session_state.get("scheduled_delivery_approved") or session_state.get("_scheduled_payment_sent"):
            if session_state.get("_scheduled_payment_sent"):
                await send_whatsapp_message(
                    customer_phone,
                    "Your payment link was sent above. Reply *Home* anytime for other options.",
                    restaurant_id,
                )
                return {"status": "visit_complete"}
            return await _complete_scheduled_delivery_after_approval(
                restaurant_id, customer_id, customer_name, customer_phone,
                manager_phone, session_state,
            )
        await send_whatsapp_message(
            customer_phone,
            "⏳ Your scheduled delivery is still awaiting manager approval.\n\n"
            "We'll message you as soon as it's confirmed — no payment needed until then."
            + _HOME_HINT,
            restaurant_id,
        )
        return {"status": "awaiting_scheduled_delivery_payment"}

    # ── awaiting_order ────────────────────────────────────────────────────────
    elif booking_step == "awaiting_order":
        order_text = message.strip()
        if order_text.upper() == "MENU":
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart = session_state.get("cart", {})

        if not cart and len(order_text) < 3:
            logger.info(f"[delivery] empty cart + short message '{order_text}' — re-sending catalog")
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        if cart:
            order_text = cart_to_order_text(cart)

        try:
            await cache_restaurant_pricing(session_state, restaurant_id)
            cart_snapshot = dict(cart)
            parcel_rate   = float(session_state.get("parcel_charge_per_item") or 0)

            ok, subtotal, minimum = check_min_order(cart, "delivery", session_state)
            if not ok:
                await send_whatsapp_message(
                    customer_phone,
                    f"Minimum order for delivery is ₹{minimum:.0f}. "
                    f"Your items total ₹{subtotal:.0f} — please add more to continue.",
                    restaurant_id,
                )
                await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
                return {"status": "awaiting_order"}

            delivery_fee  = resolve_delivery_charge(session_state)
            totals        = compute_order_totals(
                cart, "delivery",
                parcel_per_item=parcel_rate,
                delivery_charge=delivery_fee,
            )
            total         = totals["grand_total"]
            session_state["order_total"] = total
            session_state["order_totals"] = totals

            token, suggestion = await asyncio.gather(
                get_next_token_number(restaurant_id),
                safe_build_order_suggestion(customer_id, restaurant_id),
            )
            booking_time  = now_display()
            session_state["token_number"] = token

            booking = await create_booking(
                restaurant_id, customer_id, "delivery",
                delivery_address=session_state.get("delivery_address"),
                token_number=token,
                booking_datetime=session_state.get("scheduled_at"),
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            if _requires_scheduled_delivery_approval(session_state):
                return await _submit_scheduled_delivery_for_approval(
                    restaurant_id, customer_id, customer_name, customer_phone, manager_phone,
                    session_state,
                    order_text=order_text,
                    cart_snapshot=cart_snapshot,
                    totals=totals,
                    total=total,
                    delivery_fee=delivery_fee,
                    token=token,
                    booking_id=booking_id,
                )

            payment_line = await build_payment_line(
                booking_id, total, customer_name, customer_phone,
                f"Delivery {token}", session_state, service_type="delivery",
            )

            confirmation = (
                f"Your order has been placed! 🎉\n────────────────────\n"
                f"Token: {token}\nBooking Time: {booking_time}\nOrder: {order_text}\n"
                f"────────────────────\n"
                f"{format_order_total_lines(totals, session_state=session_state)}\n\n{payment_line}"
            )
            sched_note = format_scheduled_note(session_state.get("scheduled_at"))
            if sched_note:
                confirmation += f"\n\n{sched_note}"
            timing_note = ready_time_note_from_session(session_state, "delivery")
            if timing_note:
                confirmation += f"\n\n{timing_note}"
            if suggestion:
                confirmation += f"\n\n{suggestion}"
            prepay_pending = prepay_fulfillment_required(session_state)
            if prepay_pending:
                confirmation += f"\n\n{PREPAY_PENDING_FOOTER}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            if prepay_pending:
                await stash_and_persist_prepay_payload(
                    session_state,
                    booking_id,
                    build_prepay_payload(
                        service_type="delivery",
                        session_state=session_state,
                        restaurant_id=restaurant_id,
                        customer_id=customer_id,
                        customer_name=customer_name,
                        customer_phone=customer_phone,
                        booking_id=booking_id,
                        token=token,
                        cart_snapshot=cart_snapshot,
                        order_text_display=order_text,
                        total=total,
                        totals=totals,
                        booking_time=booking_time,
                        manager_phone=manager_phone,
                        delivery_address=session_state.get("delivery_address"),
                        delivery_fee=delivery_fee,
                    ),
                )
                session_state["order_confirmed_summary"] = (
                    f"Delivery Token *{token}* — {order_text} "
                    f"to {session_state.get('delivery_address', '')[:40]} (₹{total:.0f}) — awaiting payment"
                )
                _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
                session_state["last_order_summary"]    = _first_item
                session_state["is_returning_customer"] = True
                session_state["visit_count"]           = session_state.get("visit_count", 0) + 1
                session_state["booking_step"] = "awaiting_prepay"
                clear_cart(session_state)
                return {"status": "awaiting_prepay", "booking_id": booking_id, "total": total}

            dist_note = ""
            if session_state.get("delivery_distance_km") is not None:
                dist_note = (
                    f"Distance: {format_distance_label(float(session_state['delivery_distance_km']), session_state.get('delivery_distance_method'))}\n"
                )

            try:
                await send_whatsapp_message(
                    manager_phone,
                    f"🛵 *Deliver Now* (immediate)\n────────────────────\n"
                    f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                    f"Address: {session_state.get('delivery_address')}\n{dist_note}"
                    f"Booking Time: {booking_time}\n"
                    f"Order: {order_text}\n"
                    f"Delivery: ₹{totals.get('delivery_charge', delivery_fee):.0f}\n"
                    f"Total: ₹{total:.0f}\n"
                    f"────────────────────",
                    restaurant_id,
                )
            except Exception as _md:
                logger.warning(f"[delivery] manager order notify failed (non-fatal): {_md}")

            session_state["order_confirmed_summary"] = (
                f"Delivery Token *{token}* — {order_text} "
                f"to {session_state.get('delivery_address', '')[:40]} (₹{total:.0f})"
            )
            _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
            session_state["last_order_summary"]    = _first_item
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = session_state.get("visit_count", 0) + 1

            session_state["booking_step"] = "visit_complete"
            clear_cart(session_state)

            await notify_kds(
                customer_name=customer_name, customer_phone=customer_phone,
                order_text=order_text, cart=cart_snapshot, table_number=None,
                token_number=token, service_type="delivery",
                restaurant_id=restaurant_id,
            )

            try:
                await get_http().post(
                    "https://api.autom8.works/api/feedback/queue",
                    json={
                        "restaurant_id":  restaurant_id,
                        "customer_phone": customer_phone,
                        "customer_name":  customer_name,
                        "token_number":   token,
                        "table_number":   None,
                    },
                    headers={"Authorization": f"Bearer {KDS_SECRET}"},
                    timeout=aiohttp.ClientTimeout(total=5),
                )
            except Exception as fb_err:
                logger.warning(f"[feedback-queue] Non-fatal: {fb_err}")

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
                        receipt_url=receipt_qr_url(token),
                        token_number=token,
                        service_type="delivery",
                        customer_name=customer_name,
                        customer_phone=customer_phone,
                        delivery_address=session_state.get("delivery_address", ""),
                        items=_LineItem.from_cart(cart_snapshot),
                        gst_rate=5.0,
                        gst_inclusive=False,
                        delivery_charge=totals.get("delivery_charge", delivery_fee),
                        parcel_charge=totals.get("parcel_charge", 0),
                        payment_mode=session_state.get("payment_mode", "Cash"),
                    )
                    receipt_path = _generate_receipt(receipt_data)
                    logger.info(f"[receipt] Delivery receipt saved: {receipt_path}")
                    asyncio.create_task(
                        upload_and_send_receipt(receipt_path, customer_phone, restaurant_id, token)
                    )
                    await update_booking_status(booking_id, "confirmed")
                    logger.info(f"[receipt] Booking {booking_id} marked confirmed")
                except Exception as _re:
                    import traceback as _tb
                    logger.warning(f"[receipt] Generation failed (non-fatal): {_re}\n{_tb.format_exc()}")

            return {"status": "visit_complete", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create delivery booking: {e}")
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was an error processing your order. Please try again." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "error"}

    return await handle_unknown_booking_step(
        customer_phone, restaurant_id, session_state, flow_name="delivery", booking_step=booking_step,
    )
