"""Root coordinator agent - routes customer vs manager requests.

FIX LOG
-------
  Fix 1 — _make_message_dict() did not recognise the new button ID namespaces
           introduced across all agents after the button migration:

           Identity agent:
             identity_new_confirm_yes / identity_new_confirm_edit
             identity_ret_confirm_yes / identity_ret_confirm_edit

           Cart tools (quantity + done-or-more):
             QTY:1  QTY:2  QTY:3
             CART:SHOW_SUMMARY

           Conversation intelligence (fallback intents):
             CANCEL:CONFIRM  CANCEL:ABORT
             MODIFY:CLEAR_REORDER  MODIFY:CHANGE_QTY
             COMPLAINT:CONTINUE

           Fix: _make_message_dict() now has explicit prefix/value checks for
           all known button namespaces, so every reply reaching route_message()
           is reconstructed as the correct interactive dict shape.

  Fix 2 — New button IDs from conversation_intelligence (CANCEL:CONFIRM,
           CANCEL:ABORT, MODIFY:CLEAR_REORDER, MODIFY:CHANGE_QTY,
           COMPLAINT:CONTINUE) were not routed anywhere after reconstruction.
           They fell through to handle_booking_flow() which ignored them.
           Fix: added _handle_fallback_button() which is called in the cart
           pre-router block when one of these IDs is detected, translating the
           button tap back into a session action (cancel, restore, clear+reorder,
           continue) before handle_booking_flow() sees it.

  Fix 3 — identity_step "awaiting_name_text" (added in the button migration of
           identity_agent) was not included in the identity guard condition, so
           a customer who tapped "Enter my name" and was prompted to type their
           name would be misrouted to the booking agent on their text reply.
           Fix: added "awaiting_name_text" to the identity_step guard set.
"""

from typing import Dict, Any
import logging
import time

from agents.customer.identity_agent import handle_identity_flow
from agents.customer.booking_agent import handle_booking_flow
from agents.manager.commands_agent import parse_manager_command
from tools.cart_tools import (
    handle_incoming_message,
    clear_cart,
    send_category_list,
    send_cart_summary_buttons,
)
from tools.whatsapp_tools import send_whatsapp_message

logger = logging.getLogger(__name__)

# In-memory dedup cache: maps wamid → timestamp
_SEEN: dict[str, float] = {}
_DEDUP_TTL = 120  # seconds

# Identity steps that keep routing to identity_agent (including new text-entry step)
_IDENTITY_STEPS_IN_PROGRESS = {
    "awaiting_name",
    "awaiting_name_confirm",
    "awaiting_name_text",        # FIX 3: added for "Enter my name" button path
}

# All button ID prefixes/values introduced by the button migration
# Used in _make_message_dict() to reconstruct the correct interactive dict.
_BUTTON_REPLY_IDS: frozenset[str] = frozenset({
    # Identity agent
    "identity_new_confirm_yes",
    "identity_new_confirm_edit",
    "identity_ret_confirm_yes",
    "identity_ret_confirm_edit",
    # Booking agent (service menu, reset, payment guard, requirements, advance)
    "1", "2", "YES", "NO", "SKIP", "NEW ORDER",
    # Cart: action
    "CART:CONFIRM", "CART:ADD_MORE", "CART:CLEAR", "CART:SHOW_SUMMARY",
    # Cart: quantity buttons
    "QTY:1", "QTY:2", "QTY:3",
    # Conversation intelligence fallback buttons
    "CANCEL:CONFIRM", "CANCEL:ABORT",
    "MODIFY:CLEAR_REORDER", "MODIFY:CHANGE_QTY",
    "COMPLAINT:CONTINUE",
})

# Button IDs that are list replies (vs button replies)
_LIST_REPLY_PREFIXES: tuple[str, ...] = ("CAT:", "ITEM:")


def _is_duplicate(wamid: str) -> bool:
    now = time.monotonic()
    stale = [k for k, ts in _SEEN.items() if now - ts > _DEDUP_TTL]
    for k in stale:
        del _SEEN[k]
    if wamid in _SEEN:
        return True
    _SEEN[wamid] = now
    return False


def _extract_wamid(raw_message: Dict[str, Any] | str) -> str | None:
    if isinstance(raw_message, dict):
        return raw_message.get("id")
    return None


def _extract_interactive_reply_id(raw_message: Dict[str, Any] | str) -> str:
    if not isinstance(raw_message, dict):
        return str(raw_message)

    msg_type = raw_message.get("type")
    if msg_type == "interactive":
        interactive = raw_message.get("interactive", {})
        itype = interactive.get("type")
        if itype == "list_reply":
            return interactive.get("list_reply", {}).get("id", "")
        elif itype == "button_reply":
            return interactive.get("button_reply", {}).get("id", "")

    return raw_message.get("text", {}).get("body", str(raw_message))


def _make_message_dict(message: str | Dict[str, Any]) -> dict[str, Any]:
    """
    Reconstruct a minimal WhatsApp message dict from a plain string ID.

    main.py extracts the body string before calling route_message(), so the
    raw dict is gone. We reconstruct based on known button/list ID namespaces:

    List replies (WhatsApp interactive list):
      CAT:*  ITEM:*

    Button replies (WhatsApp interactive button):
      identity_new_confirm_*  identity_ret_confirm_*
      QTY:*  CART:*
      CANCEL:*  MODIFY:*  COMPLAINT:*
      Single-value buttons: 1 2 YES NO SKIP "NEW ORDER"

    Everything else is plain text (quantity free-text, typed names, etc.).

    FIX 1: expanded to cover all button namespaces added during button migration.
    """
    if isinstance(message, dict):
        return message  # already a dict — pass through untouched

    text = str(message)

    # ── List replies ───────────────────────────────────────────────────────
    if any(text.startswith(p) for p in _LIST_REPLY_PREFIXES):
        return {
            "type": "interactive",
            "interactive": {
                "type": "list_reply",
                "list_reply": {"id": text, "title": text},
            },
        }

    # ── Button replies — namespace prefixes ───────────────────────────────
    _BUTTON_PREFIXES = (
        "CART:", "QTY:", "CANCEL:", "MODIFY:", "COMPLAINT:",
        "identity_new_confirm_", "identity_ret_confirm_",
    )
    if any(text.startswith(p) for p in _BUTTON_PREFIXES):
        return {
            "type": "interactive",
            "interactive": {
                "type": "button_reply",
                "button_reply": {"id": text, "title": text},
            },
        }

    # ── Button replies — exact single-value IDs ───────────────────────────
    if text in _BUTTON_REPLY_IDS:
        return {
            "type": "interactive",
            "interactive": {
                "type": "button_reply",
                "button_reply": {"id": text, "title": text},
            },
        }

    # ── Plain text ─────────────────────────────────────────────────────────
    return {"type": "text", "text": {"body": text}}


async def _handle_fallback_button(
    reply_id: str,
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
) -> bool:
    """
    Handle button replies generated by conversation_intelligence.handle_fallback().

    Returns True if the button was consumed here (no further routing needed).
    Returns False if the button is not a fallback-intent button.

    FIX 2: routes CANCEL:*, MODIFY:*, COMPLAINT:* buttons which previously
    fell silently through to booking_agent without being handled.
    """

    # ── CANCEL flow ────────────────────────────────────────────────────────
    if reply_id == "CANCEL:CONFIRM":
        # Customer confirmed cancellation — do a soft reset
        customer_name = session_state.get("customer_name", "")
        booking_id    = session_state.get("booking_id")
        if booking_id:
            try:
                from tools.db_tools import update_booking_status
                await update_booking_status(booking_id, "cancelled")
            except Exception as e:
                logger.error(f"Could not cancel booking {booking_id}: {e}")

        cid    = session_state.get("customer_id")
        cname  = session_state.get("customer_name")
        mphone = session_state.get("manager_phone")
        session_state.clear()
        if cid:    session_state["customer_id"]   = cid
        if cname:  session_state["customer_name"] = cname
        if mphone: session_state["manager_phone"] = mphone

        await send_whatsapp_message(
            customer_phone,
            "Your order has been cancelled. Feel free to message us anytime. 😊",
            restaurant_id,
        )
        return True

    if reply_id == "CANCEL:ABORT":
        # Customer changed their mind — restore previous step
        session_state.pop("booking_step", None)   # let booking_agent re-derive
        await send_whatsapp_message(
            customer_phone,
            "No problem! Let's continue with your order. 😊",
            restaurant_id,
        )
        return True

    # ── MODIFY flow ────────────────────────────────────────────────────────
    if reply_id == "MODIFY:CLEAR_REORDER":
        clear_cart(session_state)
        session_state["booking_step"] = "awaiting_category_selection"
        await send_whatsapp_message(
            customer_phone,
            "Cart cleared! 🗑️ Let's build your order from scratch.",
            restaurant_id,
        )
        await send_category_list(customer_phone, session_state)
        return True

    if reply_id == "MODIFY:CHANGE_QTY":
        # Show current cart summary so customer can see what to adjust,
        # then send them back to the cart buttons where they can clear/add.
        await send_cart_summary_buttons(customer_phone, session_state)
        return True

    # ── COMPLAINT flow ─────────────────────────────────────────────────────
    if reply_id == "COMPLAINT:CONTINUE":
        # Resume from wherever the customer was
        booking_step = session_state.get("booking_step", "ask_service")
        await send_whatsapp_message(
            customer_phone,
            "Thank you for your patience! Let's continue. 😊",
            restaurant_id,
        )
        # Don't change booking_step — let booking_agent handle the current step
        return False   # fall through to booking_agent so it re-sends the right prompt

    return False


async def route_message(
    sender_phone: str,
    restaurant_manager_phone: str,
    restaurant_id: str,
    message: str | Dict[str, Any],
    whatsapp_profile_name: str | None = None,
    table_number: int | None = None,
    session_state: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    if session_state is None:
        session_state = {}

    # ── 0. DEDUPLICATION ─────────────────────────────────────────────────────
    wamid = _extract_wamid(message)
    if wamid:
        if _is_duplicate(wamid):
            logger.warning(
                f"Duplicate webhook from {sender_phone} (wamid={wamid[:20]}...), ignoring"
            )
            return {"status": "duplicate", "ignored": True}
    else:
        logger.debug(f"No wamid found for message from {sender_phone}, skipping dedup")

    # ── 0b. EXTRACT INTERACTIVE REPLY ID ─────────────────────────────────────
    message = _extract_interactive_reply_id(message)

    # ── 1. MANAGER ROUTE ─────────────────────────────────────────────────────
    if sender_phone == restaurant_manager_phone:
        logger.info(f"Manager command from {sender_phone}: {message[:50]}")
        return await parse_manager_command(restaurant_id, sender_phone, message)

    # ── 2. IDENTITY ROUTE ────────────────────────────────────────────────────
    logger.info(f"Customer message from {sender_phone}: {message[:50]}")

    customer_id   = session_state.get("customer_id")
    identity_step = session_state.get("identity_step")

    # FIX 3: include "awaiting_name_text" in the set of in-progress identity steps
    if not customer_id or identity_step in _IDENTITY_STEPS_IN_PROGRESS:
        logger.info(f"Routing to Identity Agent. Current step: {identity_step}")

        # Pass full message dict so identity_agent can inspect button IDs
        message_obj = _make_message_dict(message)

        result = await handle_identity_flow(
            restaurant_id=restaurant_id,
            customer_phone=sender_phone,
            whatsapp_profile_name=whatsapp_profile_name,
            message=message,
            session_state=session_state,
            message_obj=message_obj,          # NEW: enables button-reply detection
        )

        if "identity_step" in result:
            session_state["identity_step"] = result["identity_step"]

        # Sync any pending_button_step / pending_qty_button_step returned by agent
        for carry_key in ("pending_button_step", "pending_qty_button_step"):
            if carry_key in result:
                session_state[carry_key] = result[carry_key]

        if result.get("status") == "identified":
            session_state["customer_id"]   = result.get("customer_id")
            session_state["customer_name"] = result.get("customer_name")
            session_state["current_state"] = result.get("next_state", "booking")
            session_state["booking_step"]  = "ask_service"
            session_state.pop("identity_step", None)

            logger.info(
                f"Identity complete for {sender_phone} "
                f"({session_state['customer_name']}) — chaining to booking agent"
            )

            result = await handle_booking_flow(
                restaurant_id=restaurant_id,
                customer_id=session_state["customer_id"],
                customer_name=session_state["customer_name"],
                customer_phone=sender_phone,
                manager_phone=restaurant_manager_phone,
                message=message,
                session_state=session_state,
                table_number=table_number,
            )

            if result.get("status") != "error":
                session_state["current_state"] = "booking"

        logger.info(
            f"Message from {sender_phone} routed — "
            f"status: {result.get('status')} | Next State: {session_state.get('current_state')}"
        )
        return result

    # ── 3. FALLBACK-INTENT BUTTON PRE-ROUTER ──────────────────────────────────
    # Handle CANCEL:*, MODIFY:*, COMPLAINT:* buttons from conversation_intelligence
    # before the cart router or booking_agent gets a chance to misinterpret them.
    # FIX 2: new block.
    if message.startswith(("CANCEL:", "MODIFY:", "COMPLAINT:")):
        consumed = await _handle_fallback_button(
            reply_id=message,
            customer_phone=sender_phone,
            restaurant_id=restaurant_id,
            session_state=session_state,
        )
        if consumed:
            session_state["current_state"] = "booking"
            return {"status": session_state.get("booking_step", "ok")}
        # Not consumed (e.g. COMPLAINT:CONTINUE) — fall through to booking_agent

    # ── 4. CART PRE-ROUTER ────────────────────────────────────────────────────
    customer_name = session_state.get("customer_name", "Guest")

    if not session_state.get("booking_step"):
        session_state["booking_step"] = "ask_service"

    logger.info(f"Customer {sender_phone} ({customer_name}) - Booking flow")

    message_dict = _make_message_dict(message)
    cart_handled = await handle_incoming_message(
        customer_phone=sender_phone,
        message=message_dict,
        session_state=session_state,
    )

    if cart_handled:
        session_state["current_state"] = "booking"
        status = session_state.get("booking_step", "ok")
        logger.info(
            f"Processed {sender_phone} | Status: {status} | Next State: booking"
        )
        return {"status": status}

    # ── 5. BOOKING FLOW ───────────────────────────────────────────────────────
    result = await handle_booking_flow(
        restaurant_id=restaurant_id,
        customer_id=customer_id,
        customer_name=customer_name,
        customer_phone=sender_phone,
        manager_phone=restaurant_manager_phone,
        message=message,
        session_state=session_state,
        table_number=table_number,
    )

    if result.get("status") != "error":
        session_state["current_state"] = "booking"

    if result.get("status") == "cancelled":
        session_state.pop("booking_step", None)
        session_state.pop("service_type", None)
        session_state["current_state"] = "idle"

    logger.info(
        f"Processed {sender_phone} | "
        f"Status: {result.get('status')} | "
        f"Next State: {session_state.get('current_state')}"
    )
    return result
