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
from tools.db_tools import get_next_token_number, create_booking, update_booking_status
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
    session_state: Dict[str, Any],
    scheduled: datetime | None,
) -> Dict[str, Any]:
    session_state["scheduled_at"] = scheduled.isoformat() if scheduled else None

    if scheduled is not None:
        h = scheduled.hour % 12 or 12
        ampm = "PM" if scheduled.hour >= 12 else "AM"
        when = f"{scheduled.strftime('%d %b %Y')}, {h}:{scheduled.minute:02d} {ampm}"
        await send_whatsapp_message(
            customer_phone,
            f"Got it — we'll have your order ready for pickup on *{when}*.",
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
                customer_phone, restaurant_id, session_state, scheduled,
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

            payment_line = await build_payment_line(
                booking_id, total, customer_name, customer_phone,
                f"Takeaway {token}", session_state, service_type="takeaway",
            )

            order_text_display = cart_to_order_text(cart) if cart else order_text
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
