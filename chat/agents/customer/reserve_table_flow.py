"""
agents/customer/reserve_table_flow.py
───────────────────────────────────────
Reserve-table booking flow extracted from booking_agent.py.

Note: handle_booking_completion (post-booking hook) remains in booking_agent.py.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Dict, Any

from tools.db_tools import get_next_token_number, create_booking, update_booking_status
from tools.payment_tools import create_payment_link
from tools.prepay_fulfillment import (
    build_prepay_payload,
    stash_prepay_payload,
    PREPAY_PENDING_FOOTER,
    RESERVE_PREPAY_FOOTER,
)
from tools.whatsapp_tools import send_whatsapp_message
from tools.cart_tools import _send_interactive
from tools.booking_mechanisms import (
    RECEIPT_AVAILABLE,
    _generate_receipt,
    _ReceiptData,
    sync_token_to_portal,
    fetch_restaurant_info,
)
from agents.customer.booking_helpers import (
    _HOME_HINT,
    now_display,
    is_placeholder_payment_link,
    parse_flow_datetime,
    offer_whatsapp_schedule_calendar,
)
from agents.customer.conversation_intelligence import is_affirmative as _is_affirmative
from config.settings import settings

logger = logging.getLogger(__name__)


async def _offer_reserve_calendar(
    customer_phone: str,
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    party_size = session_state.get("party_size", "")
    flow_id = settings.meta_flow_reservation_id
    return await offer_whatsapp_schedule_calendar(
        customer_phone,
        restaurant_id,
        customer_id,
        session_state,
        flow_id=flow_id or "",
        flow_token_prefix="reserve",
        flow_header="📅 Reserve a Table",
        flow_body=(
            f"Hi {customer_name}! Tap below to pick your reservation date and time "
            f"for your party of {party_size} guests."
        ),
        booking_step="awaiting_flow_datetime",
        failure_message=(
            "We couldn't open the date picker. Please reply *Home* and choose "
            "*Reserve a Table 📅* again, or contact the restaurant for help."
        ),
        resend_fn=lambda: _offer_reserve_calendar(
            customer_phone, restaurant_id, customer_id, customer_name, session_state,
        ),
    )


async def handle_reserve_table_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    # ── awaiting_party_size ───────────────────────────────────────────────────
    if booking_step == "awaiting_party_size":
        from agents.customer.booking_helpers import parse_party_size
        try:
            party_size = parse_party_size(message)
            session_state["party_size"] = party_size
            return await _offer_reserve_calendar(
                customer_phone, restaurant_id, customer_id, customer_name, session_state,
            )
        except ValueError:
            await send_whatsapp_message(
                customer_phone, "Please enter a valid number of people (e.g. 4)." + _HOME_HINT, restaurant_id
            )
            return {"status": "error"}

    # ── awaiting_datetime (legacy — redirect to calendar) ─────────────────────
    elif booking_step == "awaiting_datetime":
        return await _offer_reserve_calendar(
            customer_phone, restaurant_id, customer_id, customer_name, session_state,
        )

    # ── awaiting_flow_datetime (calendar picker only — no text input) ─────────
    elif booking_step == "awaiting_flow_datetime":
        parsed_dt = parse_flow_datetime(message)

        if parsed_dt is None:
            if not session_state.get("_schedule_flow_resend"):
                session_state["_schedule_flow_resend"] = True
                return await _offer_reserve_calendar(
                    customer_phone, restaurant_id, customer_id, customer_name, session_state,
                )
            await send_whatsapp_message(
                customer_phone,
                "Please tap *Select Date & Time* above to choose your reservation slot "
                "from the calendar." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "awaiting_flow_datetime"}

        if parsed_dt <= datetime.now():
            await send_whatsapp_message(
                customer_phone,
                "That time has already passed. Please tap *Select Date & Time* "
                "to pick a future slot on the calendar.",
                restaurant_id,
            )
            return {"status": "awaiting_flow_datetime"}

        advance_amount = 150.0
        formatted_dt   = parsed_dt.strftime("%d %b %Y, %I:%M %p")
        session_state["booking_datetime"] = parsed_dt.isoformat()
        session_state["advance_amount"]   = advance_amount
        session_state["booking_step"]     = "awaiting_advance_confirmation"
        session_state.pop("_schedule_flow_resend", None)

        ok = await _send_interactive(customer_phone, {
            "interactive": {
                "type": "button",
                "body": {"text": (
                    f"Great choice! Here's your reservation summary:\n────────────────────\n"
                    f"Name: {customer_name}\nDate & Time: {formatted_dt}\n"
                    f"Guests: {session_state.get('party_size')}\n────────────────────\n\n"
                    f"A token advance of ₹{advance_amount:.0f} is required to confirm your table. "
                    f"This amount will be adjusted during your visit."
                )},
                "footer": {"text": "Tap to confirm or cancel"},
                "action": {"buttons": [
                    {"type": "reply", "reply": {"id": "YES", "title": "✅ Yes, confirm"}},
                    {"type": "reply", "reply": {"id": "NO",  "title": "❌ Cancel"}},
                ]},
            }
        })
        if not ok:
            await send_whatsapp_message(
                customer_phone,
                f"Great choice! Here's your reservation summary:\n────────────────────\n"
                f"Name: {customer_name}\nDate & Time: {formatted_dt}\n"
                f"Guests: {session_state.get('party_size')}\n────────────────────\n\n"
                f"A token advance of ₹{advance_amount:.0f} is required to confirm your table.\n\n"
                f"Reply *YES* to proceed with payment, or *NO* to cancel.",
                restaurant_id,
            )
        return {"status": "awaiting_advance_confirmation"}

    # ── awaiting_advance_confirmation ─────────────────────────────────────────
    elif booking_step == "awaiting_advance_confirmation":
        reply = message.strip()

        if reply.upper() in ("NO", "CANCEL"):
            await send_whatsapp_message(
                customer_phone,
                "No problem! Your reservation has been cancelled. "
                "Feel free to message us anytime to book again. 😊",
                restaurant_id,
            )
            session_state.clear()
            return {"status": "cancelled"}

        if not _is_affirmative(reply):
            await send_whatsapp_message(
                customer_phone,
                "Please tap *Yes, confirm* to proceed or *Cancel* to cancel." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "error"}

        token                = await get_next_token_number(restaurant_id)
        booking_time         = now_display()
        advance_amount       = session_state.get("advance_amount", 150.0)
        party_size           = session_state.get("party_size")
        booking_datetime_iso = session_state.get("booking_datetime", "")
        session_state["token_number"] = token

        try:
            booking = await create_booking(
                restaurant_id, customer_id, "reserve_table",
                party_size=party_size, booking_datetime=booking_datetime_iso,
                token_number=token,
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            try:
                payment_link = await create_payment_link(
                    booking_id, advance_amount, customer_name,
                    f"Reservation {token} for {party_size} people",
                    customer_phone=customer_phone,
                )
            except Exception as _pl:
                logger.warning(f"[payment] create_payment_link failed (non-fatal): {_pl}")
                payment_link = "placeholder"

            try:
                display_dt = datetime.fromisoformat(booking_datetime_iso).strftime("%d %b %Y, %I:%M %p")
            except Exception:
                display_dt = booking_datetime_iso

            if is_placeholder_payment_link(payment_link):
                await sync_token_to_portal(
                    customer_name=customer_name, customer_phone=customer_phone,
                    token_type="dinein", pax=party_size or 1, restaurant_id=restaurant_id,
                )
                payment_line = (
                    f"💳 Please pay the advance of ₹{advance_amount:.0f} at the counter when you arrive.\n"
                    f"Your table is provisionally held."
                )
                summary = (
                    f"Reservation confirmed! 🎉\n────────────────────\n"
                    f"Token: {token}\nBooking Time: {booking_time}\n"
                    f"Date & Time: {display_dt}\nGuests: {party_size}\n"
                    f"Advance: ₹{advance_amount:.0f}\n────────────────────\n\n"
                    f"{payment_line}\n\nJust tell our staff your token *{token}* when you arrive!"
                )
                await send_whatsapp_message(customer_phone, summary, restaurant_id)

                if RECEIPT_AVAILABLE:
                    try:
                        r_info = await fetch_restaurant_info(restaurant_id)
                        receipt_data = _ReceiptData(
                            restaurant_name=r_info.get("name", ""),
                            restaurant_wa_number=r_info.get("whatsapp_number", ""),
                            token_number=token,
                            table_number="",
                            service_type="reserve_table",
                            customer_name=customer_name,
                            customer_phone=customer_phone,
                            items=[],
                            gst_rate=0.0,
                            payment_mode=session_state.get("payment_mode", "Cash"),
                            footer_message=f"Reservation for {display_dt} — {party_size} guests 😊",
                        )
                        receipt_path = _generate_receipt(receipt_data)
                        logger.info(f"[receipt] Reservation receipt saved: {receipt_path}")
                        await update_booking_status(booking_id, "confirmed")
                        logger.info(f"[receipt] Booking {booking_id} marked confirmed")
                    except Exception as _re:
                        import traceback as _tb
                        logger.warning(f"[receipt] Generation failed (non-fatal): {_re}\n{_tb.format_exc()}")

                session_state["order_confirmed_summary"] = (
                    f"Table Reservation Token *{token}* — {display_dt} "
                    f"for {party_size} guests (advance ₹{advance_amount:.0f})"
                )
                session_state["booking_step"] = "awaiting_payment"
                return {"status": "awaiting_payment", "booking_id": booking_id, "total": advance_amount}

            session_state["payment_link"] = payment_link
            stash_prepay_payload(
                session_state,
                booking_id,
                build_prepay_payload(
                    service_type="reserve_table",
                    session_state=session_state,
                    restaurant_id=restaurant_id,
                    customer_id=customer_id,
                    customer_name=customer_name,
                    customer_phone=customer_phone,
                    booking_id=booking_id,
                    token=token,
                    total=advance_amount,
                    booking_time=booking_time,
                    party_size=party_size,
                    advance_amount=advance_amount,
                    booking_datetime_iso=booking_datetime_iso,
                    display_dt=display_dt,
                ),
            )
            payment_line = f"Please complete payment to secure your table:\n{payment_link}"
            summary = (
                f"Reservation received! 📅\n────────────────────\n"
                f"Token: {token}\nBooking Time: {booking_time}\n"
                f"Date & Time: {display_dt}\nGuests: {party_size}\n"
                f"Advance: ₹{advance_amount:.0f}\n────────────────────\n\n"
                f"{payment_line}\n\n{RESERVE_PREPAY_FOOTER}"
            )
            await send_whatsapp_message(customer_phone, summary, restaurant_id)

            session_state["order_confirmed_summary"] = (
                f"Table Reservation Token *{token}* — {display_dt} "
                f"for {party_size} guests (advance ₹{advance_amount:.0f}) — awaiting payment"
            )
            session_state["booking_step"] = "awaiting_prepay"
            return {"status": "awaiting_prepay", "booking_id": booking_id, "total": advance_amount}

        except Exception as e:
            logger.error(f"Failed to create reservation: {e}")
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was an error creating your reservation. Please try again." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "error"}

    return {"status": "error"}
