"""
agents/customer/takeaway_flow.py
──────────────────────────────────
Takeaway booking flow extracted from booking_agent.py.

Fix 38 — awaiting_order: booking_step now transitions to visit_complete
          (was awaiting_payment). On the customer's next message (even the
          following day) their session is treated as a fresh visit rather
          than showing the stale "Place New Order" prompt. Feedback queue
          call added to match dine-in behaviour. Return status updated.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime
from typing import Dict, Any

import aiohttp

from tools.cart_tools import enrich_cart_titles
from tools.db_tools import (
    get_next_token_number,
    create_booking,
    update_booking_status,
    get_scheduled_takeaway_token,
    fetch_menu_timing_map,
    update_booking_schedule,
)
from tools.payment_tools import build_payment_line
from tools.prepay_fulfillment import (
    prepay_fulfillment_required,
    build_prepay_payload,
    stash_and_persist_prepay_payload,
    PREPAY_PENDING_FOOTER,
)
from tools.whatsapp_tools import send_whatsapp_message, send_whatsapp_flow
from tools.cart_tools import cart_to_order_text, clear_cart
from tools.order_pricing import (
    compute_order_totals,
    format_order_total_lines,
    check_min_order,
    format_pickup_location_block,
    format_scheduled_note,
    parse_scheduled_delivery_time,
)
from tools.order_timing import ready_time_note_from_session
from tools.booking_mechanisms import (
    RECEIPT_AVAILABLE,
    _generate_receipt,
    _ReceiptData,
    _LineItem,
    KDS_SECRET,
    get_http,
    notify_kds,
    sync_token_to_portal,
    fetch_restaurant_info,
    upload_and_send_receipt,
    receipt_qr_url,
    notify_manager_order_alert,
    assign_and_notify_captain_takeaway,
    cache_restaurant_pricing,
    sync_scheduled_takeaway_to_portal,
    _notify_manager_scheduled_takeaway,
)
from tools.slot_capacity import validate_scheduled_slot_with_capacity, format_slot_full_message
from tools.kitchen_scheduler import (
    compute_kitchen_start_at,
    cart_lines_from_snapshot,
    format_ist_label,
)
from tools.delivery_slots import (
    validate_scheduled_delivery_slot,
    format_slot_rejection_message,
    _format_slot_label,
)
from agents.customer.booking_helpers import (
    _HOME_HINT,
    now_display,
    send_catalog_with_fallback,
    strip_order_quantity,
    parse_booking_datetime,
    parse_flow_datetime,
    format_captain_pickup_line,
    handle_unknown_booking_step,
)
from agents.customer.conversation_helpers import safe_build_order_suggestion
from config.settings import settings
from tools.delivery_slots import build_flow_calendar_data, format_schedule_window_hint

logger = logging.getLogger(__name__)

_MANAGER_APPROVAL_NOTE = (
    "\n\n📋 *Scheduled takeaway needs manager approval before payment.* "
    "We'll message you once your slot is confirmed."
)


def _requires_scheduled_takeaway_approval(session_state: Dict[str, Any]) -> bool:
    """Calendar-scheduled takeaway needs manager approval before payment."""
    return bool(session_state.get("scheduled_at"))


def _scheduled_takeaway_label(session_state: Dict[str, Any]) -> str:
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


async def _reject_takeaway_schedule_resend_calendar(
    customer_phone: str,
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    session_state: Dict[str, Any],
    error_message: str,
) -> Dict[str, Any]:
    await send_whatsapp_message(
        customer_phone,
        f"{error_message}\n\nTap *Select Date & Time* below to pick another slot.",
        restaurant_id,
    )
    session_state.pop("scheduled_at", None)
    return await offer_takeaway_schedule(
        customer_phone, restaurant_id, customer_id, customer_name, session_state,
    )


async def _validate_takeaway_slot(
    restaurant_id: str,
    scheduled: datetime,
) -> tuple[datetime | None, str | None]:
    from zoneinfo import ZoneInfo

    if scheduled.tzinfo is None:
        scheduled = scheduled.replace(tzinfo=ZoneInfo("Asia/Kolkata"))

    rest = await fetch_restaurant_info(restaurant_id)
    max_orders = int(rest.get("scheduled_slot_max_orders") or 10)
    valid, reason, suggestion = await validate_scheduled_slot_with_capacity(
        restaurant_id, scheduled, max_orders,
    )
    if not valid:
        if reason == "full":
            label = _format_slot_label(scheduled)
            return None, format_slot_full_message(label, suggestion)
        return None, format_slot_rejection_message(reason, suggestion)
    return scheduled, None


async def _compute_and_persist_takeaway_schedule(
    restaurant_id: str,
    booking_id: str,
    session_state: Dict[str, Any],
    cart_snapshot: dict,
    order_text: str,
) -> dict[str, Any]:
    sched_raw = session_state.get("scheduled_at")
    if not sched_raw:
        raise ValueError("scheduled_at missing")

    rest = await fetch_restaurant_info(restaurant_id)
    menu_map = await fetch_menu_timing_map(restaurant_id)
    slot_dt = datetime.fromisoformat(str(sched_raw).replace("Z", "+00:00"))
    cart_lines = cart_lines_from_snapshot(cart_snapshot)

    schedule = compute_kitchen_start_at(
        slot_dt,
        service_type="takeaway",
        cart_lines=cart_lines,
        menu_by_retailer_id=menu_map,
        buffer_minutes=int(rest.get("schedule_buffer_minutes") or 15),
        rounding_minutes=int(rest.get("schedule_rounding_minutes") or 15),
        transit_minutes=0,
    )

    kitchen_start = schedule["kitchen_start_at"]
    slot_at = schedule["scheduled_slot_at"]
    schedule_meta = {
        "order_text": order_text,
        "cart": cart_snapshot,
        "kitchen_start_label": format_ist_label(kitchen_start),
        "scheduled_at_label": _scheduled_takeaway_label(session_state),
        "station_breakdown": schedule.get("station_breakdown") or {},
    }

    await update_booking_schedule(
        booking_id,
        kitchen_start_at=kitchen_start.isoformat(),
        scheduled_slot_at=slot_at.isoformat(),
        total_cook_minutes=schedule["total_cook_minutes"],
        total_packing_minutes=schedule["total_packing_minutes"],
        schedule_meta=schedule_meta,
    )

    session_state["kitchen_start_at"] = kitchen_start.isoformat()
    session_state["scheduled_slot_at"] = slot_at.isoformat()
    session_state["total_cook_minutes"] = schedule["total_cook_minutes"]
    return schedule


async def offer_takeaway_schedule(
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
        settings.meta_flow_takeaway_schedule_id
        or settings.meta_flow_delivery_schedule_id
        or settings.meta_flow_reservation_id
    )
    if flow_id and flow_id != "your_flow_id_here":
        flow_token = f"takeaway_{customer_id}_{int(time.time())}"
        session_state["flow_token"] = flow_token
        window_hint = ""
        try:
            window_hint = format_schedule_window_hint()
        except Exception:
            pass
        flow_calendar_data = build_flow_calendar_data()
        if closed:
            flow_body = (
                f"Hi {customer_name}! We're not taking immediate takeaway orders yet "
                f"— we open at *{next_open_label()}*.\n\n"
                f"Tap below to pick when you'd like to collect your order.{window_hint}"
            )
        else:
            flow_body = (
                f"Hi {customer_name}! Tap below to pick your pickup date and time."
                f"{window_hint}"
            )
        ok = await send_whatsapp_flow(
            phone=customer_phone,
            flow_id=flow_id,
            flow_token=flow_token,
            flow_cta="Select Date & Time",
            flow_header="🥡 Takeaway 📅",
            flow_body=flow_body,
            flow_footer="Calendar — pick date and time",
            restaurant_id=restaurant_id,
            flow_data=flow_calendar_data,
        )
        if ok:
            session_state["booking_step"] = "awaiting_takeaway_scheduled_flow"
            session_state["last_service_type"] = "takeaway"
            session_state["service_type"] = "takeaway"
            session_state["order_mode"] = "scheduled"
            session_state["schedule_flow_sent"] = True
            session_state.pop("schedule_text_fallback", None)
            return {"status": "awaiting_takeaway_scheduled_flow"}

        if not session_state.get("_schedule_flow_retry"):
            session_state["_schedule_flow_retry"] = True
            return await offer_takeaway_schedule(
                customer_phone, restaurant_id, customer_id, customer_name, session_state,
                kitchen_closed=kitchen_closed,
            )

    logger.warning(f"[takeaway] schedule Flow unavailable for {customer_phone}")
    session_state["schedule_text_fallback"] = True
    await send_whatsapp_message(
        customer_phone,
        "We couldn't open the date picker. You can type your preferred date and time "
        "(e.g. *tomorrow 7:30 PM* or *18 Jun 7pm*).\n\n"
        "Or reply *Home* and choose *Takeaway 📅* again.",
        restaurant_id,
    )
    session_state["booking_step"] = "awaiting_takeaway_scheduled_flow"
    session_state["last_service_type"] = "takeaway"
    session_state["service_type"] = "takeaway"
    session_state["order_mode"] = "scheduled"
    return {"status": "awaiting_takeaway_scheduled_flow"}


async def _parse_takeaway_schedule(message: str) -> datetime | None:
    scheduled = parse_flow_datetime(message)
    if scheduled is not None:
        return scheduled
    scheduled = parse_booking_datetime(message.strip())
    if scheduled is not None:
        return scheduled
    return parse_scheduled_delivery_time(message)


async def _advance_after_takeaway_time_set(
    customer_phone: str,
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    session_state: Dict[str, Any],
    scheduled: datetime | None,
) -> Dict[str, Any]:
    if scheduled is not None:
        normalized, err = await _validate_takeaway_slot(restaurant_id, scheduled)
        if err:
            return await _reject_takeaway_schedule_resend_calendar(
                customer_phone, restaurant_id, customer_id, customer_name,
                session_state, err,
            )
        scheduled = normalized
        session_state["scheduled_at"] = scheduled.isoformat()

        h = scheduled.hour % 12 or 12
        ampm = "PM" if scheduled.hour >= 12 else "AM"
        when = f"{scheduled.strftime('%d %b %Y')}, {h}:{scheduled.minute:02d} {ampm}"
        note = _MANAGER_APPROVAL_NOTE if session_state.get("scheduled_takeaway_enabled") else ""
        await send_whatsapp_message(
            customer_phone,
            f"Got it — we'll have your order ready for pickup on *{when}*.{note}",
            restaurant_id,
        )

    intro = "Browse today's menu below and add items to your basket 🛒"
    if scheduled is not None:
        intro = "Add items for your scheduled pickup below 🛒"
    await send_whatsapp_message(customer_phone, intro, restaurant_id)
    clear_cart(session_state)
    session_state["booking_step"] = "awaiting_order"
    await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
    return {"status": "awaiting_order"}


async def _complete_scheduled_takeaway_after_approval(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Send payment link after manager approves a scheduled takeaway."""
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
    token = session_state.get("display_token") or session_state.get("token_number") or "—"
    booking_id = session_state.get("booking_id")
    cart_snapshot = dict(cart)
    booking_time = session_state.get("booking_time", now_display())

    payment_line = await build_payment_line(
        booking_id or "", total, customer_name, customer_phone,
        f"Scheduled takeaway {token}", session_state, service_type="takeaway",
    ) if booking_id else "💳 Payment can be made at pickup."

    confirmation = (
        f"Your scheduled takeaway is confirmed! 🎉\n────────────────────\n"
        f"Token: {token}\nOrder: {order_text}\n"
        f"────────────────────\n"
        f"{format_order_total_lines(totals)}\n\n{payment_line}"
    )
    sched_label = _scheduled_takeaway_label(session_state)
    if sched_label:
        confirmation += f"\n\n🕐 Pickup at: *{sched_label}*"
    kitchen_label = session_state.get("kitchen_start_at_label")
    if kitchen_label:
        confirmation += f"\n👨‍🍳 Kitchen starts: *{kitchen_label}*"

    prepay_pending = prepay_fulfillment_required(session_state)
    if prepay_pending:
        confirmation += f"\n\n{PREPAY_PENDING_FOOTER}"

    await send_whatsapp_message(customer_phone, confirmation, restaurant_id)
    session_state["_scheduled_payment_sent"] = True

    if prepay_pending and booking_id:
        await stash_and_persist_prepay_payload(
            session_state,
            booking_id,
            build_prepay_payload(
                service_type="takeaway",
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
                booking_time=booking_time,
            ),
        )
        session_state["order_confirmed_summary"] = (
            f"Scheduled takeaway *{token}* — {order_text[:40]} (₹{total:.0f}) — awaiting payment"
        )
        _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
        session_state["last_order_summary"] = _first_item
        session_state["booking_step"] = "awaiting_prepay"
        clear_cart(session_state)
        return {"status": "awaiting_prepay", "booking_id": booking_id, "total": total}

    session_state["booking_step"] = "visit_complete"
    clear_cart(session_state)
    return {"status": "visit_complete", "booking_id": booking_id, "total": total}


async def _submit_scheduled_takeaway_for_approval(
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
    token: str,
    booking_id: str,
    booking_time: str,
) -> Dict[str, Any]:
    """Hold payment until manager approves a scheduled takeaway."""
    sched_raw = session_state.get("scheduled_at")
    if sched_raw:
        try:
            sched_dt = datetime.fromisoformat(str(sched_raw).replace("Z", "+00:00"))
            normalized, err = await _validate_takeaway_slot(restaurant_id, sched_dt)
            if err:
                return await _reject_takeaway_schedule_resend_calendar(
                    customer_phone, restaurant_id, customer_id, customer_name,
                    session_state, err,
                )
            session_state["scheduled_at"] = normalized.isoformat()
        except (ValueError, TypeError):
            pass

    try:
        schedule = await _compute_and_persist_takeaway_schedule(
            restaurant_id, booking_id, session_state, cart_snapshot, order_text,
        )
        kitchen_label = format_ist_label(schedule["kitchen_start_at"])
        session_state["kitchen_start_at_label"] = kitchen_label
    except Exception as exc:
        logger.error(f"[takeaway] schedule compute failed for {booking_id}: {exc}")

    sched_label = _scheduled_takeaway_label(session_state)
    session_state["scheduled_at_label"] = sched_label
    portal_meta = {
        "booking_id": booking_id,
        "scheduled_at": session_state.get("scheduled_at"),
        "scheduled_at_label": sched_label,
        "kitchen_start_at": session_state.get("kitchen_start_at"),
        "kitchen_start_at_label": session_state.get("kitchen_start_at_label"),
        "total_cook_minutes": session_state.get("total_cook_minutes"),
        "order_text": order_text,
        "total": total,
        "totals": totals,
        "cart": cart_snapshot,
    }

    portal_token = await sync_scheduled_takeaway_to_portal(
        customer_name, customer_phone, restaurant_id, portal_meta,
    )
    if portal_token:
        session_state["display_token"] = portal_token
        session_state["token_number"] = portal_token
        await _notify_manager_scheduled_takeaway(
            restaurant_id, portal_token, customer_name, customer_phone,
            portal_meta, manager_phone=manager_phone,
        )
    else:
        await send_whatsapp_message(
            customer_phone,
            "We couldn't submit your scheduled takeaway for manager approval right now. "
            "Please contact the restaurant directly, or reply *Home* to try again later."
            + _HOME_HINT,
            restaurant_id,
        )
        session_state["booking_step"] = "visit_complete"
        clear_cart(session_state)
        return {"status": "error", "reason": "portal_token_missing"}

    session_state["pending_order_text"] = order_text
    session_state["pending_cart"] = cart_snapshot
    session_state["booking_time"] = booking_time
    session_state["booking_step"] = "awaiting_scheduled_takeaway_approval"

    confirmation = (
        f"Your scheduled takeaway request has been submitted! 📋\n────────────────────\n"
        f"Token: {session_state.get('token_number', token)}\n"
        f"Order: {order_text}\n"
        f"────────────────────\n"
        f"{format_order_total_lines(totals)}"
    )
    if sched_label:
        confirmation += f"\n\n🕐 Pickup at: *{sched_label}*"
    if session_state.get("kitchen_start_at_label"):
        confirmation += f"\n👨‍🍳 Kitchen start: *{session_state['kitchen_start_at_label']}*"
    confirmation += (
        "\n\n⏳ *Manager approval required* before payment.\n"
        "We'll message you as soon as your slot is confirmed — usually within a few minutes."
    )
    await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

    return {"status": "awaiting_scheduled_takeaway_approval", "booking_id": booking_id}


async def handle_takeaway_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    # ── awaiting_takeaway_scheduled_flow (calendar picker only) ───────────────
    if booking_step == "awaiting_takeaway_scheduled_flow":
        scheduled = parse_flow_datetime(message)
        if scheduled is None and session_state.get("schedule_text_fallback"):
            scheduled = await _parse_takeaway_schedule(message)

        if scheduled is not None:
            if scheduled <= datetime.now():
                await send_whatsapp_message(
                    customer_phone,
                    "That time has already passed. Please tap *Select Date & Time* "
                    "to pick a future slot on the calendar.",
                    restaurant_id,
                )
                return {"status": "awaiting_takeaway_scheduled_flow"}
            return await _advance_after_takeaway_time_set(
                customer_phone, restaurant_id, customer_id, customer_name, session_state, scheduled,
            )

        if not session_state.get("_schedule_flow_resend"):
            session_state["_schedule_flow_resend"] = True
            return await offer_takeaway_schedule(
                customer_phone, restaurant_id, customer_id, customer_name, session_state,
            )

        await send_whatsapp_message(
            customer_phone,
            "Please tap *Select Date & Time* above to choose your pickup slot from the calendar.\n\n"
            "For immediate pickup, reply *Home* and choose *Takeaway Now 🛍️*.",
            restaurant_id,
        )
        return {"status": "awaiting_takeaway_scheduled_flow"}

    # ── awaiting_takeaway_scheduled_time (legacy — redirect to calendar) ───────
    elif booking_step == "awaiting_takeaway_scheduled_time":
        session_state["order_mode"] = "scheduled"
        return await offer_takeaway_schedule(
            customer_phone, restaurant_id, customer_id, customer_name, session_state,
        )

    # ── awaiting_scheduled_takeaway_approval ──────────────────────────────────
    elif booking_step == "awaiting_scheduled_takeaway_approval":
        token = await get_scheduled_takeaway_token(restaurant_id, customer_phone)
        if token and token.get("status") == "takeaway":
            session_state["scheduled_takeaway_approved"] = True
            session_state["display_token"] = token.get("id") or session_state.get("display_token")
            session_state["token_number"] = session_state["display_token"]
            session_state["booking_step"] = "awaiting_scheduled_takeaway_payment"
            return await _complete_scheduled_takeaway_after_approval(
                restaurant_id, customer_id, customer_name, customer_phone, session_state,
            )
        if token and token.get("status") == "completed":
            await send_whatsapp_message(
                customer_phone,
                "Sorry, we couldn't confirm your scheduled takeaway slot. "
                "Please pick another time or reply *Home* to start over." + _HOME_HINT,
                restaurant_id,
            )
            session_state["booking_step"] = "visit_complete"
            clear_cart(session_state)
            return {"status": "rejected"}
        return {"status": "awaiting_scheduled_takeaway_approval"}

    # ── awaiting_scheduled_takeaway_payment ───────────────────────────────────
    elif booking_step == "awaiting_scheduled_takeaway_payment":
        if session_state.get("scheduled_takeaway_approved") or session_state.get("_scheduled_payment_sent"):
            return await _complete_scheduled_takeaway_after_approval(
                restaurant_id, customer_id, customer_name, customer_phone, session_state,
            )
        return {"status": "awaiting_scheduled_takeaway_payment"}

    elif booking_step == "awaiting_order":
        order_text = message.strip()
        if order_text.upper() == "MENU":
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart = session_state.get("cart", {})

        if not cart and len(order_text) < 3:
            logger.info(f"[takeaway] empty cart + short message '{order_text}' — re-sending catalog")
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        try:
            await cache_restaurant_pricing(session_state, restaurant_id)
            cart_snapshot = dict(cart)
            parcel_rate   = float(session_state.get("parcel_charge_per_item") or 0)

            ok, subtotal, minimum = check_min_order(cart, "takeaway", session_state)
            if not ok:
                await send_whatsapp_message(
                    customer_phone,
                    f"Minimum order for takeaway is ₹{minimum:.0f}. "
                    f"Your items total ₹{subtotal:.0f} — please add more to continue.",
                    restaurant_id,
                )
                await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
                return {"status": "awaiting_order"}

            totals        = compute_order_totals(cart, "takeaway", parcel_per_item=parcel_rate)
            total         = totals["grand_total"]
            session_state["order_total"] = total
            session_state["order_totals"] = totals

            token, suggestion = await asyncio.gather(
                get_next_token_number(restaurant_id),
                safe_build_order_suggestion(customer_id, restaurant_id),
            )
            booking_time  = now_display()
            session_state["token_number"] = token

            booking    = await create_booking(
                restaurant_id, customer_id, "takeaway", token_number=token,
                booking_datetime=session_state.get("scheduled_at"),
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            order_text_display = cart_to_order_text(cart) if cart else order_text

            if _requires_scheduled_takeaway_approval(session_state):
                return await _submit_scheduled_takeaway_for_approval(
                    restaurant_id, customer_id, customer_name, customer_phone, manager_phone,
                    session_state,
                    order_text=order_text_display,
                    cart_snapshot=cart_snapshot,
                    totals=totals,
                    total=total,
                    token=token,
                    booking_id=booking_id,
                    booking_time=booking_time,
                )

            payment_line = await build_payment_line(
                booking_id, total, customer_name, customer_phone,
                f"Takeaway {token}", session_state, service_type="takeaway",
            )

            prepay_pending = prepay_fulfillment_required(session_state)

            portal_token_id = None
            if not prepay_pending:
                portal_token_id = await sync_token_to_portal(
                    customer_name=customer_name, customer_phone=customer_phone,
                    token_type="takeaway", pax=1, restaurant_id=restaurant_id,
                )
            display_token = portal_token_id or token
            session_state["display_token"] = display_token

            if prepay_pending:
                await stash_and_persist_prepay_payload(
                    session_state,
                    booking_id,
                    build_prepay_payload(
                        service_type="takeaway",
                        session_state=session_state,
                        restaurant_id=restaurant_id,
                        customer_id=customer_id,
                        customer_name=customer_name,
                        customer_phone=customer_phone,
                        booking_id=booking_id,
                        token=token,
                        cart_snapshot=cart_snapshot,
                        order_text_display=order_text_display,
                        total=total,
                        totals=totals,
                        booking_time=booking_time,
                    ),
                )
                confirmation = (
                    f"Order received! 🛍️\n────────────────────\n"
                    f"Token: {display_token}\nBooking Time: {booking_time}\n"
                    f"Order: {order_text_display}\n────────────────────\n"
                    f"{format_order_total_lines(totals)}\n\n{payment_line}\n\n"
                    f"{PREPAY_PENDING_FOOTER}"
                )
                pickup_block = format_pickup_location_block(session_state)
                if pickup_block:
                    confirmation += f"\n\n{pickup_block}"
                sched_note = format_scheduled_note(session_state.get("scheduled_at"))
                if sched_note:
                    confirmation += f"\n\n{sched_note}"
                timing_note = ready_time_note_from_session(session_state, "takeaway")
                if timing_note:
                    confirmation += f"\n\n{timing_note}"
                if suggestion:
                    confirmation += f"\n\n{suggestion}"
                await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

                session_state["last_service_type"] = "takeaway"
                session_state["order_confirmed_summary"] = (
                    f"Takeaway Token *{display_token}* — {order_text_display} (₹{total:.0f}) — awaiting payment"
                )
                _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
                session_state["last_order_summary"]    = _first_item
                session_state["booking_step"] = "awaiting_prepay"
                clear_cart(session_state)
                return {"status": "awaiting_prepay", "booking_id": booking_id, "total": total}

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

            confirmation = (
                f"Order confirmed! ✅\n────────────────────\n"
                f"Token: {display_token}\nBooking Time: {booking_time}\n"
                f"Order: {order_text_display}\n────────────────────\n"
                f"{format_order_total_lines(totals)}\n\n{payment_line}{captain_line}"
            )
            pickup_block = format_pickup_location_block(session_state)
            if pickup_block:
                confirmation += f"\n\n{pickup_block}"
            sched_note = format_scheduled_note(session_state.get("scheduled_at"))
            if sched_note:
                confirmation += f"\n\n{sched_note}"
            timing_note = ready_time_note_from_session(session_state, "takeaway")
            if timing_note:
                confirmation += f"\n\n{timing_note}"
            if suggestion:
                confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            # Manager order alert via Node API (same WA path as walk-in)
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
            except Exception as _ma:
                logger.warning(f"[takeaway] manager order alert failed (non-fatal): {_ma}")

            if captain_result and captain_result.get("captain_name"):
                session_state["assigned_captain"] = captain_result["captain_name"]
            session_state["last_service_type"] = "takeaway"

            session_state["order_confirmed_summary"] = (
                f"Takeaway Token *{display_token}* — {order_text_display} (₹{total:.0f})"
            )
            _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
            session_state["last_order_summary"]    = _first_item
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = session_state.get("visit_count", 0) + 1

            # Fix 38: transition to visit_complete so next-day "Hi" starts fresh
            session_state["booking_step"] = "visit_complete"
            clear_cart(session_state)

            if cart_snapshot:
                await enrich_cart_titles(cart_snapshot, restaurant_id)

            kds_order_id = await notify_kds(
                customer_name=customer_name, customer_phone=customer_phone,
                order_text=order_text_display, cart=cart_snapshot, table_number=None,
                token_number=display_token, service_type="takeaway",
                restaurant_id=restaurant_id,
            )
            if not kds_order_id:
                logger.error(
                    f"[takeaway] KDS dispatch failed for token {display_token} "
                    f"(cart_lines={len(cart_snapshot or {})})"
                )

            # Fix 38: feedback queue — mirrors dine-in behaviour
            try:
                await get_http().post(
                    "https://api.autom8.works/api/feedback/queue",
                    json={
                        "restaurant_id":  restaurant_id,
                        "customer_phone": customer_phone,
                        "customer_name":  customer_name,
                        "token_number":   display_token,
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
                        receipt_url=receipt_qr_url(display_token),
                        token_number=display_token,
                        service_type="takeaway",
                        customer_name=customer_name,
                        customer_phone=customer_phone,
                        items=_LineItem.from_cart(cart_snapshot),
                        gst_rate=5.0,
                        gst_inclusive=False,
                        parcel_charge=totals.get("parcel_charge", 0),
                        payment_mode=session_state.get("payment_mode", "Cash"),
                    )
                    receipt_path = _generate_receipt(receipt_data)
                    logger.info(f"[receipt] Takeaway receipt saved: {receipt_path}")
                    asyncio.create_task(
                        upload_and_send_receipt(receipt_path, customer_phone, restaurant_id, display_token)
                    )
                    await update_booking_status(booking_id, "confirmed")
                    logger.info(f"[receipt] Booking {booking_id} marked confirmed")
                except Exception as _re:
                    import traceback as _tb
                    logger.warning(f"[receipt] Generation failed (non-fatal): {_re}\n{_tb.format_exc()}")

            return {"status": "visit_complete", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create takeaway booking: {e}")
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was an error processing your order. Please try again." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "error"}

    return await handle_unknown_booking_step(
        customer_phone, restaurant_id, session_state, flow_name="takeaway", booking_step=booking_step,
    )
