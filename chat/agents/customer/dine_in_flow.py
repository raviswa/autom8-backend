"""
agents/customer/dine_in_flow.py
─────────────────────────────────
Dine-in booking flow extracted from booking_agent.py.

Fix 41 — awaiting_order: empty-cart guard added (mirrors Fix 31 for
          takeaway/delivery). Prevents a ₹0 booking when a short/empty
          catalog payload arrives before the cart is populated.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Dict, Any

from tools.db_tools import (
    get_next_token_number,
    create_booking,
    update_booking_status,
)
from tools.payment_tools import create_payment_link
from tools.whatsapp_tools import send_whatsapp_message
from tools.cart_tools import (
    cart_to_order_text,
    cart_total,
    clear_cart,
    _send_interactive,
)
from tools.booking_mechanisms import (
    RECEIPT_AVAILABLE,
    _generate_receipt,
    _ReceiptData,
    _LineItem,
    KDS_SECRET,
    get_http,
    notify_kds,
    sync_token_to_portal,
    sync_token_to_portal_large_party,
    lookup_table_assignment,
    check_large_party_seating,
    format_combo_message,
    fetch_restaurant_info,
    upload_and_send_receipt,
    receipt_qr_url,
    AUTOM8_KDS_URL,
)
from agents.customer.booking_helpers import (
    MANAGER_PORTAL_URL,
    LARGE_PARTY_THRESHOLD,
    _HOME_HINT,
    now_display,
    is_greeting,
    is_placeholder_payment_link,
    build_notes_hint,
    send_catalog_with_fallback,
    start_special_notes_timer,
    stop_special_notes_timer,
)
from agents.customer.conversation_helpers import safe_build_order_suggestion

import aiohttp

logger = logging.getLogger(__name__)


async def handle_dine_in_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any], table_number: int | None = None,
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    # ── awaiting_party_size ───────────────────────────────────────────────────
    if booking_step == "awaiting_party_size":
        from agents.customer.booking_helpers import parse_party_size
        try:
            party_size = parse_party_size(message)
            session_state["party_size"] = party_size

            if party_size > LARGE_PARTY_THRESHOLD:
                result = await check_large_party_seating(party_size, restaurant_id)

                if not result["can_seat"]:
                    avail = result["total_available"]
                    ok = await _send_interactive(customer_phone, {
                        "interactive": {
                            "type": "button",
                            "body": {"text": (
                                f"😔 We're sorry — we currently only have "
                                f"*{avail} seat{'s' if avail != 1 else ''}* available "
                                f"across all our tables, which isn't enough for "
                                f"your party of *{party_size}*.\n\n"
                                f"We'd love to host you! Would you like to:\n"
                                f"• *Reserve* a table for a future date\n"
                                f"• Come with a smaller group today"
                            )},
                            "action": {"buttons": [
                                {"type": "reply", "reply": {"id": "RESERVE", "title": "📅 Reserve for later"}},
                                {"type": "reply", "reply": {"id": "SMALLER", "title": "👥 Change party size"}},
                            ]},
                        }
                    })
                    if not ok:
                        await send_whatsapp_message(
                            customer_phone,
                            f"😔 Sorry, we only have {avail} seats available — not enough for {party_size}.\n\n"
                            f"Reply *RESERVE* to book for a future date, or *SMALLER* to change your group size.",
                            restaurant_id,
                        )
                    session_state["booking_step"] = "awaiting_large_party_response"
                    return {"status": "awaiting_large_party_response"}

                elif len(result["combination"]) > 1:
                    combo_msg = format_combo_message(result["combination"], party_size)
                    ok = await _send_interactive(customer_phone, {
                        "interactive": {
                            "type": "button",
                            "body": {"text": combo_msg},
                            "action": {"buttons": [
                                {"type": "reply", "reply": {"id": "YES",     "title": "✅ Confirm"}},
                                {"type": "reply", "reply": {"id": "RESERVE", "title": "📅 Reserve instead"}},
                                {"type": "reply", "reply": {"id": "SMALLER", "title": "👥 Change size"}},
                            ]},
                        }
                    })
                    if not ok:
                        await send_whatsapp_message(
                            customer_phone,
                            f"{combo_msg}\n\nReply *YES* to confirm, *RESERVE* to book for a future date, "
                            f"or *SMALLER* to change your group size.",
                            restaurant_id,
                        )
                    session_state["_pending_combo"] = result["combination"]
                    session_state["booking_step"]   = "awaiting_large_party_response"
                    return {"status": "awaiting_large_party_response"}

            token        = await get_next_token_number(restaurant_id)
            booking_time = now_display()
            session_state["token_number"] = token

            portal_token_id = await sync_token_to_portal(
                customer_name=customer_name, customer_phone=customer_phone,
                token_type="dinein", pax=party_size, restaurant_id=restaurant_id,
            )
            display_token = portal_token_id or token
            session_state["display_token"] = display_token

            await send_whatsapp_message(
                manager_phone,
                f"🪑 *New Walk-in* — Token *{display_token}*\n"
                f"👤 {customer_name}, {party_size} {'person' if party_size == 1 else 'people'}\n"
                f"🍽️ Dine-in\n🕐 {booking_time}\n\n"
                f"Open portal to assign table:\n{MANAGER_PORTAL_URL}",
                restaurant_id,
            )
            await send_whatsapp_message(
                customer_phone,
                f"You're all checked in! 🍽️\n\n"
                f"*Token: {display_token}*\n\n"
                f"We're assigning your table now — usually takes just a minute or two. "
                f"You'll get a WhatsApp message the moment it's confirmed.\n\n"
                f"While you wait, feel free to browse the menu using the 🛍️ Shop icon at the top of this chat. 😊",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_table_assignment"
            return {"status": "awaiting_table_assignment"}

        except ValueError:
            await send_whatsapp_message(
                customer_phone, "Please enter a valid number of people (e.g. 2)." + _HOME_HINT, restaurant_id
            )
            return {"status": "error"}

    # ── awaiting_large_party_response ─────────────────────────────────────────
    elif booking_step == "awaiting_large_party_response":
        reply = message.strip().upper()

        if reply == "RESERVE":
            session_state["service_type"] = "reserve_table"
            session_state["booking_step"] = "awaiting_datetime"
            await send_whatsapp_message(
                customer_phone,
                f"Great! Let's reserve a table for your party of *{session_state.get('party_size')}*.\n\n"
                f"Please share your preferred date and time.\nExample: 25-05-2026, 8:00 PM",
                restaurant_id,
            )
            return {"status": "awaiting_datetime"}

        elif reply in ("SMALLER", "CHANGE"):
            session_state.pop("party_size", None)
            session_state.pop("_pending_combo", None)
            session_state["booking_step"] = "awaiting_party_size"
            await send_whatsapp_message(
                customer_phone, "No problem! How many people will be dining today?", restaurant_id
            )
            return {"status": "awaiting_party_size"}

        elif reply in ("YES", "CONFIRM") and session_state.get("_pending_combo"):
            combo      = session_state.get("_pending_combo", [])
            party_size = session_state.get("party_size", 1)
            portal_token_id = await sync_token_to_portal_large_party(
                customer_name=customer_name, customer_phone=customer_phone,
                pax=party_size, combo=combo, restaurant_id=restaurant_id,
            )
            display_token = portal_token_id or f"#{party_size}pax"
            session_state["display_token"] = display_token
            await send_whatsapp_message(
                customer_phone,
                f"✅ Your request for *{party_size} people* has been sent to our manager for approval.\n\n"
                f"Token: *{display_token}*\n\n"
                f"We'll confirm your tables shortly. If you don't hear back within "
                f"5 minutes, please speak to our staff directly. 😊",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_manager_approval"
            return {"status": "awaiting_manager_approval"}

        else:
            await send_whatsapp_message(
                customer_phone,
                "Please tap one of the options above to continue." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "awaiting_large_party_response"}

    # ── awaiting_manager_approval ─────────────────────────────────────────────
    elif booking_step == "awaiting_manager_approval":
        await send_whatsapp_message(
            customer_phone,
            "⏳ We're still waiting for manager confirmation on your table arrangement. "
            "Please hold on — we'll notify you shortly! 😊\n\n"
            "If it's urgent, please speak to our staff directly.",
            restaurant_id,
        )
        return {"status": "awaiting_manager_approval"}

    # ── awaiting_table_assignment ─────────────────────────────────────────────
    elif booking_step == "awaiting_table_assignment":
        table_assigned = session_state.get("table_number")
        if not table_assigned:
            table_assigned = await lookup_table_assignment(customer_phone, restaurant_id)
            if table_assigned:
                session_state["table_number"] = table_assigned

        if table_assigned:
            session_state["booking_step"] = "awaiting_order"
            await send_whatsapp_message(
                customer_phone,
                f"✅ Your table has been confirmed — *Table {table_assigned}*!\n\n"
                f"Browse our menu below and place your order 🍽️",
                restaurant_id,
            )
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": "awaiting_order"}
        else:
            await send_whatsapp_message(
                customer_phone,
                "⏳ We're still assigning your table. You'll receive a WhatsApp message "
                "with your table number shortly. If you've been waiting more than 5 minutes, "
                "please speak to our staff directly. 😊",
                restaurant_id,
            )
            return {"status": "awaiting_table_assignment"}

    # ── awaiting_order ────────────────────────────────────────────────────────
    elif booking_step == "awaiting_order":
        order_text = message.strip()
        if order_text.upper() == "MENU":
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": "awaiting_order"}

        # Fix 43: greeting arriving in awaiting_order means the customer has
        # come back to a stale session (e.g. after a failed order).
        # Clear any stale cart and resend the catalog rather than crashing.
        if is_greeting(order_text):
            logger.info(f"[dine-in] greeting in awaiting_order — clearing stale cart")
            clear_cart(session_state)
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart = session_state.get("cart", {})

        # Fix 41: empty-cart guard — mirrors Fix 31 for takeaway/delivery.
        # Prevents a ₹0 booking when a short/empty catalog message arrives
        # before the cart has been populated.
        if not cart and len(order_text) < 3:
            logger.info(f"[dine-in] empty cart + short message '{order_text}' — re-sending catalog")
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart_snapshot = dict(cart)
        total         = cart_total(cart) if cart else 0.0
        session_state["order_total"] = total
        token         = session_state.get("display_token", session_state.get("token_number", ""))
        booking_time  = session_state.get("booking_time", now_display())

        # Fix 44: large-party path never calls lookup_table_assignment, so
        # session["table_number"] stays as the Python None from the walk-in
        # QR parameter.  str(None) = "None" (literal) which breaks create_booking.
        # Use `or ""` so None → "" instead.
        _raw_table   = session_state.get("table_number")
        table_num_str = str(_raw_table) if _raw_table is not None else ""

        try:
            suggestion, booking = await asyncio.gather(
                safe_build_order_suggestion(customer_id, restaurant_id),
                create_booking(
                    restaurant_id, customer_id, "dine_in",
                    party_size=session_state.get("party_size"),
                    table_number=table_num_str,
                    token_number=token,
                ),
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            try:
                payment_link = await create_payment_link(
                    booking_id, total, customer_name,
                    f"Dine-in {token} at table {session_state.get('table_number')}",
                )
            except Exception as _pl:
                logger.warning(f"[payment] create_payment_link failed (non-fatal): {_pl}")
                payment_link = "placeholder"
            payment_line = ("💳 Payment can be made at the counter."
                            if is_placeholder_payment_link(payment_link)
                            else f"Pay here: {payment_link}")

            confirmation = (
                f"Your order has been placed! 🎉\n"
                f"────────────────────\n"
                f"Token: {token}\nOrder: {order_text}\n"
                f"────────────────────\n"
                f"Total: ₹{total:.0f}\n\n{payment_line}"
            )
            if suggestion:
                confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            notes_hint = build_notes_hint(order_text)
            await _send_interactive(customer_phone, {
                "interactive": {
                    "type": "button",
                    "body": {"text": (
                        f"👨‍🍳 Any requests for the kitchen? (optional)\n\n"
                        f"{notes_hint}\n\n"
                        "Just type it out, or tap below to skip 👇"
                    )},
                    "footer": {"text": "Your order is already being prepared!"},
                    "action": {"buttons": [
                        {"type": "reply", "reply": {"id": "SKIP", "title": "⏭️ No notes"}},
                    ]},
                }
            })
            session_state["special_notes_asked_at"] = time.time()
            start_special_notes_timer(customer_phone, restaurant_id)

            await send_whatsapp_message(
                manager_phone,
                f"📋 Order Received — Dine-in\n────────────────────\n"
                f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                f"Table: {table_num_str or 'Multi-table / TBD'}\n"
                f"Guests: {session_state.get('party_size')}\nBooking Time: {booking_time}\n"
                f"Order: {order_text}\nTotal: ₹{total:.0f}\n────────────────────",
                restaurant_id,
            )
            session_state["order_confirmed_summary"] = (
                f"Dine-in Token *{token}* — {order_text} "
                f"({session_state.get('party_size')} guests, ₹{total:.0f})"
            )
            _first_item = order_text.split(",")[0].strip()[:40]
            session_state["last_order_summary"]    = _first_item
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = session_state.get("visit_count", 0) + 1
            session_state["_kds_cart_snapshot"]    = cart_snapshot
            session_state["_kds_order_text"]       = order_text
            session_state["_receipt_cart"]         = cart_snapshot
            session_state["booking_step"]          = "awaiting_special_notes"
            clear_cart(session_state)
            return {"status": "awaiting_special_notes", "booking_id": booking_id, "total": total}

        except Exception as e:
            import traceback as _tb
            logger.error(
                f"[dine-in] create_booking failed | "
                f"party={session_state.get('party_size')} "
                f"table={session_state.get('table_number')} "
                f"token={token} total={total} | {e}\n{_tb.format_exc()}"
            )
            # Clear stale cart so the NEXT message (e.g. "Hi") doesn't
            # loop back into this handler and hit the same error.
            clear_cart(session_state)
            session_state["booking_step"] = "awaiting_order"
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was an error processing your order. Please try again." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "error"}

    # ── awaiting_special_notes ────────────────────────────────────────────────
    elif booking_step == "awaiting_special_notes":
        raw_notes: str = message.strip()
        token = session_state.get("display_token", session_state.get("token_number", ""))

        stop_special_notes_timer(customer_phone)

        asked_at  = session_state.get("special_notes_asked_at", 0)
        timed_out = (time.time() - asked_at) > 120
        if timed_out:
            raw_notes = "SKIP"

        if not raw_notes or raw_notes.upper() in ("SKIP", "NO", "NONE"):
            special_notes: str | None = None
            await send_whatsapp_message(
                customer_phone,
                "No problem! Your order is being prepared. Enjoy your meal! 🍽️",
                restaurant_id,
            )
        else:
            if len(raw_notes) > 500:
                await send_whatsapp_message(
                    customer_phone,
                    "Your message is a bit too long (max 500 characters). "
                    "Please keep it brief, or just tap *No notes*.",
                    restaurant_id,
                )
                return {"status": "awaiting_special_notes"}

            special_notes = raw_notes
            await send_whatsapp_message(
                manager_phone,
                f"📝 Special Notes — Token {token}\n────────────────────\n"
                f"Customer: {customer_name}\nPhone: {customer_phone}\n"
                f"Table: {session_state.get('table_number', 'TBD')}\n"
                f"Notes: {special_notes}\n────────────────────",
                restaurant_id,
            )
            await send_whatsapp_message(
                customer_phone,
                "✅ Got it! Your notes have been saved.\n\n"
                "Sit back and enjoy — your order is being prepared! 🍽️",
                restaurant_id,
            )

        session_state["special_notes"] = special_notes

        await notify_kds(
            customer_name=customer_name,
            customer_phone=customer_phone,
            order_text=session_state.pop("_kds_order_text", ""),
            cart=session_state.pop("_kds_cart_snapshot", {}),
            table_number=table_num_str or None,
            token_number=token,
            service_type="dine_in",
            restaurant_id=restaurant_id,
            special_notes=special_notes,
        )

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
                    table_number=table_num_str,
                    service_type="dine_in",
                    customer_name=customer_name,
                    customer_phone=customer_phone,
                    items=_LineItem.from_cart(session_state.get("_receipt_cart", {})),
                    gst_rate=5.0,
                    gst_inclusive=False,
                    payment_mode=session_state.get("payment_mode", "Cash"),
                    special_notes=special_notes or "",
                )
                receipt_path = _generate_receipt(receipt_data)
                logger.info(f"[receipt] Dine-in receipt saved: {receipt_path}")
                asyncio.create_task(
                    upload_and_send_receipt(receipt_path, customer_phone, restaurant_id, token)
                )
                booking_id = session_state.get("booking_id")
                if booking_id:
                    await update_booking_status(booking_id, "confirmed")
                    logger.info(f"[receipt] Booking {booking_id} marked confirmed")
            except Exception as _re:
                import traceback as _tb
                logger.warning(f"[receipt] Generation failed (non-fatal): {_re}\n{_tb.format_exc()}")

        # Feedback queue
        try:
            await get_http().post(
                "https://api.autom8.works/api/feedback/queue",
                json={
                    "restaurant_id": restaurant_id,
                    "customer_phone": customer_phone,
                    "customer_name":  customer_name,
                    "token_number":   token,
                    "table_number":   str(session_state.get("table_number", "")),
                },
                headers={"Authorization": f"Bearer {KDS_SECRET}"},
                timeout=aiohttp.ClientTimeout(total=5),
            )
        except Exception as fb_err:
            logger.warning(f"[feedback-queue] Non-fatal: {fb_err}")

        session_state["booking_step"] = "visit_complete"
        return {"status": "visit_complete"}

    return {"status": "error"}
