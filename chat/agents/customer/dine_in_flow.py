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
    get_active_walk_in_token,
    apply_walk_in_token_to_session,
    _coerce_table_number,
    get_session_state,
    save_session_state,
    customer_lock,
    mark_booking_kds_sent,
)
from tools.payment_tools import build_payment_line
from tools.prepay_fulfillment import (
    reset_kitchen_state_for_new_checkout,
    prepay_fulfillment_required,
    build_prepay_payload,
    stash_and_persist_prepay_payload,
    kitchen_blocked_pending_payment,
    PREPAY_PENDING_FOOTER,
)
from tools.restaurant_config import get_manager_phone
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
    notify_manager_order_alert,
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
    handle_unknown_booking_step,
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


async def _notify_manager_order_received(
    *,
    manager_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
    customer_name: str,
    customer_phone: str,
    order_text: str,
    total: float,
    token: str,
    booking_time: str,
    table_num,
) -> None:
    """Alert manager once per token (idempotent across webhook retries / replicas)."""
    if session_state.get("_manager_order_notified_for") == token:
        return

    phone = (manager_phone or session_state.get("manager_phone") or "").strip()
    if not phone:
        resolved = await get_manager_phone(restaurant_id)
        phone = (resolved or "").strip()
    if not phone:
        logger.warning(f"[dine-in] No manager phone — skipping order alert for {token}")
        return

    tables_label = table_num or session_state.get("assigned_tables") or "Multi-table / TBD"
    party_size = session_state.get("party_size")

    ok = await notify_manager_order_alert(
        restaurant_id,
        token_number=token,
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text,
        total=total,
        table_number=tables_label,
        party_size=party_size,
        booking_time=booking_time,
    )
    if ok:
        session_state["_manager_order_notified_for"] = token
        session_state["manager_phone"] = phone
        logger.info(f"[dine-in] Manager order alert sent for {token} → {phone}")
        return

    body = (
        f"📋 Order Received — Dine-in\n────────────────────\n"
        f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
        f"Table: {tables_label}\n"
        f"Guests: {party_size}\nBooking Time: {booking_time}\n"
        f"Order: {order_text}\nTotal: ₹{total:.0f}\n────────────────────"
    )
    fallback_ok = await send_whatsapp_message(phone, body, restaurant_id)
    if fallback_ok:
        session_state["_manager_order_notified_for"] = token
        session_state["manager_phone"] = phone
        logger.info(f"[dine-in] Manager order alert (fallback) sent for {token} → {phone}")
    else:
        logger.warning(f"[dine-in] Manager order alert failed for {token} → {phone}")


async def _ensure_pending_kitchen(session_state: Dict[str, Any]) -> bool:
    """Ensure _pending_kitchen has order payload; return True if ready for KDS."""
    pending = session_state.get("_pending_kitchen") or {}
    if pending.get("order_text") and pending.get("cart"):
        return True

    backup = session_state.get("_prepay_kitchen_snapshot") or {}
    if backup.get("order_text") and backup.get("cart"):
        session_state["_pending_kitchen"] = {
            "order_text": backup["order_text"],
            "cart": dict(backup["cart"]),
        }
        return True
    return False


async def _finalize_special_notes_and_kitchen(
    *,
    restaurant_id: str,
    customer_phone: str,
    customer_name: str,
    session_state: Dict[str, Any],
    special_notes: str | None,
    notify_customer: bool = True,
    force_kitchen_send: bool = False,
) -> None:
    """Send order to KDS/KOT + receipt once notes are collected or timed out."""
    if kitchen_blocked_pending_payment(session_state):
        session_state["_deferred_special_notes"] = special_notes
        session_state["_notes_finalized_pending_payment"] = True
        session_state.pop("special_notes_asked_at", None)
        session_state["booking_step"] = "awaiting_prepay"
        await save_session_state(restaurant_id, customer_phone, session_state)
        if notify_customer:
            if special_notes:
                await send_whatsapp_message(
                    customer_phone,
                    "✅ Got it! Your notes are saved.\n\n"
                    "Complete payment to send your order to the kitchen.",
                    restaurant_id,
                )
            else:
                await send_whatsapp_message(
                    customer_phone,
                    "No problem! Complete payment to send your order to the kitchen.",
                    restaurant_id,
                )
        return

    stale_kitchen = session_state.get("_kitchen_sent") and not force_kitchen_send
    if stale_kitchen and session_state.get("booking_step") in (
        "awaiting_special_notes", "awaiting_prepay",
    ):
        session_state.pop("_kitchen_sent", None)
        stale_kitchen = False
    if stale_kitchen and kitchen_blocked_pending_payment(session_state):
        session_state.pop("_kitchen_sent", None)
        stale_kitchen = False

    if stale_kitchen:
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
        session_state["_customer_finalize_sent"] = True
        session_state.pop("_pending_kitchen", None)
        return

    # Previous attempt may have marked finalize without reaching KDS — allow retry.
    if session_state.get("_customer_finalize_sent") or session_state.get("_kitchen_send_claimed"):
        session_state.pop("_customer_finalize_sent", None)
        session_state.pop("_kitchen_send_claimed", None)

    if not await _ensure_pending_kitchen(session_state):
        logger.warning(
            f"[dine-in] Missing pending kitchen payload for {customer_phone} — skipping KDS"
        )
        if notify_customer:
            await send_whatsapp_message(
                customer_phone,
                "We couldn't find your order details to send to the kitchen. "
                "Please contact the staff or reply *Home* to start again.",
                restaurant_id,
            )
        return

    pending = session_state.get("_pending_kitchen") or {}
    order_text = pending.get("order_text") or ""
    cart_snapshot = pending.get("cart") or {}

    if cart_snapshot:
        from tools.cart_tools import enrich_cart_titles
        await enrich_cart_titles(cart_snapshot, restaurant_id)
        if cart_snapshot:
            order_text = order_text or cart_to_order_text(cart_snapshot)

    token = session_state.get("display_token", session_state.get("token_number", ""))
    table_number = session_state.get("table_number")

    session_state["_kitchen_send_claimed"] = True
    session_state["special_notes"] = special_notes
    await save_session_state(restaurant_id, customer_phone, session_state)

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
    if not order_id:
        session_state["_kitchen_sent"] = False
        session_state["_kitchen_send_claimed"] = False
        session_state.pop("_customer_finalize_sent", None)
        logger.error(
            f"[dine-in] KDS notify failed for token {token} ({customer_phone}) — will retry on next message"
        )
        if notify_customer:
            await send_whatsapp_message(
                customer_phone,
                "Your notes are saved, but we couldn't reach the kitchen display yet. "
                "Our team has been notified — please alert staff if nothing appears shortly.",
                restaurant_id,
            )
        await save_session_state(restaurant_id, customer_phone, session_state)
        return

    session_state["_kitchen_sent"] = True
    session_state["_kds_order_id"] = order_id

    await _notify_manager_order_received(
        manager_phone=session_state.get("manager_phone", ""),
        restaurant_id=restaurant_id,
        session_state=session_state,
        customer_name=customer_name,
        customer_phone=customer_phone,
        order_text=order_text,
        total=cart_total(cart_snapshot) if cart_snapshot else 0.0,
        token=token,
        booking_time=session_state.get("booking_time", now_display()),
        table_num=table_number,
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
    session_state["_customer_finalize_sent"] = True
    session_state.pop("_pending_kitchen", None)
    await save_session_state(restaurant_id, customer_phone, session_state)


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
        if session_state.get("_customer_finalize_sent"):
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
        booking_id=session_state.get("booking_id"),
    )

    if order_id and session_state.get("booking_id"):
        await mark_booking_kds_sent(session_state["booking_id"])

    if not RECEIPT_AVAILABLE:
        return order_id

    if session_state.get("_receipt_sent"):
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
            payment_mode="Online" if session_state.get("_payment_received") else session_state.get("payment_mode", "Cash"),
            special_notes=special_notes or "",
        )
        receipt_path = _generate_receipt(receipt_data)
        logger.info(f"[receipt] Dine-in receipt saved: {receipt_path}")
        session_state["_receipt_sent"] = True
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
    reset_kitchen_state_for_new_checkout(session_state)

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

    payment_line = await build_payment_line(
        booking_id, total, customer_name, customer_phone,
        f"Dine-in {token} at table {session_state.get('table_number')}",
        session_state, service_type="dine_in",
    )

    prepay_pending = prepay_fulfillment_required(session_state)
    confirmation = (
        f"Your order has been placed! 🎉\n"
        f"────────────────────\n"
        f"Token: {token}\nOrder: {order_text}\n"
        f"────────────────────\n"
        f"Total: ₹{total:.0f}\n\n{payment_line}"
    )
    if prepay_pending:
        confirmation += f"\n\n{PREPAY_PENDING_FOOTER}"
    if suggestion:
        confirmation += f"\n\n{suggestion}"
    await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

    if prepay_pending:
        await stash_and_persist_prepay_payload(
            session_state,
            booking_id,
            build_prepay_payload(
                service_type="dine_in",
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
                totals={},
                booking_time=booking_time,
                manager_phone=manager_phone,
                table_number=table_num,
            ),
        )
    else:
        await _notify_manager_order_received(
            manager_phone=manager_phone,
            restaurant_id=restaurant_id,
            session_state=session_state,
            customer_name=customer_name,
            customer_phone=customer_phone,
            order_text=order_text,
            total=total,
            token=token,
            booking_time=booking_time,
            table_num=table_num,
        )

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
    session_state["_prepay_kitchen_snapshot"] = {
        "order_text": order_text,
        "cart": dict(cart_snapshot),
    }

    if not prepay_pending:
        session_state["_kitchen_send_claimed"] = True
        await save_session_state(restaurant_id, customer_phone, session_state)

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
            session_state["_kitchen_send_claimed"] = False
            logger.error(
                f"[dine-in] KDS notify failed for token {token} — "
                "kitchen board will stay empty until retry"
            )
            await save_session_state(restaurant_id, customer_phone, session_state)
    else:
        await save_session_state(restaurant_id, customer_phone, session_state)

    start_special_notes_timer(
        customer_phone,
        restaurant_id,
        on_timeout=lambda: _on_special_notes_timeout(restaurant_id, customer_phone),
    )

    session_state["order_confirmed_summary"] = (
        f"Dine-in Token *{token}* — {order_text} "
        f"({session_state.get('party_size')} guests, ₹{total:.0f})"
    )
    from agents.customer.booking_helpers import strip_order_quantity
    _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
    session_state["last_order_summary"] = _first_item
    session_state["is_returning_customer"] = True
    session_state["visit_count"] = session_state.get("visit_count", 0) + 1
    session_state["booking_step"] = "awaiting_special_notes"
    session_state.pop("_order_retry_attempted", None)
    clear_cart(session_state)

    return {"status": "awaiting_special_notes", "booking_id": booking_id, "total": total}


async def resume_active_dine_in_token(
    restaurant_id: str,
    customer_phone: str,
    customer_name: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any] | None:
    """
    If this phone already has a non-terminal dine-in token today, resume that
    visit instead of creating a duplicate (Hi/dine-in retries during slow states).
    """
    token = await get_active_walk_in_token(restaurant_id, customer_phone)
    if not token or token.get("type") not in ("dinein", "large_party"):
        return None

    token_id = token.get("id")
    status = token.get("status")
    session_state["service_type"] = "dine_in"
    session_state["last_service_type"] = "dine_in"
    session_state["token_number"] = token_id
    session_state["display_token"] = token_id
    if token.get("pax"):
        session_state["party_size"] = int(token["pax"])

    if status == "seated":
        apply_walk_in_token_to_session(session_state, token)
        tables = session_state.get("assigned_tables") or [session_state.get("table_number")]
        tables_txt = ", ".join(str(t) for t in tables if t)
        await send_whatsapp_message(
            customer_phone,
            f"Welcome back! You're at *Table {tables_txt or '?'}* "
            f"(Token *{token_id}*).\n\nBrowse the menu below to add items. 🍽️",
            restaurant_id,
        )
        if not session_state.get("_catalog_sent_after_party"):
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            session_state["_catalog_sent_after_party"] = True
        return {"status": status_after_booking_menu(session_state)}

    if status == "pending_approval":
        session_state["booking_step"] = "awaiting_manager_approval"
        await send_whatsapp_message(
            customer_phone,
            f"We're still confirming your table for *{session_state.get('party_size', token.get('pax'))}* "
            f"guests (Token *{token_id}*). You'll hear from us shortly. 🙏",
            restaurant_id,
        )
        return {"status": "awaiting_manager_approval"}

    if status == "waiting":
        session_state["booking_step"] = "awaiting_table_assignment"
        await send_whatsapp_message(
            customer_phone,
            f"We're still finding your table, {customer_name}! 🍽️\n\n"
            f"*Token: {token_id}* — we'll message you when it's ready.",
            restaurant_id,
        )
        return {"status": "awaiting_table_assignment"}

    return None


async def handle_dine_in_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any], table_number: int | None = None,
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")
    msg_lower = message.strip().lower()

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

            resumed = await resume_active_dine_in_token(
                restaurant_id, customer_phone, customer_name, session_state,
            )
            if resumed:
                return resumed

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

            from tools.db_tools import get_walk_in_token_by_id
            from tools.wait_estimate import build_dinein_customer_message

            token_row = await get_walk_in_token_by_id(restaurant_id, portal_token_id) if portal_token_id else None
            estimate_display = (token_row or {}).get("estimate_display")
            est_min = (token_row or {}).get("estimated_wait_minutes")

            if token_row and estimate_display is not None and est_min is not None:
                customer_msg = build_dinein_customer_message(
                    party_size,
                    portal_token_id,
                    {
                        "estimate_minutes": est_min,
                        "display": estimate_display,
                        "low": 0,
                        "high": 0,
                    },
                )
            else:
                customer_msg = (
                    f"Party of *{party_size}* — perfect! We're finding you a table... 🍽️\n\n"
                    f"*Token: {portal_token_id}*\n\n"
                    f"We'll send you our menu on WhatsApp once your table is ready. 🙏"
                )

            await send_whatsapp_message(customer_phone, customer_msg, restaurant_id)
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
        if msg_lower in ("cancel", "cancel request", "cancel order"):
            session_state["booking_step"] = "visit_complete"
            await send_whatsapp_message(
                customer_phone,
                "Your table request has been cancelled. Reply *Home* anytime to start a new booking."
                + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "visit_complete"}

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
            "If it's urgent, please speak to our staff directly."
            + _HOME_HINT,
            restaurant_id,
        )
        return {"status": "awaiting_manager_approval"}

    # ── awaiting_table_assignment ─────────────────────────────────────────────
    elif booking_step == "awaiting_table_assignment":
        if msg_lower in ("cancel", "cancel request", "cancel order"):
            session_state["booking_step"] = "visit_complete"
            await send_whatsapp_message(
                customer_phone,
                "Your table request has been cancelled. Reply *Home* anytime to start a new booking."
                + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "visit_complete"}

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
                "please speak to our staff directly. 😊"
                + _HOME_HINT,
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
        step = session_state.get("booking_step", "visit_complete")
        return {"status": step if step in ("awaiting_prepay", "visit_complete") else "visit_complete"}

    return await handle_unknown_booking_step(
        customer_phone, restaurant_id, session_state, flow_name="dine_in", booking_step=booking_step,
    )
