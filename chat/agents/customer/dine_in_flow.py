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
    create_booking,
    update_booking_status,
    recover_session_from_walk_in_token,
    _coerce_table_number,
    get_session_state,
    save_session_state,
    customer_lock,
)
from tools.payment_tools import create_payment_link
from tools.whatsapp_tools import send_whatsapp_message
from tools.cart_tools import (
    cart_to_order_text,
    cart_total,
    clear_cart,
    enrich_cart_titles,
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
    update_kds_order_notes,
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
    status_after_booking_menu,
    start_special_notes_timer,
    stop_special_notes_timer,
)
from agents.customer.conversation_helpers import safe_build_order_suggestion

import aiohttp

logger = logging.getLogger(__name__)


def _resolve_table_for_booking(session_state: Dict[str, Any]) -> int | None:
    """Resolve table number for create_booking — handles large-party multi-table."""
    raw = session_state.get("table_number")
    if raw is not None and raw != "":
        try:
            return _coerce_table_number(raw)
        except (TypeError, ValueError):
            pass

    assigned = session_state.get("assigned_tables") or []
    if assigned:
        try:
            return _coerce_table_number(assigned[0])
        except (TypeError, ValueError):
            pass

    return None


async def _sync_table_from_portal(
    restaurant_id: str,
    customer_phone: str,
    session_state: Dict[str, Any],
) -> int | None:
    """Try session recovery + token lookup; return resolved table number."""
    table_num = _resolve_table_for_booking(session_state)
    if table_num is not None:
        return table_num

    await recover_session_from_walk_in_token(restaurant_id, customer_phone, session_state)
    table_num = _resolve_table_for_booking(session_state)
    if table_num is not None:
        return table_num

    lookup = await lookup_table_assignment(customer_phone, restaurant_id)
    if lookup:
        try:
            table_num = _coerce_table_number(lookup)
            session_state["table_number"] = table_num
            return table_num
        except (TypeError, ValueError):
            pass
    return None


async def _finalize_special_notes_and_kitchen(
    *,
    restaurant_id: str,
    customer_phone: str,
    customer_name: str,
    session_state: Dict[str, Any],
    special_notes: str | None,
    notify_customer: bool = True,
) -> None:
    """Send order to KDS/KOT + receipt once notes are collected or timed out."""
    if session_state.get("_kitchen_sent"):
        token = session_state.get("display_token", session_state.get("token_number", ""))
        if special_notes:
            await update_kds_order_notes(
                restaurant_id,
                session_state.get("_kds_order_id"),
                token,
                special_notes,
            )
        if notify_customer:
            if special_notes:
                await send_whatsapp_message(
                    customer_phone,
                    "✅ Got it! Your notes have been saved.\n\n"
                    "Sit back and enjoy — your order is being prepared! 🍽️",
                    restaurant_id,
                )
            else:
                await send_whatsapp_message(
                    customer_phone,
                    "No problem! Your order is being prepared. Enjoy your meal! 🍽️",
                    restaurant_id,
                )
        session_state["special_notes"] = special_notes
        session_state["booking_step"] = "visit_complete"
        session_state.pop("_pending_kitchen", None)
        return

    pending = session_state.get("_pending_kitchen") or {}
    order_text = pending.get("order_text") or ""
    cart_snapshot = pending.get("cart") or {}
    if not order_text or not cart_snapshot:
        logger.warning(
            f"[dine-in] Missing pending kitchen payload for {customer_phone} — skipping KDS"
        )
        return

    token = session_state.get("display_token", session_state.get("token_number", ""))
    table_number = session_state.get("table_number")

    session_state["_kitchen_sent"] = True
    session_state["special_notes"] = special_notes

    order_id = await _fire_kitchen_and_receipt(
        restaurant_id=restaurant_id,
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text,
        cart_snapshot=cart_snapshot,
        session_state=session_state,
        token=token,
        table_number=table_number,
        special_notes=special_notes,
    )
    if order_id:
        session_state["_kds_order_id"] = order_id

    if notify_customer:
        if special_notes:
            await send_whatsapp_message(
                customer_phone,
                "✅ Got it! Your notes have been saved.\n\n"
                "Sit back and enjoy — your order is being prepared! 🍽️",
                restaurant_id,
            )
        else:
            await send_whatsapp_message(
                customer_phone,
                "No problem! Your order is being prepared. Enjoy your meal! 🍽️",
                restaurant_id,
            )

    try:
        await get_http().post(
            "https://api.autom8.works/api/feedback/queue",
            json={
                "restaurant_id": restaurant_id,
                "customer_phone": customer_phone,
                "customer_name": customer_name,
                "token_number": token,
                "table_number": str(table_number or ""),
            },
            headers={"Authorization": f"Bearer {KDS_SECRET}"},
            timeout=aiohttp.ClientTimeout(total=5),
        )
    except Exception as fb_err:
        logger.warning(f"[feedback-queue] Non-fatal: {fb_err}")

    session_state["booking_step"] = "visit_complete"
    session_state.pop("_pending_kitchen", None)


async def _on_special_notes_timeout(
    restaurant_id: str,
    customer_phone: str,
) -> None:
    """After 2 minutes with no reply, treat as no special notes and send to kitchen."""
    async with customer_lock(restaurant_id, customer_phone):
        session_state = await get_session_state(restaurant_id, customer_phone)
        if not session_state:
            return
        if session_state.get("booking_step") != "awaiting_special_notes":
            return
        if session_state.get("_kitchen_sent"):
            return

        customer_name = session_state.get("customer_name", "Guest")
        await _finalize_special_notes_and_kitchen(
            restaurant_id=restaurant_id,
            customer_phone=customer_phone,
            customer_name=customer_name,
            session_state=session_state,
            special_notes=None,
            notify_customer=True,
        )
        await save_session_state(restaurant_id, customer_phone, session_state)


async def _fire_kitchen_and_receipt(
    *,
    restaurant_id: str,
    customer_name: str,
    customer_phone: str,
    order_text: str,
    cart_snapshot: dict,
    session_state: Dict[str, Any],
    token: str,
    table_number,
    special_notes: str | None = None,
) -> str | None:
    """Send order to KDS/KOT; receipt image follows in background. Returns order_id."""
    order_id = await notify_kds(
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text,
        cart=cart_snapshot,
        table_number=table_number,
        token_number=token,
        service_type="dine_in",
        restaurant_id=restaurant_id,
        special_notes=special_notes,
    )

    if not RECEIPT_AVAILABLE:
        return order_id

    try:
        r_info = await fetch_restaurant_info(restaurant_id)
        table_label = str(table_number) if table_number else ""
        receipt_data = _ReceiptData(
            restaurant_name=r_info.get("name", ""),
            restaurant_address=r_info.get("address", ""),
            restaurant_phone=r_info.get("phone", ""),
            restaurant_gstin=r_info.get("gstin", ""),
            restaurant_wa_number=r_info.get("whatsapp_number", ""),
            restaurant_website=r_info.get("website", ""),
            receipt_url=receipt_qr_url(token),
            token_number=token,
            table_number=table_label,
            service_type="dine_in",
            customer_name=customer_name,
            customer_phone=customer_phone,
            items=_LineItem.from_cart(cart_snapshot),
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
    except Exception as _re:
        import traceback as _tb
        logger.warning(f"[receipt] Generation failed (non-fatal): {_re}\n{_tb.format_exc()}")

    return order_id


async def _confirm_dine_in_order(
    *,
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    order_text: str,
    session_state: Dict[str, Any],
    cart_snapshot: dict,
) -> Dict[str, Any]:
    """Create booking + send confirmation. Raises on failure."""
    await enrich_cart_titles(cart_snapshot, restaurant_id)
    if cart_snapshot:
        order_text = cart_to_order_text(cart_snapshot)
    total = cart_total(cart_snapshot) if cart_snapshot else 0.0
    session_state["order_total"] = total
    token = session_state.get("display_token", session_state.get("token_number", ""))
    booking_time = session_state.get("booking_time", now_display())
    table_num = await _sync_table_from_portal(restaurant_id, customer_phone, session_state)

    suggestion, booking = await asyncio.gather(
        safe_build_order_suggestion(customer_id, restaurant_id),
        create_booking(
            restaurant_id, customer_id, "dine_in",
            party_size=session_state.get("party_size"),
            table_number=table_num,
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
    payment_line = (
        "💳 Payment can be made at the counter."
        if is_placeholder_payment_link(payment_link)
        else f"Pay here: {payment_link}"
    )

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

    notes_hint = await build_notes_hint(order_text, cart_snapshot, restaurant_id)
    await _send_interactive(customer_phone, {
        "interactive": {
            "type": "button",
            "body": {"text": (
                "Anything you'd like us to pass to the kitchen? (totally optional)\n\n"
                f"{notes_hint}\n\n"
                "Just reply in your own words, or tap *No notes* if you're all set; "
                "otherwise we'll send your order along in about 2 minutes."
            )},
            "footer": {"text": "No rush — take your time"},
            "action": {"buttons": [
                {"type": "reply", "reply": {"id": "SKIP", "title": "No notes"}},
            ]},
        }
    }, restaurant_id)
    session_state["special_notes_asked_at"] = time.time()
    session_state["_pending_kitchen"] = {
        "order_text": order_text,
        "cart": dict(cart_snapshot),
    }

    # Send to KDS immediately — kitchen should see the order without waiting for notes.
    kds_order_id = await _fire_kitchen_and_receipt(
        restaurant_id=restaurant_id,
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text,
        cart_snapshot=cart_snapshot,
        session_state=session_state,
        token=token,
        table_number=table_num,
        special_notes=None,
    )
    if kds_order_id:
        session_state["_kitchen_sent"] = True
        session_state["_kds_order_id"] = kds_order_id
        await save_session_state(restaurant_id, customer_phone, session_state)
    else:
        logger.error(
            f"[dine-in] KDS notify failed for token {token} — "
            "kitchen board will stay empty until retry"
        )

    start_special_notes_timer(
        customer_phone,
        restaurant_id,
        on_timeout=lambda: _on_special_notes_timeout(restaurant_id, customer_phone),
    )

    tables_label = table_num or session_state.get("assigned_tables") or "Multi-table / TBD"
    await send_whatsapp_message(
        manager_phone,
        f"📋 Order Received — Dine-in\n────────────────────\n"
        f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
        f"Table: {tables_label}\n"
        f"Guests: {session_state.get('party_size')}\nBooking Time: {booking_time}\n"
        f"Order: {order_text}\nTotal: ₹{total:.0f}\n────────────────────",
        restaurant_id,
    )
    session_state["order_confirmed_summary"] = (
        f"Dine-in Token *{token}* — {order_text} "
        f"({session_state.get('party_size')} guests, ₹{total:.0f})"
    )
    _first_item = order_text.split(",")[0].strip()[:40]
    session_state["last_order_summary"] = _first_item
    session_state["is_returning_customer"] = True
    session_state["visit_count"] = session_state.get("visit_count", 0) + 1
    session_state["booking_step"] = "awaiting_special_notes"
    session_state.pop("_order_retry_attempted", None)
    clear_cart(session_state)

    return {"status": "awaiting_special_notes", "booking_id": booking_id, "total": total}


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

            booking_time = now_display()
            session_state["booking_time"] = booking_time

            portal_token_id = await sync_token_to_portal(
                customer_name=customer_name, customer_phone=customer_phone,
                token_type="dinein", pax=party_size, restaurant_id=restaurant_id,
            )
            if not portal_token_id:
                logger.error(
                    f"[dine-in] Portal token sync failed for {customer_phone} "
                    f"(restaurant={restaurant_id}) — queue will be empty in manager portal"
                )
                await send_whatsapp_message(
                    manager_phone,
                    f"⚠️ *Walk-in sync failed — add manually in portal*\n"
                    f"👤 {customer_name} · {party_size} {'person' if party_size == 1 else 'people'}\n"
                    f"📱 {customer_phone}\n"
                    f"🕐 {booking_time} IST\n\n"
                    f"Open portal → Queue → create walk-in token:\n{MANAGER_PORTAL_URL}",
                    restaurant_id,
                )
                await send_whatsapp_message(
                    customer_phone,
                    f"Thanks, {customer_name}! We've noted your party of *{party_size}*.\n\n"
                    f"Our team is confirming your table — you'll get a WhatsApp shortly. 🙏",
                    restaurant_id,
                )
                session_state["booking_step"] = "awaiting_table_assignment"
                return {"status": "awaiting_table_assignment"}

            session_state["token_number"]  = portal_token_id
            session_state["display_token"] = portal_token_id

            # Manager alert is sent by POST /api/tokens (notify=true) — same as T-077 flow.
            # Menu catalog is sent only after table assignment (portal or chat poll below).
            await send_whatsapp_message(
                customer_phone,
                f"You're all checked in! 🍽️\n\n"
                f"*Token: {portal_token_id}*\n"
                f"*Party size: {party_size}*\n\n"
                f"We're assigning your table — you'll get a WhatsApp when it's ready "
                f"with our menu to place your order. 🙏",
                restaurant_id,
            )
            clear_cart(session_state)
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
            booking_time = now_display()
            session_state["booking_time"] = booking_time
            portal_token_id = await sync_token_to_portal_large_party(
                customer_name=customer_name, customer_phone=customer_phone,
                pax=party_size, combo=combo, restaurant_id=restaurant_id,
            )
            if not portal_token_id:
                logger.error(
                    f"[dine-in] Large-party portal sync failed for {customer_phone} "
                    f"(restaurant={restaurant_id})"
                )
                table_lines = " + ".join(
                    f"Table {t[0]} ({t[2]}/{t[1]} seats)" for t in combo
                ) if combo else f"{party_size} seats"
                await send_whatsapp_message(
                    manager_phone,
                    f"⚠️ *Large-party sync failed — add manually in portal*\n"
                    f"👤 {customer_name} · {party_size} people\n"
                    f"📱 {customer_phone}\n"
                    f"🕐 {booking_time} IST\n"
                    f"Proposed: {table_lines}\n\n"
                    f"Open portal → Queue:\n{MANAGER_PORTAL_URL}",
                    restaurant_id,
                )
                await send_whatsapp_message(
                    customer_phone,
                    f"Thanks! Your party of *{party_size}* is being confirmed by our team. "
                    f"We'll message you shortly. 🙏",
                    restaurant_id,
                )
                session_state["booking_step"] = "awaiting_manager_approval"
                return {"status": "awaiting_manager_approval"}

            session_state["display_token"] = portal_token_id
            session_state["token_number"]  = portal_token_id

            # Manager alert is sent by POST /api/tokens (notify=true).
            await send_whatsapp_message(
                customer_phone,
                f"✅ Your request for *{party_size} people* has been sent to our manager for approval.\n\n"
                f"Token: *{portal_token_id}*\n\n"
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
        if await recover_session_from_walk_in_token(restaurant_id, customer_phone, session_state):
            tables = session_state.get("assigned_tables") or [session_state.get("table_number")]
            tables_txt = ", ".join(str(t) for t in tables if t)
            token = session_state.get("display_token", "")
            await send_whatsapp_message(
                customer_phone,
                f"✅ Great news — your tables are confirmed"
                + (f" (*{tables_txt}*)" if tables_txt else "")
                + (f"\nToken: *{token}*" if token else "")
                + "\n\nBrowse the menu below to place your order 🍽️",
                restaurant_id,
            )
            if session_state.get("cart"):
                session_state["booking_step"] = "awaiting_order"
                return await handle_dine_in_flow(
                    restaurant_id, customer_id, customer_name, customer_phone,
                    manager_phone, message, session_state, table_number,
                )
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": status_after_booking_menu(session_state)}

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
        token_ref = session_state.get("token_number") or session_state.get("display_token")
        if not token_ref or str(token_ref).startswith("#"):
            party_size = session_state.get("party_size") or 1
            portal_token_id = await sync_token_to_portal(
                customer_name=customer_name, customer_phone=customer_phone,
                token_type="dinein", pax=party_size, restaurant_id=restaurant_id,
            )
            if portal_token_id:
                session_state["token_number"]  = portal_token_id
                session_state["display_token"] = portal_token_id

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
                + (
                    "You can continue adding items from the menu above, "
                    "or type *MENU* to reopen it. 🍽️"
                    if session_state.get("_catalog_sent_after_party")
                    else "Browse our menu below and place your order 🍽️"
                ),
                restaurant_id,
            )
            if not session_state.get("_catalog_sent_after_party"):
                await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
                session_state["_catalog_sent_after_party"] = True
            return {"status": status_after_booking_menu(session_state)}
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
            return {"status": status_after_booking_menu(session_state)}

        # Fix 43: greeting arriving in awaiting_order means the customer has
        # come back to a stale session (e.g. after a failed order).
        # Clear any stale cart and resend the catalog rather than crashing.
        if is_greeting(order_text):
            logger.info(f"[dine-in] greeting in awaiting_order — clearing stale cart")
            clear_cart(session_state)
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": status_after_booking_menu(session_state)}

        cart = session_state.get("cart", {})

        # Fix 41: empty-cart guard — mirrors Fix 31 for takeaway/delivery.
        # Prevents a ₹0 booking when a short/empty catalog message arrives
        # before the cart has been populated.
        if not cart and len(order_text) < 3:
            logger.info(f"[dine-in] empty cart + short message '{order_text}' — re-sending catalog")
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": status_after_booking_menu(session_state)}

        cart_snapshot = dict(cart)
        await enrich_cart_titles(cart_snapshot, restaurant_id)
        order_text = cart_to_order_text(cart_snapshot)

        try:
            return await _confirm_dine_in_order(
                restaurant_id=restaurant_id,
                customer_id=customer_id,
                customer_name=customer_name,
                customer_phone=customer_phone,
                manager_phone=manager_phone,
                order_text=order_text,
                session_state=session_state,
                cart_snapshot=cart_snapshot,
            )

        except Exception as e:
            import traceback as _tb
            logger.error(
                f"[dine-in] order failed | party={session_state.get('party_size')} "
                f"table={session_state.get('table_number')} "
                f"token={session_state.get('display_token')} | {e}\n{_tb.format_exc()}"
            )

            # Retry once: sync from walk_in_tokens (manager may have approved
            # in the portal while the chat session was stale) then re-place order.
            if not session_state.get("_order_retry_attempted") and cart_snapshot:
                session_state["_order_retry_attempted"] = True
                session_state["cart"] = dict(cart_snapshot)
                if await recover_session_from_walk_in_token(
                    restaurant_id, customer_phone, session_state
                ):
                    logger.info(f"[dine-in] retrying order after token recovery for {customer_phone}")
                    try:
                        return await _confirm_dine_in_order(
                            restaurant_id=restaurant_id,
                            customer_id=customer_id,
                            customer_name=customer_name,
                            customer_phone=customer_phone,
                            manager_phone=manager_phone,
                            order_text=order_text,
                            session_state=session_state,
                            cart_snapshot=cart_snapshot,
                        )
                    except Exception as retry_err:
                        logger.error(
                            f"[dine-in] retry also failed for {customer_phone}: {retry_err}"
                        )

            session_state["booking_step"] = "awaiting_order"
            session_state["cart"] = dict(cart_snapshot)
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was a hiccup placing your order. "
                "Your cart is saved — please tap *Confirm order* again "
                "or browse the menu to re-submit. 🙏" + _HOME_HINT,
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

        await _finalize_special_notes_and_kitchen(
            restaurant_id=restaurant_id,
            customer_phone=customer_phone,
            customer_name=customer_name,
            session_state=session_state,
            special_notes=special_notes,
            notify_customer=True,
        )
        return {"status": "visit_complete"}

    return {"status": "error"}
