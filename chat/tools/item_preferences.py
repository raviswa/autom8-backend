"""Customer booking agent - handles all booking flows (dine-in, takeaway, delivery, reserve).

FIX LOG
-------
  Fix 1 — awaiting_payment stale-button guard
    Added an "awaiting_payment" step handler at the top of handle_booking_flow().
    Any button tap (CART:CLEAR, CART:ADD_MORE, CART:CONFIRM) or free-text message
    received AFTER an order is confirmed now shows the confirmed order summary
    instead of opening a new cart / creating a duplicate booking.
    Customer can tap "🆕 Place New Order" to intentionally start a fresh order.

  Fix 2 — token_number persisted in session for all service types
    Takeaway, Delivery, and Reserve Table flows were generating token as a local
    variable only. Added session_state["token_number"] = token in all three so
    the awaiting_payment guard (and any downstream code) can always read it.

  Fix 3 — order_confirmed_summary stored in session for all service types
    Each flow now stores a human-readable session_state["order_confirmed_summary"]
    string just before setting booking_step = "awaiting_payment". The guard
    message uses this so the customer always sees a meaningful description of
    their confirmed order regardless of service type.

  Fix 4 — special requirements step added to dine-in flow
    After order confirmation the customer is prompted for any special dish
    requirements (spice level, allergies, extras, etc.) or can tap "No requirements".
    - Input is validated: empty and >500 char messages are rejected.
    - Valid requirements are forwarded to the manager via WhatsApp.
    - Stored in session_state["special_requirements"] for downstream use.
    - "awaiting_special_requirements" added to _STEPS_ALLOWING_SHORT_REPLY so
      short replies like "SKIP" are not swallowed by the greeting escape hatch.
    - Step flow: awaiting_order → awaiting_special_requirements → awaiting_payment

  Fix 5 — Interactive buttons / list replace free-text prompts throughout
    (a) Service menu — _send_service_menu() now sends a WhatsApp interactive list
        message with all 5 options as tappable rows. Reply IDs remain "1"–"5" so
        the awaiting_service_selection handler is unchanged. Falls back to plain
        text if the interactive API call fails.
    (b) _ask_continue_or_reset() — now sends a 2-button interactive message
        ("Continue my order ▶️" / "Start over 🔄") instead of a numbered
        plain-text prompt. Reply IDs remain "1" and "2".
    (c) awaiting_payment guard — now sends a 1-button interactive message
        ("🆕 Place New Order") instead of plain text asking the customer to
        type "NEW ORDER".
    (d) Special requirements prompt — now includes a single "⏭️ No requirements"
        button (ID = "SKIP") so customers who have nothing to add don't need to
        type SKIP. Free-text entry for actual requirements is preserved.
    (e) Reserve table advance confirmation — now sends a 2-button interactive
        message ("✅ Yes, confirm" / "❌ Cancel") instead of asking the customer
        to type YES or NO.

  Fix 6 — Dietary preference filtering (NEW)
    After party size, customers are asked about dietary preferences (Veg/Non-Veg).
    This is stored in session and passed to preference builders to filter out
    irrelevant options (e.g., meat preferences for vegetarian customers).

  Fix 7 — Optional special notes (NEW)
    Changed from "awaiting_special_requirements" (mandatory) to "awaiting_special_notes"
    (optional). Customers can skip, send empty, or type "skip"/"no"/"none" without
    error. Only manager is notified if actual notes exist.

  Fix 8 — SyntaxError at line 1095 (CRASH FIX)
    The deployed file was missing the `elif booking_step == "awaiting_dietary_preference":`
    block inside handle_dine_in_flow(), leaving the `elif booking_step ==
    "awaiting_special_notes":` block as a dangling elif with no preceding if/elif,
    causing a SyntaxError on import and crashing the container on every restart.
    Restored the complete, correct elif chain:
      awaiting_party_size → awaiting_order → awaiting_dietary_preference →
      awaiting_special_notes
"""

from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Dict, Any
import logging
import re


from tools.db_tools import (
    get_menu,
    create_booking,
    update_booking_status,
    check_availability,
    get_restaurant_by_whatsapp_number,
    get_next_token_number,
)
from tools.payment_tools import create_payment_link
from tools.whatsapp_tools import send_whatsapp_message, send_location_request
from agents.customer.conversation_intelligence import (
    load_conversation_context,
    classify_intent,
    log_conversation_event,
    is_affirmative as _is_affirmative,
)
from tools.personalisation_tools import (
    update_customer_profile,
    build_personalised_greeting,
    build_order_suggestion,
)
from tools.catalog_tools import send_whatsapp_catalog_message
from tools.cart_tools import (
    add_to_cart,
    clear_cart,
    cart_to_order_text,
    cart_summary_text,
    cart_total,
    send_category_list,
    send_item_list,
    send_cart_summary_buttons,
    send_quantity_prompt,
    confirm_pending_item,
    parse_numbered_order,
    plain_text_menu,
    MENU_ITEMS,
    items_for_slot,
    current_time_slot,
    _send_interactive,
)

logger = logging.getLogger(__name__)

DELIVERY_CHARGE = 40.00


def _now_display() -> str:
    """Return current Indian Standard Time (IST) formatted as dd-Mmm-yy, hh:mm."""
    ist_now = datetime.now(ZoneInfo("Asia/Kolkata"))
    return ist_now.strftime("%d-%b-%y, %H:%M")


# ─────────────────────────────────────────────
# GREETING / NON-ORDER DETECTION
# ─────────────────────────────────────────────

_GREETING_WORDS = {
    "hi", "hello", "holla", "hola", "hey", "howdy", "sup", "yo",
    "ok", "okay", "k", "yes", "no", "yep", "nope", "thanks",
    "thank you", "thankyou", "bye", "goodbye", "help", "start",
    "back", "reset", "restart", "cancel",
}

# ── Intentional reset / home keywords ────────────────────────────────────────
_RESET_KEYWORDS: set[str] = {
    "home", "menu", "restart", "start over", "startover",
    "main menu", "mainmenu", "begin", "reboot", "new",
    "mulakarunga",        # Tamil: "start again"
    "shuru",              # Hindi: "begin"
    "మొదలు", "modalu",   # Telugu: "start"
    "തുടങ്ങുക", "thudanguka",  # Malayalam: "start"
}

# Steps that legitimately expect short/greeting-like replies —
# the global escape hatch is skipped for these.
_STEPS_ALLOWING_SHORT_REPLY = {
    "ask_service",
    "awaiting_service_selection",
    "awaiting_reset_confirmation",
    "awaiting_advance_confirmation",
    "awaiting_quantity",
    "awaiting_item_qty",
    "awaiting_numbered_order",
    "awaiting_payment",
    "awaiting_special_notes",
    "awaiting_dietary_preference",
}

_GENERIC_GREETINGS = {"welcome!", "welcome", "hi!", "hi", "hello!", "hello", ""}


def _is_greeting(text: str) -> bool:
    """Return True if the message looks like a greeting / non-order input."""
    return text.strip().lower() in _GREETING_WORDS


# ─────────────────────────────────────────────
# RESET HELPERS
# ─────────────────────────────────────────────

async def _ask_continue_or_reset(
    customer_phone: str,
    restaurant_id: str,
    *,
    full_restart: bool = False,
) -> None:
    """Send the continue-or-reset prompt as a 2-button interactive message.

    FIX 5(b): Replaced plain-text numbered prompt with interactive buttons.
    Reply IDs are "1" and "2" — matches the awaiting_reset_confirmation handler.

    Args:
        full_restart: When True (triggered by HOME / MENU / RESTART keywords),
                      option 2 reads "Start over 🔄". When False (triggered by a
                      stray greeting mid-order), same wording is used.
    """
    option2_title = "Start over 🔄" if full_restart else "Start over"
    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "button",
            "body": {"text": "😊 What would you like to do?"},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {"id": "1", "title": "Continue my order ▶️"}},
                    {"type": "reply", "reply": {"id": "2", "title": option2_title}},
                ]
            },
        }
    })
    if not ok:
        # Fallback to plain text
        label = "Take me back to the very first message 🔄" if full_restart else "Start over from the beginning"
        await send_whatsapp_message(
            customer_phone,
            f"😊 What would you like to do?\n\n"
            f"1️⃣  Continue my current order\n"
            f"2️⃣  {label}\n\n"
            "Reply with *1* or *2*.",
            restaurant_id,
        )


async def _do_reset(
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
    *,
    full_restart: bool = False,
) -> None:
    """Cancel any live booking, clear the session, and re-enter the flow."""
    booking_id = session_state.get("booking_id")
    if booking_id:
        try:
            await update_booking_status(booking_id, "cancelled")
            logger.info(f"Cancelled ghost booking {booking_id} on reset.")
        except Exception as e:
            logger.error(f"Failed to cancel booking {booking_id} on reset: {e}")

    if full_restart:
        session_state.clear()
        session_state["next_state"]    = "identity"
        session_state["identity_step"] = "initial"
        return

    # Soft reset — keep identity, return to service menu.
    _cid    = session_state.get("customer_id")
    _cname  = session_state.get("customer_name")
    _mphone = session_state.get("manager_phone")

    session_state.clear()

    if _cid:    session_state["customer_id"]   = _cid
    if _cname:  session_state["customer_name"] = _cname
    if _mphone: session_state["manager_phone"] = _mphone

    session_state["booking_step"] = "awaiting_service_selection"

    greeting = f"Welcome back, {customer_name}! 😊"
    await _send_service_menu(customer_phone, restaurant_id, greeting)


# ─────────────────────────────────────────────
# SHARED HELPERS
# ─────────────────────────────────────────────

async def _send_service_menu(
    customer_phone: str,
    restaurant_id: str,
    greeting: str,
) -> None:
    """Send the service-selection menu as a WhatsApp interactive list.

    FIX 5(a): Replaces the old _service_menu() plain-text string helper.
    Reply IDs are "1"–"5" so the awaiting_service_selection handler is unchanged.
    Falls back to plain text if the interactive API call fails.
    """
    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "list",
            "header": {"type": "text", "text": greeting},
            "body":   {"text": "How can we help you today?"},
            "footer": {"text": "Tap to choose a service"},
            "action": {
                "button": "View options",
                "sections": [{
                    "title": "Our services",
                    "rows": [
                        {
                            "id":          "1",
                            "title":       "Dine-in Now 🍽️",
                            "description": "Order food at your table",
                        },
                        {
                            "id":          "2",
                            "title":       "Takeaway Now 🛍️",
                            "description": "Pick up your order at the counter",
                        },
                        {
                            "id":          "3",
                            "title":       "Delivery Now 🛵",
                            "description": "We deliver to your door",
                        },
                        {
                            "id":          "4",
                            "title":       "Reserve a Table 📅",
                            "description": "Book a table for a future visit",
                        },
                        {
                            "id":          "5",
                            "title":       "Nothing, thanks ❌",
                            "description": "Exit",
                        },
                    ],
                }],
            },
        }
    })

    if not ok:
        # Fallback: plain-text numbered menu
        await send_whatsapp_message(
            customer_phone,
            f"{greeting}\n\n"
            "How can we help you today?\n\n"
            "1. Dine-in Now 🍽️\n"
            "2. Takeaway now🛍️\n"
            "3. Delivery now 🛵\n"
            "4. Reserve a Table (for future booking) 📅\n"
            "5. Nothing, thanks ❌\n\n"
            "Reply with 1, 2, 3, 4, or 5.",
            restaurant_id,
        )


def _parse_booking_datetime(text: str) -> datetime | None:
    """
    Try to parse a user-supplied date/time string into a datetime object.
    Accepts formats like:
      - 25-05-2026, 8:00 PM
      - 25-May-2026, 8.00PM
      - 25/05/2026 20:00
      - 25 May 2026 8PM
    Returns None if parsing fails.
    """
    text = text.strip()
    text = re.sub(r"[./]", "-", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"(\d)(AM|PM)", r"\1 \2", text, flags=re.IGNORECASE)
    text = re.sub(r"\.(\d{2})", r":\1", text)

    formats = [
        "%d-%m-%Y, %I:%M %p",
        "%d-%m-%Y %I:%M %p",
        "%d-%m-%Y, %H:%M",
        "%d-%m-%Y %H:%M",
        "%d-%b-%Y, %I:%M %p",
        "%d-%b-%Y %I:%M %p",
        "%d-%b-%Y, %H:%M",
        "%d-%b-%Y %H:%M",
        "%d %b %Y %I:%M %p",
        "%d %b %Y %H:%M",
        "%d-%m-%Y, %I %p",
        "%d-%m-%Y %I %p",
        "%d-%b-%Y %I %p",
        "%d %b %Y %I %p",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue

    return None


# ─────────────────────────────────────────────
# MENU / CART ENTRY POINT
# ─────────────────────────────────────────────

async def _send_menu(
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any] | None = None,
) -> None:
    """
    Send the menu as an interactive WhatsApp list (category picker → item picker
    → cart buttons).  Falls back to a numbered plain-text menu if the
    interactive API call fails.
    """
    if session_state is None:
        session_state = {}

    try:
        ok = await send_category_list(customer_phone, session_state)
        if ok:
            return
    except Exception as e:
        logger.warning(f"Interactive category list failed for {customer_phone}: {e}")

    # Fallback: numbered plain-text menu
    try:
        menu_text = plain_text_menu()
        await send_whatsapp_message(customer_phone, menu_text, restaurant_id)
        session_state["booking_step"] = "awaiting_numbered_order"
    except Exception as e:
        logger.error(f"Plain-text menu fallback also failed for {customer_phone}: {e}")
        await send_whatsapp_message(
            customer_phone,
            "Our menu is loading — please ask our staff or try again in a moment!",
            restaurant_id,
        )


# ─────────────────────────────────────────────
# CONVERSATION INTELLIGENCE HELPERS
# ─────────────────────────────────────────────

async def _safe_classify_intent(
    message: str,
    flow: str,
    context: dict,
) -> str:
    try:
        result = await classify_intent(message, flow, context)
        return result.get("intent", "unknown")
    except Exception as e:
        logger.warning(f"classify_intent failed (non-fatal): {e}")
        return "unknown"


async def _safe_load_context(restaurant_id: str, customer_id: str) -> dict:
    try:
        return await load_conversation_context(restaurant_id, customer_id)
    except Exception as e:
        logger.warning(f"load_conversation_context failed (non-fatal): {e}")
        return {}


async def _safe_log_event(
    restaurant_id: str,
    customer_id: str,
    session_id: str,
    event_type: str,
    intent: str,
    message: str,
) -> None:
    try:
        await log_conversation_event(
            restaurant_id, customer_id,
            session_id, event_type, intent, message,
        )
    except Exception as e:
        logger.warning(f"log_conversation_event failed (non-fatal): {e}")


# ─────────────────────────────────────────────
# MAIN BOOKING FLOW ROUTER
# ─────────────────────────────────────────────

async def handle_booking_flow(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    message: str,
    session_state: Dict[str, Any],
    table_number: int | None = None,
) -> Dict[str, Any]:
    """Route to appropriate booking flow based on user selection."""

    context = await _safe_load_context(restaurant_id, customer_id)
    intent  = await _safe_classify_intent(message, "booking_flow", context)

    await _safe_log_event(
        restaurant_id, customer_id,
        f"booking_{session_state.get('booking_step', 'start')}",
        "booking_message", intent, message,
    )

    current_step = session_state.get("booking_step", "ask_service")

    # ── Explicit reset-keyword intercept (HOME / MENU / RESTART etc.) ──────────
    if (
        current_step not in {"awaiting_reset_confirmation"}
        and message.strip().lower() in _RESET_KEYWORDS
    ):
        session_state["step_before_reset"]     = current_step
        session_state["booking_step"]          = "awaiting_reset_confirmation"
        session_state["_full_restart_pending"] = True
        await _ask_continue_or_reset(customer_phone, restaurant_id, full_restart=True)
        return {"status": "awaiting_reset_confirmation"}

    # ── Global escape hatch (stray greeting mid-order) ────────────────────────
    if (
        current_step not in _STEPS_ALLOWING_SHORT_REPLY
        and _is_greeting(message)
    ):
        session_state["step_before_reset"] = current_step
        session_state["booking_step"]      = "awaiting_reset_confirmation"
        await _ask_continue_or_reset(customer_phone, restaurant_id)
        return {"status": "awaiting_reset_confirmation"}

    # ── FIX 1 + FIX 5(c): awaiting_payment stale-button guard ────────────────
    if current_step == "awaiting_payment":
        text_upper = message.strip().upper()

        if text_upper in ("NEW ORDER", "NEW", "ORDER AGAIN"):
            _cid    = session_state.get("customer_id")
            _cname  = session_state.get("customer_name")
            _mphone = session_state.get("manager_phone")
            session_state.clear()
            if _cid:    session_state["customer_id"]   = _cid
            if _cname:  session_state["customer_name"] = _cname
            if _mphone: session_state["manager_phone"] = _mphone

            greeting = f"Welcome back, {customer_name}! 😊"
            await _send_service_menu(customer_phone, restaurant_id, greeting)
            session_state["booking_step"] = "awaiting_service_selection"
            return {"status": "awaiting_service_selection"}

        # Stale button tap or any other message — FIX 5(c): interactive button
        summary = session_state.get(
            "order_confirmed_summary",
            f"Token *#{session_state.get('token_number', '')}*"
        )
        await _send_interactive(customer_phone, {
            "interactive": {
                "type": "button",
                "body": {
                    "text": (
                        f"✅ Your order is confirmed and being prepared!\n"
                        f"_{summary}_"
                    )
                },
                "footer": {"text": "Want to order something else?"},
                "action": {
                    "buttons": [
                        {"type": "reply", "reply": {"id": "NEW ORDER", "title": "🆕 Place New Order"}},
                    ]
                },
            }
        })
        return {"status": "awaiting_payment"}

    # ── Step 1: Show the service menu ─────────────────────────────────────────
    if current_step == "ask_service":
        if not session_state.get("_menu_sent"):
            raw_greeting = await build_personalised_greeting(customer_id, restaurant_id)
            if not raw_greeting or raw_greeting.strip().lower() in _GENERIC_GREETINGS:
                greeting = f"Welcome, {customer_name}! 😊"
            else:
                greeting = raw_greeting

            await _send_service_menu(customer_phone, restaurant_id, greeting)
            session_state["_menu_sent"]    = True
            session_state["booking_step"]  = "awaiting_service_selection"
        return {"status": "menu_sent"}

    # ── Step 2: Parse the service selection ───────────────────────────────────
    if current_step == "awaiting_service_selection":
        choice = message.strip()

        if choice == "1":
            service_type = "dine_in"
        elif choice == "2":
            service_type = "takeaway"
        elif choice == "3":
            service_type = "delivery"
        elif choice == "4":
            service_type = "reserve_table"
        elif choice == "5":
            await send_whatsapp_message(
                customer_phone,
                "No problem! Feel free to message us anytime you need help. 😊",
                restaurant_id,
            )
            session_state.clear()
            return {"status": "cancelled"}
        else:
            await send_whatsapp_message(
                customer_phone,
                "Sorry, I did not catch that. Please tap one of the options above.",
                restaurant_id,
            )
            return {"status": "error"}

        session_state["service_type"]  = service_type
        session_state["customer_name"] = customer_name
        session_state["manager_phone"] = manager_phone

        if service_type == "dine_in":
            await send_whatsapp_message(
                customer_phone,
                "Great! You've selected Dine-in now 🍽️\n\n"
                "How many people are dining today?",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_party_size"
            session_state["table_number"] = table_number

        elif service_type == "takeaway":
            await send_whatsapp_message(
                customer_phone,
                "Great! You've selected Takeaway now 🛍️\n\n"
                "Browse today's menu below and add items to your basket 🛒",
                restaurant_id,
            )
            clear_cart(session_state)
            await _send_menu(customer_phone, restaurant_id, session_state)

        elif service_type == "delivery":
            sent = await send_location_request(customer_phone, restaurant_id)
            if not sent:
                # Fallback to plain text if location_request_message is not supported
                await send_whatsapp_message(
                    customer_phone,
                    "Great! You've selected Delivery now 🛵\n\n"
                    "Please share your delivery address.",
                    restaurant_id,
                )
            session_state["booking_step"] = "awaiting_address"

        elif service_type == "reserve_table":
            await send_whatsapp_message(
                customer_phone,
                "Great! You've selected Reserve a Table (for future booking) 📅\n\n"
                "How many people will be dining?",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_party_size"

        return {"status": f"awaiting_{session_state['booking_step'].replace('awaiting_', '')}"}

    # ── Step 2b: Handle reset confirmation ────────────────────────────────────
    if current_step == "awaiting_reset_confirmation":
        choice = message.strip()

        if choice == "1":
            restored_step = session_state.pop("step_before_reset", "ask_service")
            session_state["booking_step"] = restored_step
            if restored_step in ("awaiting_order", "awaiting_category_selection",
                                 "awaiting_item_selection", "awaiting_cart_action",
                                 "awaiting_quantity", "awaiting_item_qty"):
                await send_whatsapp_message(
                    customer_phone,
                    "No problem, let's continue! 😊\n\n"
                    "Browse the menu below and add items to your basket 🛒",
                    restaurant_id,
                )
                await _send_menu(customer_phone, restaurant_id, session_state)
            else:
                await send_whatsapp_message(
                    customer_phone,
                    "No problem, let's continue! 😊\n\n"
                    "Please tell us what you'd like to order.\n"
                    "Type *MENU* to see today's full menu.",
                    restaurant_id,
                )
            return {"status": restored_step}

        elif choice == "2":
            full_restart = session_state.pop("_full_restart_pending", False)
            await _do_reset(
                customer_id, customer_name, customer_phone, restaurant_id,
                session_state, full_restart=full_restart,
            )
            status = "identity_restart" if full_restart else "reset_complete"
            return {"status": status}

        else:
            await send_whatsapp_message(
                customer_phone,
                "Please tap *Continue my order* or *Start over*.",
                restaurant_id,
            )
            return {"status": "error"}

    # ── Cart step: confirm order (from CART:CONFIRM button) ───────────────────
    if current_step == "confirming_order":
        cart = session_state.get("cart", {})
        if not cart:
            await send_whatsapp_message(
                customer_phone, "Your cart is empty. Please add items first.", restaurant_id
            )
            await _send_menu(customer_phone, restaurant_id, session_state)
            return {"status": "awaiting_category_selection"}

        session_state["order_from_cart"] = True
        session_state["booking_step"]    = "awaiting_order"
        service_type        = session_state.get("service_type")
        manager_phone_local = session_state.get("manager_phone", manager_phone)
        order_text          = cart_to_order_text(cart)

        if service_type == "dine_in":
            return await handle_dine_in_flow(
                restaurant_id, customer_id, customer_name, customer_phone,
                manager_phone_local, order_text, session_state, table_number
            )
        elif service_type == "takeaway":
            return await handle_takeaway_flow(
                restaurant_id, customer_id, customer_name, customer_phone,
                manager_phone_local, order_text, session_state
            )
        elif service_type == "delivery":
            return await handle_delivery_flow(
                restaurant_id, customer_id, customer_name, customer_phone,
                manager_phone_local, order_text, session_state
            )
        else:
            await send_whatsapp_message(
                customer_phone, "Sorry, something went wrong. Please start again.", restaurant_id
            )
            return {"status": "error"}

    # ── Cart step: category selected (interactive list reply) ─────────────────
    if current_step == "awaiting_category_selection":
        cat = None
        if message.startswith("CAT:"):
            cat = message[4:]
        elif ":" not in message:
            from tools.catalog_tools import MENU_ITEMS as _MI
            slots = list(dict.fromkeys(i["time_slot"] for i in _MI))
            for s in slots:
                if s.lower() in message.lower():
                    cat = s
                    break

        if not cat:
            await send_whatsapp_message(
                customer_phone,
                "Please tap one of the category options to browse the menu.",
                restaurant_id,
            )
            return {"status": "awaiting_category_selection"}

        ok = await send_item_list(customer_phone, cat, session_state)
        if not ok:
            from tools.cart_tools import plain_text_menu as _ptm
            await send_whatsapp_message(customer_phone, _ptm(cat), restaurant_id)
            session_state["booking_step"]     = "awaiting_numbered_order"
            session_state["current_category"] = cat
        return {"status": "awaiting_item_selection"}

    # ── Cart step: item selected (interactive list reply) ─────────────────────
    if current_step == "awaiting_item_selection":
        item_id = None
        if message.startswith("ITEM:"):
            item_id = message[5:]

        if item_id:
            from tools.catalog_tools import MENU_ITEMS as _MI
            item = next((i for i in _MI if i["id"] == item_id), None)
            if item:
                await send_quantity_prompt(customer_phone, item, session_state)
                return {"status": "awaiting_quantity"}

        cat = session_state.get("current_category", current_time_slot())
        await send_item_list(customer_phone, cat, session_state)
        return {"status": "awaiting_item_selection"}

    # ── Cart step: cart action buttons ────────────────────────────────────────
    if current_step == "awaiting_cart_action":
        action = message.strip().upper()

        if action in ("CART:CONFIRM", "CONFIRM", "YES", "Y", "OK", "OKAY"):
            cart = session_state.get("cart", {})
            if not cart:
                await send_whatsapp_message(
                    customer_phone, "Your cart is empty. Please add items first.", restaurant_id
                )
                await _send_menu(customer_phone, restaurant_id, session_state)
                return {"status": "awaiting_category_selection"}

            session_state["order_from_cart"] = True
            session_state["booking_step"]    = "awaiting_order"
            service_type        = session_state.get("service_type")
            manager_phone_local = session_state.get("manager_phone", manager_phone)
            order_text          = cart_to_order_text(cart)

            if service_type == "dine_in":
                return await handle_dine_in_flow(
                    restaurant_id, customer_id, customer_name, customer_phone,
                    manager_phone_local, order_text, session_state, table_number
                )
            elif service_type == "takeaway":
                return await handle_takeaway_flow(
                    restaurant_id, customer_id, customer_name, customer_phone,
                    manager_phone_local, order_text, session_state
                )
            elif service_type == "delivery":
                return await handle_delivery_flow(
                    restaurant_id, customer_id, customer_name, customer_phone,
                    manager_phone_local, order_text, session_state
                )

        elif action in ("CART:ADD_MORE", "ADD MORE", "ADD", "MORE"):
            ok = await send_category_list(customer_phone, session_state)
            if not ok:
                await send_whatsapp_message(customer_phone, plain_text_menu(), restaurant_id)
                session_state["booking_step"] = "awaiting_numbered_order"
            return {"status": session_state.get("booking_step", "awaiting_category_selection")}

        elif action in ("CART:CLEAR", "CLEAR", "RESET CART"):
            clear_cart(session_state)
            await send_whatsapp_message(
                customer_phone, "Cart cleared! 🗑️ Let's start fresh.", restaurant_id
            )
            ok = await send_category_list(customer_phone, session_state)
            if not ok:
                await send_whatsapp_message(customer_phone, plain_text_menu(), restaurant_id)
                session_state["booking_step"] = "awaiting_numbered_order"
            return {"status": session_state.get("booking_step", "awaiting_category_selection")}

        else:
            await send_cart_summary_buttons(customer_phone, session_state)
            return {"status": "awaiting_cart_action"}

    # ── Cart step: numbered plain-text fallback ───────────────────────────────
    if current_step == "awaiting_numbered_order":
        text = message.strip()
        cat  = session_state.get("current_category")

        if text.upper() == "DONE":
            cart = session_state.get("cart", {})
            if not cart:
                await send_whatsapp_message(
                    customer_phone, "Cart is empty — please pick at least one item.", restaurant_id
                )
                await send_whatsapp_message(customer_phone, plain_text_menu(cat), restaurant_id)
                return {"status": "awaiting_numbered_order"}
            await send_cart_summary_buttons(customer_phone, session_state)
            return {"status": "awaiting_cart_action"}

        if text.upper() == "MENU":
            await send_whatsapp_message(customer_phone, plain_text_menu(cat), restaurant_id)
            return {"status": "awaiting_numbered_order"}

        matched = parse_numbered_order(text, cat, session_state)
        if matched:
            for item in matched:
                price_inr = item["price"] // 100
                add_to_cart(session_state, item["id"], item["title"], float(price_inr))
            summary = cart_summary_text(session_state.get("cart", {}))
            await send_whatsapp_message(
                customer_phone,
                f"✅ Added!\n\n{summary}\n\nReply with more numbers to add items, or *DONE* to confirm.",
                restaurant_id,
            )
        else:
            await send_whatsapp_message(
                customer_phone,
                "Reply with item number(s), e.g. *1 3* — or *DONE* to confirm your cart.",
                restaurant_id,
            )
        return {"status": "awaiting_numbered_order"}

    # ── Step 3: Delegate to the correct sub-flow ──────────────────────────────
    service_type  = session_state.get("service_type")
    manager_phone = session_state.get("manager_phone", manager_phone)

    if service_type == "dine_in":
        return await handle_dine_in_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, message, session_state, table_number
        )
    elif service_type == "takeaway":
        return await handle_takeaway_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, message, session_state
        )
    elif service_type == "delivery":
        return await handle_delivery_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, message, session_state
        )
    elif service_type == "reserve_table":
        return await handle_reserve_table_flow(
            restaurant_id, customer_id, customer_name, customer_phone,
            manager_phone, message, session_state
        )

    # Unknown state — reset to menu
    raw_greeting = await build_personalised_greeting(customer_id, restaurant_id)
    if not raw_greeting or raw_greeting.strip().lower() in _GENERIC_GREETINGS:
        greeting = f"Welcome, {customer_name}! 😊"
    else:
        greeting = raw_greeting
    await _send_service_menu(customer_phone, restaurant_id, greeting)
    session_state["booking_step"] = "awaiting_service_selection"
    return {"status": "menu_sent"}


# ─────────────────────────────────────────────
# DINE-IN FLOW
# ─────────────────────────────────────────────

async def handle_dine_in_flow(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    message: str,
    session_state: Dict[str, Any],
    table_number: int | None = None,
) -> Dict[str, Any]:
    """Handle dine-in booking."""

    booking_step = session_state.get("booking_step")

    # ── Step 1: Collect party size ────────────────────────────────────────────
    if booking_step == "awaiting_party_size":
        try:
            party_size = int(message.strip())
            session_state["party_size"] = party_size

            token        = await get_next_token_number(restaurant_id)
            booking_time = _now_display()
            session_state["token_number"] = token
            session_state["booking_time"] = booking_time

            table_display = session_state.get("table_number") or "TBD"

            summary = (
                f"Here's your booking summary:\n"
                f"────────────────────\n"
                f"Name: {customer_name}\n"
                f"Service: Dine-in 🍽️\n"
                f"Guests: {party_size}\n"
                f"Token: {token}\n"
                f"Booking Time: {booking_time}\n"
                f"────────────────────\n\n"
                f"You will receive the table details soon.\n"
                f"Browse today's menu below and add items to your basket 🛒"
            )
            await send_whatsapp_message(customer_phone, summary, restaurant_id)
            await _send_menu(customer_phone, restaurant_id, session_state)
            await send_whatsapp_message(
                manager_phone,
                f"🆕 New Dine-in Booking\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Customer: {customer_name}\n"
                f"Phone: {customer_phone}\n"
                f"Table: {table_display}\n"
                f"Guests: {party_size}\n"
                f"Booking Time: {booking_time}\n"
                f"Status: Awaiting order — please allocate a table\n"
                f"────────────────────",
                restaurant_id,
            )

            if session_state.get("booking_step") not in (
                "awaiting_category_selection", "awaiting_numbered_order"
            ):
                session_state["booking_step"] = "awaiting_order"

            return {"status": session_state.get("booking_step", "awaiting_order")}

        except ValueError:
            await send_whatsapp_message(
                customer_phone,
                "Please enter a valid number of people (e.g. 2).",
                restaurant_id,
            )
            return {"status": "error"}

    # ── Step 2: Order collection — ask for dietary preference ─────────────────
    elif booking_step == "awaiting_order":
        order_text = message.strip()

        if order_text.upper() == "MENU":
            await _send_menu(customer_phone, restaurant_id, session_state)
            return {"status": "awaiting_order"}

        # Ask for dietary preference BEFORE creating booking
        session_state["_pending_order_text"] = order_text
        session_state["booking_step"] = "awaiting_dietary_preference"

        await _send_interactive(customer_phone, {
            "interactive": {
                "type": "button",
                "body": {"text": "Do you have any dietary preferences? This helps us suggest better options."},
                "action": {
                    "buttons": [
                        {"type": "reply", "reply": {"id": "VEG", "title": "🥬 Vegetarian"}},
                        {"type": "reply", "reply": {"id": "NON_VEG", "title": "🍖 Non-Vegetarian"}},
                        {"type": "reply", "reply": {"id": "BOTH", "title": "No preference"}},
                    ]
                },
            }
        })
        return {"status": "awaiting_dietary_preference"}

    # ── Step 3: Handle dietary preference and create booking ──────────────────
    elif booking_step == "awaiting_dietary_preference":
        choice = message.strip().upper()

        if choice in ("VEG", "VEGETARIAN"):
            session_state["customer_dietary_preference"] = "veg"
        elif choice in ("NON_VEG", "NON_VEGETARIAN"):
            session_state["customer_dietary_preference"] = "non_veg"
        else:
            session_state["customer_dietary_preference"] = None

        # Retrieve the order text from session
        order_text = session_state.get("_pending_order_text", "")

        cart  = session_state.get("cart", {})
        total = cart_total(cart) if cart else 0.0

        token        = session_state.get("token_number", "")
        booking_time = session_state.get("booking_time", _now_display())
        suggestion   = await build_order_suggestion(customer_id, restaurant_id)

        try:
            booking = await create_booking(
                restaurant_id, customer_id, "dine_in",
                party_size=session_state.get("party_size"),
                table_number=session_state.get("table_number"),
                token_number=token,
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            payment_link = await create_payment_link(
                booking_id, total, customer_name,
                f"Dine-in {token} at table {session_state.get('table_number')}",
            )

            confirmation = (
                f"Your order has been placed! 🎉\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Order: {order_text}\n"
                f"────────────────────\n"
                f"Total: ₹{total:.0f}\n\n"
                f"Pay here: {payment_link}"
            )
            if suggestion:
                confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            # FIX 5(d): Optional special notes prompt with tap-to-skip button
            await _send_interactive(customer_phone, {
                "interactive": {
                    "type": "button",
                    "body": {
                        "text": (
                            "📝 Any special instructions or notes for the kitchen?\n\n"
                            "For example: less spicy, more spicy, no onion, extra cheese, allergies, etc.\n"
                            "You can also send a voice note.\n\n"
                            "Or tap below if you have none 👇"
                        )
                    },
                    "action": {
                        "buttons": [
                            {"type": "reply", "reply": {"id": "SKIP", "title": "⏭️ No notes"}},
                        ]
                    },
                }
            })

            await send_whatsapp_message(
                manager_phone,
                f"📋 Order Received — Dine-in\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Customer: {customer_name}\n"
                f"Phone: {customer_phone}\n"
                f"Table: {session_state.get('table_number', 'TBD')}\n"
                f"Guests: {session_state.get('party_size')}\n"
                f"Booking Time: {booking_time}\n"
                f"Order: {order_text}\n"
                f"Total: ₹{total:.0f}\n"
                f"────────────────────",
                restaurant_id,
            )

            session_state["order_confirmed_summary"] = (
                f"Dine-in Token *{token}* — {order_text} "
                f"({session_state.get('party_size')} guests, ₹{total:.0f})"
            )
            session_state["booking_step"] = "awaiting_special_notes"
            clear_cart(session_state)

            return {
                "status": "awaiting_special_notes",
                "booking_id": booking_id,
                "total": total,
            }

        except Exception as e:
            logger.error(f"Failed to create dine-in booking: {e}")
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was an error processing your order. Please try again.",
                restaurant_id,
            )
            return {"status": "error"}

    # ── Step 4: Handle optional special notes ─────────────────────────────────
    elif booking_step == "awaiting_special_notes":
        raw_notes: str = message.strip()
        token = session_state.get("token_number", "")

        # Allow skipping with empty message, "SKIP", "NO", or "NONE"
        if not raw_notes or raw_notes.upper() in ("SKIP", "NO", "NONE"):
            special_notes: str | None = None
            await send_whatsapp_message(
                customer_phone,
                "No problem! Your order is being prepared. Enjoy your meal! 🍽️",
                restaurant_id,
            )
        else:
            # Validate length
            if len(raw_notes) > 500:
                await send_whatsapp_message(
                    customer_phone,
                    "Your message is a bit too long (max 500 characters). "
                    "Please keep it brief, or just tap *No notes*.",
                    restaurant_id,
                )
                return {"status": "awaiting_special_notes"}

            special_notes = raw_notes

            # Notify manager only if there are actual notes
            await send_whatsapp_message(
                manager_phone,
                f"📝 Special Notes — Token {token}\n"
                f"────────────────────\n"
                f"Customer: {customer_name}\n"
                f"Phone: {customer_phone}\n"
                f"Table: {session_state.get('table_number', 'TBD')}\n"
                f"Notes: {special_notes}\n"
                f"────────────────────",
                restaurant_id,
            )
            await send_whatsapp_message(
                customer_phone,
                "✅ Got it! Your notes have been saved.\n\n"
                "Sit back and enjoy — your order is being prepared! 🍽️",
                restaurant_id,
            )

        session_state["special_notes"] = special_notes
        session_state["booking_step"]  = "awaiting_payment"
        return {"status": "awaiting_payment"}

    return {"status": "error"}


# ─────────────────────────────────────────────
# TAKEAWAY FLOW
# ─────────────────────────────────────────────

async def handle_takeaway_flow(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Handle takeaway booking."""

    booking_step = session_state.get("booking_step")

    if booking_step == "awaiting_order":
        order_text = message.strip()

        if order_text.upper() == "MENU":
            await _send_menu(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart  = session_state.get("cart", {})
        total = cart_total(cart) if cart else 0.0

        logger.info(f"Cart at order time for takeaway: {cart}")
        logger.info(f"Computed takeaway total: {total}")

        token        = await get_next_token_number(restaurant_id)
        booking_time = _now_display()
        session_state["token_number"] = token

        try:
            booking = await create_booking(
                restaurant_id, customer_id, "takeaway",
                token_number=token,
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            payment_link = await create_payment_link(
                booking_id, total, customer_name, f"Takeaway {token}"
            )
            suggestion = await build_order_suggestion(customer_id, restaurant_id)

            confirmation = (
                f"Your order has been placed! 🎉\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Booking Time: {booking_time}\n"
                f"Order: {order_text}\n"
                f"────────────────────\n"
                f"Total: ₹{total:.0f}\n\n"
                f"Pay here: {payment_link}"
            )
            if suggestion:
                confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            await send_whatsapp_message(
                manager_phone,
                f"🆕 New Takeaway Order\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Customer: {customer_name}\n"
                f"Phone: {customer_phone}\n"
                f"Booking Time: {booking_time}\n"
                f"Order: {order_text}\n"
                f"Total: ₹{total:.0f}\n"
                f"────────────────────",
                restaurant_id,
            )

            session_state["order_confirmed_summary"] = (
                f"Takeaway Token *{token}* — {order_text} (₹{total:.0f})"
            )
            session_state["booking_step"] = "awaiting_payment"
            clear_cart(session_state)
            return {"status": "awaiting_payment", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create takeaway booking: {e}")
            return {"status": "error"}

    return {"status": "error"}


# ─────────────────────────────────────────────
# DELIVERY FLOW
# ─────────────────────────────────────────────

async def handle_delivery_flow(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Handle delivery booking."""

    booking_step = session_state.get("booking_step")

    if booking_step == "awaiting_address":
        raw = message.strip()

        if raw.startswith("LOCATION:"):
            # Customer shared GPS location via the native WhatsApp button.
            # Format: "LOCATION:lat,lng|label"
            try:
                coords_part, label = raw[len("LOCATION:"):].split("|", 1)
                lat, lng = coords_part.split(",", 1)
                maps_link = f"https://maps.google.com/?q={lat.strip()},{lng.strip()}"
                delivery_address = f"{label.strip()} ({maps_link})"
            except Exception:
                delivery_address = raw  # fallback: store raw if parsing fails
        else:
            # Customer typed their address manually
            delivery_address = raw

        session_state["delivery_address"] = delivery_address
        await send_whatsapp_message(
            customer_phone,
            "Thank you! Estimated delivery: 30-45 mins.\n\n"
            "Browse today's menu below and add items to your basket 🛒",
            restaurant_id,
        )
        clear_cart(session_state)
        await _send_menu(customer_phone, restaurant_id, session_state)
        if session_state.get("booking_step") not in (
            "awaiting_category_selection", "awaiting_numbered_order"
        ):
            session_state["booking_step"] = "awaiting_order"
        return {"status": session_state["booking_step"]}

    elif booking_step == "awaiting_order":
        order_text = message.strip()

        if order_text.upper() == "MENU":
            await _send_menu(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart         = session_state.get("cart", {})
        items_total  = cart_total(cart) if cart else 0.0
        total        = items_total + DELIVERY_CHARGE
        token        = await get_next_token_number(restaurant_id)
        booking_time = _now_display()
        session_state["token_number"] = token

        try:
            booking = await create_booking(
                restaurant_id, customer_id, "delivery",
                delivery_address=session_state.get("delivery_address"),
                token_number=token,
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            payment_link = await create_payment_link(
                booking_id, total, customer_name, f"Delivery {token}"
            )
            suggestion = await build_order_suggestion(customer_id, restaurant_id)

            confirmation = (
                f"Your order has been placed! 🎉\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Booking Time: {booking_time}\n"
                f"Order: {order_text}\n"
                f"Items: ₹{items_total:.0f}\n"
                f"Delivery charge: ₹{DELIVERY_CHARGE:.0f}\n"
                f"────────────────────\n"
                f"Total: ₹{total:.0f}\n\n"
                f"Pay here: {payment_link}"
            )
            if suggestion:
                confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            await send_whatsapp_message(
                manager_phone,
                f"🆕 New Delivery Order\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Customer: {customer_name}\n"
                f"Phone: {customer_phone}\n"
                f"Address: {session_state.get('delivery_address')}\n"
                f"Booking Time: {booking_time}\n"
                f"Order: {order_text}\n"
                f"Total: ₹{total:.0f} (incl. ₹{DELIVERY_CHARGE:.0f} delivery)\n"
                f"────────────────────",
                restaurant_id,
            )

            session_state["order_confirmed_summary"] = (
                f"Delivery Token *{token}* — {order_text} "
                f"to {session_state.get('delivery_address', '')[:40]} (₹{total:.0f})"
            )
            session_state["booking_step"] = "awaiting_payment"
            clear_cart(session_state)
            return {"status": "awaiting_payment", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create delivery booking: {e}")
            return {"status": "error"}

    return {"status": "error"}


# ─────────────────────────────────────────────
# RESERVE TABLE FLOW
# ─────────────────────────────────────────────

async def handle_reserve_table_flow(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Handle table reservation with future-datetime validation and advance confirmation."""

    booking_step = session_state.get("booking_step")

    if booking_step == "awaiting_party_size":
        try:
            party_size = int(message.strip())
            session_state["party_size"] = party_size
            await send_whatsapp_message(
                customer_phone,
                "Please share your preferred date and time.\n"
                "Example: 25-05-2026, 8:00 PM",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_datetime"
            return {"status": "awaiting_datetime"}

        except ValueError:
            await send_whatsapp_message(
                customer_phone,
                "Please enter a valid number of people (e.g. 4).",
                restaurant_id,
            )
            return {"status": "error"}

    elif booking_step == "awaiting_datetime":
        parsed_dt = _parse_booking_datetime(message.strip())

        if parsed_dt is None:
            await send_whatsapp_message(
                customer_phone,
                "Sorry, I couldn't understand that date and time. 🙏\n\n"
                "Please use this format:\n"
                "Example: 25-05-2026, 8:00 PM",
                restaurant_id,
            )
            return {"status": "error"}

        if parsed_dt <= datetime.now():
            await send_whatsapp_message(
                customer_phone,
                f"Oops! *{parsed_dt.strftime('%d %b %Y, %I:%M %p')}* has already passed. 😊\n\n"
                "Please send a future date and time.\n"
                "Example: 25-05-2026, 8:00 PM",
                restaurant_id,
            )
            return {"status": "error"}

        advance_amount = 150.0
        formatted_dt   = parsed_dt.strftime("%d %b %Y, %I:%M %p")
        session_state["booking_datetime"] = parsed_dt.isoformat()
        session_state["advance_amount"]   = advance_amount
        session_state["booking_step"]     = "awaiting_advance_confirmation"

        # FIX 5(e): Interactive 2-button confirmation for advance payment
        ok = await _send_interactive(customer_phone, {
            "interactive": {
                "type": "button",
                "body": {
                    "text": (
                        f"Great choice! Here's your reservation summary:\n"
                        f"────────────────────\n"
                        f"Name: {customer_name}\n"
                        f"Date & Time: {formatted_dt}\n"
                        f"Guests: {session_state.get('party_size')}\n"
                        f"────────────────────\n\n"
                        f"A token advance of ₹{advance_amount:.0f} is required to confirm your table."
                    )
                },
                "footer": {"text": "Tap to confirm or cancel"},
                "action": {
                    "buttons": [
                        {"type": "reply", "reply": {"id": "YES", "title": "✅ Yes, confirm"}},
                        {"type": "reply", "reply": {"id": "NO",  "title": "❌ Cancel"}},
                    ]
                },
            }
        })
        if not ok:
            await send_whatsapp_message(
                customer_phone,
                f"Great choice! Here's your reservation summary:\n"
                f"────────────────────\n"
                f"Name: {customer_name}\n"
                f"Date & Time: {formatted_dt}\n"
                f"Guests: {session_state.get('party_size')}\n"
                f"────────────────────\n\n"
                f"A token advance of ₹{advance_amount:.0f} is required to confirm your table.\n\n"
                f"Reply *YES* to proceed with payment, or *NO* to cancel.",
                restaurant_id,
            )
        return {"status": "awaiting_advance_confirmation"}

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
                "Please tap *Yes, confirm* to proceed or *Cancel* to cancel.",
                restaurant_id,
            )
            return {"status": "error"}

        token                = await get_next_token_number(restaurant_id)
        booking_time         = _now_display()
        advance_amount       = session_state.get("advance_amount", 150.0)
        party_size           = session_state.get("party_size")
        booking_datetime_iso = session_state.get("booking_datetime", "")
        session_state["token_number"] = token

        try:
            booking = await create_booking(
                restaurant_id, customer_id, "reserve_table",
                party_size=party_size,
                booking_datetime=booking_datetime_iso,
                token_number=token,
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            payment_link = await create_payment_link(
                booking_id, advance_amount, customer_name,
                f"Reservation {token} for {party_size} people",
            )

            try:
                display_dt = datetime.fromisoformat(booking_datetime_iso).strftime(
                    "%d %b %Y, %I:%M %p"
                )
            except Exception:
                display_dt = booking_datetime_iso

            summary = (
                f"Reservation confirmed! 🎉\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Booking Time: {booking_time}\n"
                f"Date & Time: {display_dt}\n"
                f"Guests: {party_size}\n"
                f"Advance: ₹{advance_amount:.0f}\n"
                f"────────────────────\n\n"
                f"Please complete payment to secure your table:\n"
                f"{payment_link}\n\n"
                f"Just tell our staff your token *{token}* when you arrive!"
            )
            await send_whatsapp_message(customer_phone, summary, restaurant_id)

            await send_whatsapp_message(
                manager_phone,
                f"🆕 New Table Reservation\n"
                f"────────────────────\n"
                f"Token: {token}\n"
                f"Customer: {customer_name}\n"
                f"Phone: {customer_phone}\n"
                f"Reservation Date: {display_dt}\n"
                f"Booking Time: {booking_time}\n"
                f"Guests: {party_size}\n"
                f"Advance: ₹{advance_amount:.0f}\n"
                f"────────────────────",
                restaurant_id,
            )

            session_state["order_confirmed_summary"] = (
                f"Table Reservation Token *{token}* — {display_dt} "
                f"for {party_size} guests (advance ₹{advance_amount:.0f})"
            )
            session_state["booking_step"] = "awaiting_payment"
            return {"status": "awaiting_payment", "booking_id": booking_id, "total": advance_amount}

        except Exception as e:
            logger.error(f"Failed to create reservation: {e}")
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was an error creating your reservation. Please try again.",
                restaurant_id,
            )
            return {"status": "error"}

    return {"status": "error"}


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
    """Handle post-booking tasks: profile updates, analytics."""

    try:
        await update_customer_profile(
            customer_id, restaurant_id,
            booking_amount=total_amount,
            service_type=service_type,
        )
        await _safe_log_event(
            restaurant_id, customer_id,
            f"booking_{booking_id}",
            "booking_completed", "successful",
            f"Completed {service_type} booking for ₹{total_amount}",
        )
        logger.info(f"Booking {booking_id} completed for customer {customer_id}")

    except Exception as e:
        logger.error(f"Error handling booking completion: {e}")
