"""
agents/customer/booking_agent.py
──────────────────────────────────
Main booking flow router.  All per-service flow logic has been extracted
into dedicated modules:

  agents/customer/dine_in_flow.py        handle_dine_in_flow     (Fix 41)
  agents/customer/takeaway_flow.py       handle_takeaway_flow    (Fix 38)
  agents/customer/delivery_flow.py       handle_delivery_flow    (Fix 38)
  agents/customer/reserve_table_flow.py  handle_reserve_table_flow

Supporting helpers:
  agents/customer/booking_helpers.py     constants, parsers, catalog fallback,
                                         reset helpers, smart greeting (Fix 39, Fix 40)
  agents/customer/conversation_helpers.py  safe CI / personalisation wrappers
  tools/booking_mechanisms.py            HTTP client, portal sync, KDS, receipt,
                                         advance payment, large party

FIX LOG (router-level)
──────────────────────
  Fix 38 — Takeaway & delivery now set booking_step = visit_complete after
            order confirmation (was awaiting_payment). Session auto-resets on
            the customer's next message. See takeaway_flow.py / delivery_flow.py.
  Fix 39 — _do_reset full_restart preserves is_returning_customer / visit_count /
            last_order_summary so greeting never falls back to first-timer
            template. See booking_helpers.do_reset.
  Fix 40 — send_catalog_with_fallback last-resort message now directs customer
            to the Shop icon. See booking_helpers.send_catalog_with_fallback.
  Fix 41 — handle_dine_in_flow awaiting_order: empty-cart guard added.
            See dine_in_flow.py.
  Fix 42 — Feedback reply interception: 1-5 replies arriving while session is
            in awaiting_order / awaiting_payment / visit_complete (sent by
            Node.js feedback job) are now handled gracefully instead of being
            routed to the booking flow and erroring.

DEAD CODE REMOVED
─────────────────
  • auto_nudge_special_notes_loop  — was a no-op stub never registered
  • _send_menu wrapper             — was a trivial alias for send_catalog_with_fallback
  • Module-level _nudge_tasks / timer stubs moved to booking_helpers.py
"""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, Any

from tools.whatsapp_tools import send_whatsapp_message
from tools.cart_tools import (
    add_to_cart,
    clear_cart,
    cart_to_order_text,
    enrich_cart_titles,
    cart_summary_text,
    cart_total,
    send_cart_summary_buttons,
    parse_numbered_order,
    _send_interactive,
)
from tools.feature_gate import resolve_service_choice
from tools.personalisation_tools import update_customer_profile
from tools.db_tools import update_booking_status
from tools.booking_mechanisms import cache_restaurant_pricing

from agents.customer.booking_helpers import (
    MANAGER_PORTAL_URL,
    _HOME_HINT,
    _GENERIC_GREETINGS,
    _RESET_KEYWORDS,
    _STEPS_ALLOWING_SHORT_REPLY,
    now_display,
    is_greeting,
    is_feedback_reply,
    send_catalog_with_fallback,
    send_service_menu,
    build_smart_greeting,
    is_name_correction_trigger,
    prompt_name_verification,
    gate_ordering_service,
    send_closed_kitchen_notice,
    strip_order_quantity,
    ask_continue_or_reset,
    do_reset,
)
from agents.customer.conversation_helpers import (
    safe_build_greeting,
    safe_log_event,
    background_analytics,
)
from agents.customer.dine_in_flow import handle_dine_in_flow
from agents.customer.takeaway_flow import handle_takeaway_flow
from agents.customer.delivery_flow import handle_delivery_flow
from agents.customer.reserve_table_flow import handle_reserve_table_flow
from agents.customer.feedback_flow import handle_feedback_flow

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# MAIN BOOKING FLOW ROUTER
# ─────────────────────────────────────────────

async def handle_booking_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any], table_number: int | None = None,
) -> Dict[str, Any]:

    asyncio.create_task(background_analytics(
        restaurant_id, customer_id,
        message, session_state.get("booking_step", "start"),
    ))

    current_step = session_state.get("booking_step", "ask_service")
    session_state["restaurant_id"] = restaurant_id

    # ── visit_complete: treat any new message as fresh visit ─────────────────
    if current_step == "visit_complete":
        if is_feedback_reply(message):
            await send_whatsapp_message(
                customer_phone,
                "Thank you for your feedback! 🙏 We hope to see you again soon. 😊",
                restaurant_id,
            )
            return {"status": "visit_complete"}
        logger.info(f"[visit_complete] New message from {customer_phone} — fresh visit.")
        _prev_cid    = session_state.get("customer_id")
        _prev_cname  = session_state.get("customer_name")
        _prev_ret    = session_state.get("is_returning_customer", True)
        _prev_visits = session_state.get("visit_count", 0)
        _prev_last   = session_state.get("last_order_summary", "")
        _prev_svc    = session_state.get("service_type") or session_state.get("last_service_type")
        session_state.clear()
        if _prev_cid:    session_state["customer_id"]          = _prev_cid
        if _prev_cname:  session_state["customer_name"]        = _prev_cname
        session_state["is_returning_customer"] = _prev_ret
        if _prev_visits: session_state["visit_count"]          = _prev_visits
        if _prev_last:   session_state["last_order_summary"]   = strip_order_quantity(_prev_last)
        if _prev_svc:    session_state["last_service_type"]    = _prev_svc
        session_state["booking_step"] = "ask_service"
        current_step = "ask_service"

    # ── Feedback steps — routed entirely to feedback_flow ────────────────────
    _FEEDBACK_STEPS = {
        "awaiting_feedback_rating",
        "awaiting_feedback_aspects",
        "awaiting_feedback_comment",
    }
    if current_step in _FEEDBACK_STEPS:
        return await handle_feedback_flow(
            restaurant_id=restaurant_id,
            customer_name=customer_name,
            customer_phone=customer_phone,
            message=message,
            session_state=session_state,
            message_obj=None,   # pass full webhook dict here once dispatcher supports it
        )

    # ── Closed kitchen: REMIND opt-in ─────────────────────────────────────────
    if message.strip().upper() == "REMIND":
        from tools.kitchen_hours import is_kitchen_open, next_open_label
        if not is_kitchen_open():
            session_state["remind_when_open"] = True
            await send_whatsapp_message(
                customer_phone,
                f"Got it — we'll message you when we open at *{next_open_label()}*. 🙏",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_service_selection"
            return {"status": "remind_scheduled"}
        raw_greeting = await safe_build_greeting(customer_id, restaurant_id)
        greeting = build_smart_greeting(customer_name, raw_greeting, session_state)
        await send_service_menu(
            customer_phone, restaurant_id, greeting, session_state, announce_closed=False,
        )
        session_state["booking_step"] = "awaiting_service_selection"
        session_state.pop("remind_when_open", None)
        return {"status": "awaiting_service_selection"}

    # ── Closed kitchen: repeat greeting while stuck in ordering ───────────────
    from tools.kitchen_hours import is_kitchen_open, ordering_blocked_for_service
    svc = session_state.get("service_type")
    if (
        not is_kitchen_open()
        and ordering_blocked_for_service(svc)
        and current_step in ("awaiting_order", "awaiting_address")
        and (is_greeting(message) or len(message.strip()) < 4)
    ):
        await send_closed_kitchen_notice(
            customer_phone, restaurant_id, session_state, service_type=svc,
        )
        raw_greeting = await safe_build_greeting(customer_id, restaurant_id)
        ret_greeting = build_smart_greeting(customer_name, raw_greeting, session_state)
        await send_service_menu(
            customer_phone, restaurant_id, ret_greeting, session_state,
            announce_closed=False,
        )
        session_state["booking_step"] = "awaiting_service_selection"
        session_state.pop("delivery_address", None)
        clear_cart(session_state)
        return {"status": "awaiting_service_selection"}

    # ── Global Home / reset keyword ───────────────────────────────────────────
    if (current_step not in {"awaiting_reset_confirmation"}
            and message.strip().lower() in _RESET_KEYWORDS):
        session_state["step_before_reset"]     = current_step
        session_state["booking_step"]          = "awaiting_reset_confirmation"
        session_state["_full_restart_pending"] = True
        await ask_continue_or_reset(customer_phone, restaurant_id, full_restart=True)
        return {"status": "awaiting_reset_confirmation"}

    # ── Greeting guard ────────────────────────────────────────────────────────
    if (current_step not in _STEPS_ALLOWING_SHORT_REPLY and is_greeting(message)):
        session_state["step_before_reset"] = current_step
        session_state["booking_step"]      = "awaiting_reset_confirmation"
        await ask_continue_or_reset(customer_phone, restaurant_id)
        return {"status": "awaiting_reset_confirmation"}

    # ── awaiting_payment (only reached by reserve_table advance flow) ─────────
    if current_step == "awaiting_payment":
        text_upper = message.strip().upper()
        if text_upper in ("NEW ORDER", "NEW", "ORDER AGAIN"):
            _cid = session_state.get("customer_id")
            _cname = session_state.get("customer_name")
            _mphone = session_state.get("manager_phone")
            session_state.clear()
            if _cid:    session_state["customer_id"]   = _cid
            if _cname:  session_state["customer_name"] = _cname
            if _mphone: session_state["manager_phone"] = _mphone
            raw_greeting = await safe_build_greeting(customer_id, restaurant_id)
            session_state["is_returning_customer"] = True
            ret_greeting = build_smart_greeting(customer_name, raw_greeting, session_state)
            await send_service_menu(customer_phone, restaurant_id, ret_greeting, session_state)
            session_state["booking_step"] = "awaiting_service_selection"
            return {"status": "awaiting_service_selection"}
        summary = session_state.get("order_confirmed_summary",
                                    f"Token *#{session_state.get('token_number', '')}*")
        await _send_interactive(customer_phone, {
            "interactive": {
                "type": "button",
                "body": {"text": f"✅ Your reservation is confirmed!\n_{summary}_"},
                "footer": {"text": "Want to place a new order?"},
                "action": {"buttons": [
                    {"type": "reply", "reply": {"id": "NEW ORDER", "title": "🆕 Place New Order"}},
                ]},
            }
        })
        return {"status": "awaiting_payment"}

    # ── ask_service ───────────────────────────────────────────────────────────
    if current_step == "ask_service":
        if not session_state.get("_menu_sent"):
            raw_greeting = await safe_build_greeting(customer_id, restaurant_id)
            greeting     = build_smart_greeting(customer_name, raw_greeting, session_state)
            await send_service_menu(customer_phone, restaurant_id, greeting, session_state)
            session_state["_menu_sent"]   = True
            session_state["booking_step"] = "awaiting_service_selection"
        return {"status": "menu_sent"}

    # ── awaiting_service_selection ────────────────────────────────────────────
    if current_step == "awaiting_service_selection":
        _SERVICE_TEXT_MAP = {
            "dine":"1","dine in":"1","dinein":"1","dine-in":"1","dine in now":"1","dining":"1","table":"1","eat in":"1",
            "takeaway":"2","take away":"2","take-away":"2","pickup":"2","pick up":"2","carry out":"2","parcel":"2","take out":"2","takeaway now":"2",
            "delivery":"3","deliver":"3","home delivery":"3","delivery now":"3",
            "reserve":"4","reservation":"4","book":"4","booking":"4","book a table":"4","reserve a table":"4",
        }
        _raw_choice = message.strip()
        if is_name_correction_trigger(_raw_choice, customer_name):
            return await prompt_name_verification(
                customer_phone, restaurant_id, customer_name, session_state,
            )
        choice = _SERVICE_TEXT_MAP.get(_raw_choice.lower(), _raw_choice)
        try:
            service_type = await resolve_service_choice(restaurant_id, choice)
        except ValueError:
            if is_name_correction_trigger(_raw_choice, customer_name):
                return await prompt_name_verification(
                    customer_phone, restaurant_id, customer_name, session_state,
                )
            if is_greeting(_raw_choice) or _raw_choice.lower() in (
                "good morning", "good afternoon", "good evening", "morning", "gm",
            ):
                raw_greeting = await safe_build_greeting(customer_id, restaurant_id)
                greeting = build_smart_greeting(customer_name, raw_greeting, session_state)
                await send_service_menu(
                    customer_phone, restaurant_id, greeting, session_state, announce_closed=False,
                )
                session_state["booking_step"] = "awaiting_service_selection"
                return {"status": "awaiting_service_selection"}
            await send_whatsapp_message(
                customer_phone, "Sorry, I did not catch that. Please tap one of the options above." + _HOME_HINT, restaurant_id
            )
            return {"status": "error"}

        if service_type is None:
            await send_whatsapp_message(
                customer_phone, "No problem! Feel free to message us anytime you need help. 😊", restaurant_id
            )
            session_state.clear()
            return {"status": "cancelled"}

        session_state["service_type"]  = service_type
        session_state["customer_name"] = customer_name
        session_state["manager_phone"] = manager_phone

        if service_type == "dine_in":
            session_state["last_service_type"] = "dine_in"
            await send_whatsapp_message(customer_phone, "How many people are dining today?", restaurant_id)
            session_state["booking_step"] = "awaiting_party_size"
            session_state["table_number"] = table_number
        elif service_type == "takeaway":
            if await gate_ordering_service(
                customer_phone, restaurant_id, session_state, "takeaway",
            ):
                return {"status": "awaiting_service_selection"}
            clear_cart(session_state)
            session_state["booking_step"] = "awaiting_order"
            session_state["last_service_type"] = "takeaway"
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
        elif service_type == "delivery":
            await cache_restaurant_pricing(session_state, restaurant_id)
            from tools.kitchen_hours import is_kitchen_open
            from agents.customer.delivery_flow import offer_delivery_schedule
            if not is_kitchen_open():
                return await offer_delivery_schedule(
                    customer_phone, restaurant_id, customer_id, customer_name, session_state,
                )
            from tools.whatsapp_tools import send_location_request
            sent = await send_location_request(customer_phone, restaurant_id)
            if not sent:
                await send_whatsapp_message(
                    customer_phone,
                    "Great! You've selected Delivery 🛵\n\n"
                    "Please *share your location pin* on WhatsApp (tap 📎 → Location) so we can calculate delivery charge accurately.\n"
                    "You can also type your full address if needed.",
                    restaurant_id,
                )
            session_state["booking_step"] = "awaiting_address"
        elif service_type == "reserve_table":
            await send_whatsapp_message(
                customer_phone,
                "Great! You've selected Reserve a Table 📅\n\nHow many people will be dining?",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_party_size"

        return {"status": f"awaiting_{session_state['booking_step'].replace('awaiting_', '')}"}

    # ── awaiting_reset_confirmation ───────────────────────────────────────────
    if current_step == "awaiting_reset_confirmation":
        choice = message.strip()
        if choice == "1":
            restored_step = session_state.pop("step_before_reset", "ask_service")
            session_state["booking_step"] = restored_step
            if restored_step in (
                "awaiting_order","awaiting_category_selection",
                "awaiting_item_selection","awaiting_cart_action",
                "awaiting_quantity","awaiting_item_qty","awaiting_numbered_order",
            ):
                await send_whatsapp_message(
                    customer_phone,
                    "No problem, let's continue! 😊\n\nHere's the menu — tap to add items to your basket 🛒",
                    restaurant_id,
                )
                session_state["booking_step"] = "awaiting_order"
                await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            else:
                await send_whatsapp_message(
                    customer_phone,
                    "No problem, let's continue! 😊\n\nPlease tell us what you'd like to order.\nType *MENU* to see today's full menu.",
                    restaurant_id,
                )
            return {"status": restored_step}
        elif choice == "2":
            full_restart = session_state.pop("_full_restart_pending", False)
            await do_reset(
                customer_id, customer_name, customer_phone, restaurant_id,
                session_state, full_restart=full_restart,
            )
            return {"status": "identity_restart" if full_restart else "reset_complete"}
        else:
            await send_whatsapp_message(
                customer_phone, "Please tap *Continue my order* or *Start over*." + _HOME_HINT, restaurant_id
            )
            return {"status": "error"}

    # ── confirming_order ──────────────────────────────────────────────────────
    if current_step == "confirming_order":
        cart = session_state.get("cart", {})
        if not cart:
            await send_whatsapp_message(
                customer_phone, "Your cart is empty. Please add items first.", restaurant_id
            )
            session_state["booking_step"] = "awaiting_order"
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}
        session_state["order_from_cart"] = True
        session_state["booking_step"]    = "awaiting_order"
        svc = session_state.get("service_type")
        mp  = session_state.get("manager_phone", manager_phone)
        await enrich_cart_titles(cart, restaurant_id)
        ot  = cart_to_order_text(cart)
        return await _dispatch_to_flow(
            svc, restaurant_id, customer_id, customer_name, customer_phone,
            mp, ot, session_state, table_number,
        )

    # ── stale catalog sub-steps ───────────────────────────────────────────────
    if current_step in ("awaiting_category_selection", "awaiting_item_selection"):
        logger.info(f"[router] stale step {current_step} — re-sending catalog")
        session_state["booking_step"] = "awaiting_order"
        await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
        return {"status": session_state.get("booking_step", "awaiting_order")}

    # ── awaiting_cart_action ──────────────────────────────────────────────────
    if current_step == "awaiting_cart_action":
        action = message.strip().upper()
        if action in ("CART:CONFIRM","CONFIRM","YES","Y","OK","OKAY"):
            cart = session_state.get("cart", {})
            if not cart:
                await send_whatsapp_message(customer_phone, "Your cart is empty. Please add items first.", restaurant_id)
                session_state["booking_step"] = "awaiting_order"
                await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
                return {"status": session_state.get("booking_step", "awaiting_order")}
            session_state["order_from_cart"] = True
            session_state["booking_step"]    = "awaiting_order"
            svc = session_state.get("service_type")
            mp  = session_state.get("manager_phone", manager_phone)
            await enrich_cart_titles(cart, restaurant_id)
            ot  = cart_to_order_text(cart)
            return await _dispatch_to_flow(
                svc, restaurant_id, customer_id, customer_name, customer_phone,
                mp, ot, session_state, table_number,
            )
        elif action in ("CART:ADD_MORE","ADD MORE","ADD","MORE"):
            session_state["booking_step"] = "awaiting_order"
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}
        elif action in ("CART:CLEAR","CLEAR","RESET CART"):
            clear_cart(session_state)
            await send_whatsapp_message(customer_phone, "Cart cleared! 🗑️ Let's start fresh.", restaurant_id)
            session_state["booking_step"] = "awaiting_order"
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}
        else:
            await send_cart_summary_buttons(customer_phone, session_state)
            return {"status": "awaiting_cart_action"}

    # ── awaiting_numbered_order ───────────────────────────────────────────────
    if current_step == "awaiting_numbered_order":
        text = message.strip()
        cat  = session_state.get("current_category")

        if text.upper() in ("DONE", "CONFIRM"):
            cart = session_state.get("cart", {})
            if not cart:
                await send_whatsapp_message(customer_phone, "Your cart is empty. Retrying the menu for you...", restaurant_id)
                session_state["booking_step"] = "awaiting_order"
                await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
                return {"status": session_state.get("booking_step", "awaiting_order")}
            session_state["order_from_cart"] = True
            session_state["booking_step"]    = "awaiting_order"
            svc = session_state.get("service_type")
            mp  = session_state.get("manager_phone", manager_phone)
            await enrich_cart_titles(cart, restaurant_id)
            ot  = cart_to_order_text(cart)
            return await _dispatch_to_flow(
                svc, restaurant_id, customer_id, customer_name, customer_phone,
                mp, ot, session_state, table_number,
            )

        if text.upper() == "MENU":
            session_state["booking_step"] = "awaiting_order"
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        matched = parse_numbered_order(text, cat, session_state)
        if matched:
            for item in matched:
                add_to_cart(session_state, item["id"], item["title"], float(item["price"] // 100))
            summary = cart_summary_text(session_state.get("cart", {}))
            await send_whatsapp_message(
                customer_phone,
                f"✅ Added!\n\n{summary}\n\nReply with more item numbers, *DONE* to place your order, or *MENU* to reopen the full menu.",
                restaurant_id,
            )
        else:
            await send_whatsapp_message(
                customer_phone,
                "Reply with item number(s) e.g. *1 3*, *DONE* to confirm your order, or *MENU* to reopen the full menu.",
                restaurant_id,
            )
        return {"status": "awaiting_numbered_order"}

    # ── Feedback reply interception  (Fix 42) ─────────────────────────────────
    # Handles 1-5 replies sent to Node.js feedback messages when the session
    # is not yet in an explicit feedback step.
    if (
        is_feedback_reply(message)
        and current_step in {
            "awaiting_order", "awaiting_payment",
            "awaiting_table_assignment", "awaiting_special_notes",
        }
        and not session_state.get("order_from_cart")
        and not session_state.get("cart")
    ):
        await send_whatsapp_message(
            customer_phone,
            "Thank you for your rating! 🙏 We hope to see you again soon at Munafe. 😊",
            restaurant_id,
        )
        clear_cart(session_state)
        session_state["booking_step"] = "visit_complete"
        return {"status": "visit_complete"}

    # ── Dispatch to service flows ─────────────────────────────────────────────
    service_type  = session_state.get("service_type")
    manager_phone = session_state.get("manager_phone", manager_phone)
    result = await _dispatch_to_flow(
        service_type, restaurant_id, customer_id, customer_name, customer_phone,
        manager_phone, message, session_state, table_number,
    )
    if result is not None:
        return result

    # Fallback: no service type set — re-send service menu
    raw_greeting = await safe_build_greeting(customer_id, restaurant_id)
    greeting = (
        raw_greeting
        if raw_greeting and raw_greeting.strip().lower() not in _GENERIC_GREETINGS
        else f"Welcome, {customer_name}! 😊"
    )
    await send_service_menu(customer_phone, restaurant_id, greeting, session_state)
    session_state["booking_step"] = "awaiting_service_selection"
    return {"status": "menu_sent"}


async def _dispatch_to_flow(
    service_type: str | None,
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any], table_number: int | None,
) -> Dict[str, Any] | None:
    """Route to the appropriate service flow handler."""
    if service_type == "dine_in":
        return await handle_dine_in_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, message, session_state, table_number,
        )
    elif service_type == "takeaway":
        return await handle_takeaway_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, message, session_state,
        )
    elif service_type == "delivery":
        return await handle_delivery_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, message, session_state,
        )
    elif service_type == "reserve_table":
        return await handle_reserve_table_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, message, session_state,
        )
    return None


# ─────────────────────────────────────────────
# POST-BOOKING
# ─────────────────────────────────────────────

async def handle_booking_completion(
    restaurant_id: str,
    customer_id: str,
    booking_id: str,
    service_type: str,
    total_amount: float,
) -> None:
    try:
        await update_customer_profile(
            customer_id, restaurant_id,
            booking_amount=total_amount,
            service_type=service_type,
        )
        await safe_log_event(
            restaurant_id, customer_id,
            f"booking_{booking_id}",
            "booking_completed", "successful",
            f"Completed {service_type} booking for ₹{total_amount}",
        )
        logger.info(f"Booking {booking_id} completed for customer {customer_id}")
    except Exception as e:
        logger.error(f"Error handling booking completion: {e}")
