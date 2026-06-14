"""Customer identity agent - handles new/returning customer identification.

ARCHITECTURE NOTE — menu ownership
───────────────────────────────────
This agent is responsible for ONE thing: establishing who the customer is.
It sends a personalised greeting but does NOT send the service menu.
The service menu is exclusively owned by booking_agent (_service_menu helper).

After this agent returns {"status": "identified"}, the dispatcher must:
  1. Store customer_id / customer_name in session.
  2. Set session["booking_step"] = "awaiting_service_selection"
     (skip booking_agent's ask_service step — the menu arrives in the same turn).
  3. Immediately call handle_booking_flow with step = "ask_service" so
     booking_agent sends the canonical 5-option menu in the same message burst.

For reset flows, the dispatcher must treat booking_agent statuses
"reset_complete" and "menu_sent" as no-ops — do NOT re-run identity.

BUTTON STRATEGY
───────────────
WhatsApp interactive buttons (type="button") are used wherever the customer
would otherwise type a yes/no or simple confirmation reply. There are exactly
two such points in this agent:

  1. New customer — profile-name confirmation
       [✅ Yes, that's me]  [✏️ Enter my name]

  2. Returning customer after long absence — name re-verification
       [✅ Yes, that's me]  [✏️ Different name]

CART / SESSION SAFETY
─────────────────────
WhatsApp delivers button replies as messages whose body equals the button
label AND whose `context.button_reply.id` equals the button_id we set.
Because users can tap an old cached button at any time, we validate every
button reply against the EXPECTED step stored in session_state:

  • button_id encodes the step it belongs to  →  "identity_confirm_yes"
  • Handler checks session step before trusting the payload
  • Stale / mismatched button taps are treated as free-text (fallback branch)

This prevents a button tap from a previous turn corrupting a later step
(the "cart corruption" problem for sequential identity flows).
"""

import asyncio
from datetime import datetime
from typing import Dict, Any
import logging

from tools.db_tools import (
    get_customer,
    create_customer,
    update_customer_name,
    update_last_visit,
)

from tools.whatsapp_buttons_helper import send_whatsapp_buttons
from tools.whatsapp_tools import send_whatsapp_message

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# BUTTON ID CONSTANTS
# Encoding the step in the ID is the key safety mechanism:
# a stale button from step A arriving in step B will not match
# the expected ID prefix, and we fall through to free-text handling.
# ─────────────────────────────────────────────

BTN_NEW_YES   = "identity_new_confirm_yes"    # new customer: "Yes, that's my name"
BTN_NEW_EDIT  = "identity_new_confirm_edit"   # new customer: "Enter my name"

BTN_RET_YES   = "identity_ret_confirm_yes"    # returning (long absence): "Yes, that's me"
BTN_RET_EDIT  = "identity_ret_confirm_edit"   # returning (long absence): "Different name"


# ─────────────────────────────────────────────
# GREETING HELPERS  (menu text lives in booking_agent only)
# ─────────────────────────────────────────────

def _returning_greeting(name: str, days_since_visit: int) -> str:
    """Build a personalised one-line greeting for a returning customer."""
    if days_since_visit < 7:
        return f"Welcome back, {name}! See you again so soon! 😊"
    if days_since_visit < 30:
        return f"Welcome back, {name}! Great to see you again. 😊"
    return f"We missed you, {name}! Welcome back. 😊"


# ─────────────────────────────────────────────
# BUTTON REPLY DETECTION HELPERS
# ─────────────────────────────────────────────

def _is_button_reply(message_obj: Dict[str, Any]) -> bool:
    """
    Returns True when the incoming webhook payload is a WhatsApp button reply.
    The dispatcher should pass the full message object (not just .body) so we
    can inspect button_reply.id safely.

    Expected shape (WhatsApp Cloud API):
      {
        "type": "interactive",
        "interactive": {
          "type": "button_reply",
          "button_reply": { "id": "...", "title": "..." }
        }
      }
    """
    return (
        isinstance(message_obj, dict)
        and message_obj.get("type") == "interactive"
        and message_obj.get("interactive", {}).get("type") == "button_reply"
    )


def _get_button_id(message_obj: Dict[str, Any]) -> str | None:
    """Extract the button_reply.id from an interactive message, or None."""
    try:
        return message_obj["interactive"]["button_reply"]["id"]
    except (KeyError, TypeError):
        return None


def _resolve_input(
    message: str,
    message_obj: Dict[str, Any] | None,
    affirmative_btn_id: str,
    edit_btn_id: str,
    current_step: str,
    session_step: str,
) -> tuple[bool | None, bool]:
    """
    Resolve the customer's intent from either a button tap or free-text.

    Returns:
        (is_affirmative: bool | None, is_edit_request: bool)

    is_affirmative is None when we can't determine intent (e.g. stale button,
    non-yes free-text) — caller should treat raw text as the name input.

    Safety rule: button IDs are only trusted when current_step == session_step,
    which guards against stale cached buttons arriving in the wrong turn.
    """
    if message_obj and _is_button_reply(message_obj):
        btn_id = _get_button_id(message_obj)

        # Step mismatch — stale button from a previous turn; ignore it.
        if current_step != session_step:
            logger.warning(
                "Stale button tap ignored: btn_id=%s expected_step=%s session_step=%s",
                btn_id, current_step, session_step,
            )
            return None, False

        if btn_id == affirmative_btn_id:
            return True, False
        if btn_id == edit_btn_id:
            return None, True   # trigger "please type your name" prompt

    # Free-text path — handled by caller
    return None, False


# ─────────────────────────────────────────────
# MAIN ENTRY
# ─────────────────────────────────────────────

async def handle_identity_flow(
    restaurant_id: str,
    customer_phone: str,
    whatsapp_profile_name: str | None,
    message: str,
    session_state: Dict[str, Any],
    message_obj: Dict[str, Any] | None = None,   # full webhook message payload
) -> Dict[str, Any]:
    """
    Handles logic to identify who the customer is.

    message_obj (optional): the raw WhatsApp message dict from the webhook.
    When present it enables button-reply detection. Pass None to fall back
    to pure free-text mode (backwards-compatible).
    """
    customer = await get_customer(restaurant_id, customer_phone)

    if not customer:
        return await handle_new_customer(
            restaurant_id, customer_phone, whatsapp_profile_name,
            message, session_state, message_obj,
        )
    else:
        return await handle_returning_customer(
            restaurant_id, customer, customer_phone,
            message, session_state, message_obj,
        )


# ─────────────────────────────────────────────
# NEW CUSTOMER
# ─────────────────────────────────────────────

async def handle_new_customer(
    restaurant_id: str,
    customer_phone: str,
    whatsapp_profile_name: str | None,
    message: str,
    session_state: Dict[str, Any],
    message_obj: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Logic for first-time visitors."""

    current_step = session_state.get("identity_step", "initial")

    # ── STEP 1: Send greeting + confirmation buttons (or plain prompt) ──────
    if current_step == "initial":
        if whatsapp_profile_name:
            # Offer two buttons: confirm profile name  OR  type a different name.
            # Button titles must be ≤ 20 chars (WhatsApp limit).
            await send_whatsapp_buttons(
                to=customer_phone,
                body=f"Welcome to Munafe! Are you *{whatsapp_profile_name}*?",
                buttons=[
                    {"id": BTN_NEW_YES,  "title": "✅ Yes, that's me"},
                    {"id": BTN_NEW_EDIT, "title": "✏️ Enter my name"},
                ],
                restaurant_id=restaurant_id,
            )
            return {
                "status": "awaiting_name",
                "identity_step": "awaiting_name",
                "next_state": "identity",
                # Stash so we can detect stale taps in the next turn
                "pending_button_step": "awaiting_name",
            }
        else:
            # No profile name — plain text prompt, no buttons needed.
            await send_whatsapp_message(
                customer_phone,
                "Welcome to Munafe! What is your name please?",
                restaurant_id,
            )
            return {
                "status": "awaiting_name",
                "identity_step": "awaiting_name",
                "next_state": "identity",
            }

    # ── STEP 2: Process the customer's name confirmation ────────────────────
    elif current_step == "awaiting_name":

        is_affirmative, wants_edit = _resolve_input(
            message=message,
            message_obj=message_obj,
            affirmative_btn_id=BTN_NEW_YES,
            edit_btn_id=BTN_NEW_EDIT,
            current_step="awaiting_name",
            session_step=session_state.get("pending_button_step", ""),
        )

        # ── Branch A: Customer tapped "Enter my name" button ────────────────
        if wants_edit:
            await send_whatsapp_message(
                customer_phone,
                "No problem! Please type your name:",
                restaurant_id,
            )
            return {
                "status": "awaiting_name_text",
                "identity_step": "awaiting_name_text",
                "next_state": "identity",
                # Clear the button context so stale taps can't re-trigger this
                "pending_button_step": None,
            }

        # ── Branch B: Customer tapped "Yes, that's me" button ───────────────
        if is_affirmative:
            name = whatsapp_profile_name if whatsapp_profile_name else "Guest"
            return await _finalise_new_customer(
                restaurant_id, customer_phone, name,
            )

        # ── Branch C: Customer typed free text (name or "yes") ──────────────
        raw_input = message.strip()
        if _is_affirmative_text(raw_input):
            name = whatsapp_profile_name if whatsapp_profile_name else "Guest"
        else:
            name = raw_input

        return await _finalise_new_customer(restaurant_id, customer_phone, name)

    # ── STEP 2b: Customer typed their name after pressing "Enter my name" ───
    elif current_step == "awaiting_name_text":
        name = message.strip() or "Guest"
        return await _finalise_new_customer(restaurant_id, customer_phone, name)

    # Fallback — should not normally be reached
    return {"status": "error", "next_state": "identity"}


async def _finalise_new_customer(
    restaurant_id: str,
    customer_phone: str,
    name: str,
) -> Dict[str, Any]:
    """Persist the new customer and return the identified status dict."""
    customer = await create_customer(restaurant_id, customer_phone, name, None)
    await update_last_visit(customer["id"])

    await send_whatsapp_message(
        customer_phone,
        f"Thank you, {name}! 😊",
        restaurant_id,
    )

    return {
        "status": "identified",
        "customer_id": customer["id"],
        "customer_name": name,
        "next_state": "booking",
        "identity_step": "completed",
        "booking_step": "ask_service",
        "pending_button_step": None,   # clear stale-button guard
    }


# ─────────────────────────────────────────────
# RETURNING CUSTOMER
# ─────────────────────────────────────────────

async def handle_returning_customer(
    restaurant_id: str,
    customer: Dict[str, Any],
    customer_phone: str,
    message: str,
    session_state: Dict[str, Any],
    message_obj: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """Logic for repeat visitors, including name confirmation for long absences."""

    current_step = session_state.get("identity_step", "initial")
    days_since_visit = 0

    if customer.get("last_visit_date"):
        try:
            last_visit = datetime.strptime(customer["last_visit_date"], "%Y-%m-%d")
            days_since_visit = (datetime.utcnow() - last_visit).days
        except Exception:
            days_since_visit = 100  # Fallback

    customer_name = customer["name"]

    # ── STEP 1: Initial contact ──────────────────────────────────────────────
    if current_step == "initial":

        # Re-verify name after long absence — use buttons for yes/no
        if days_since_visit > 90:
            await send_whatsapp_buttons(
                to=customer_phone,
                body=(
                    f"We missed you! 😊 Is your name still *{customer_name}*?"
                ),
                buttons=[
                    {"id": BTN_RET_YES,  "title": "✅ Yes, that's me"},
                    {"id": BTN_RET_EDIT, "title": "✏️ Different name"},
                ],
                restaurant_id=restaurant_id,
            )
            return {
                "status": "awaiting_confirmation",
                "identity_step": "awaiting_name_confirm",
                "next_state": "identity",
                "pending_button_step": "awaiting_name_confirm",
            }

        # Standard returning customer — service menu greeting is sent by booking_agent
        await update_last_visit(customer["id"])

        return {
            "status": "identified",
            "customer_id": customer["id"],
            "customer_name": customer_name,
            "next_state": "booking",
            "identity_step": "completed",
            "booking_step": "ask_service",
            "pending_button_step": None,
        }

    # ── STEP 2: Process long-absence name confirmation ───────────────────────
    elif current_step == "awaiting_name_confirm":

        is_affirmative, wants_edit = _resolve_input(
            message=message,
            message_obj=message_obj,
            affirmative_btn_id=BTN_RET_YES,
            edit_btn_id=BTN_RET_EDIT,
            current_step="awaiting_name_confirm",
            session_step=session_state.get("pending_button_step", ""),
        )

        # ── Branch A: Customer tapped "Different name" button ────────────────
        if wants_edit:
            await send_whatsapp_message(
                customer_phone,
                "Of course! Please type your correct name:",
                restaurant_id,
            )
            return {
                "status": "awaiting_name_text",
                "identity_step": "awaiting_name_text",
                "next_state": "identity",
                "pending_button_step": None,
            }

        # ── Branch B: Customer tapped "Yes, that's me" button ────────────────
        if is_affirmative:
            return await _finalise_returning_customer(
                restaurant_id, customer, customer_phone,
                final_name=customer_name, name_changed=False,
            )

        # ── Branch C: Free-text response ─────────────────────────────────────
        raw_input = message.strip()
        if _is_affirmative_text(raw_input):
            final_name = customer_name
            name_changed = False
        else:
            final_name = raw_input
            name_changed = True

        return await _finalise_returning_customer(
            restaurant_id, customer, customer_phone,
            final_name=final_name, name_changed=name_changed,
        )

    # ── STEP 2b: Customer typed corrected name after "Different name" ────────
    elif current_step == "awaiting_name_text":
        final_name = message.strip() or customer_name
        name_changed = final_name != customer_name

        return await _finalise_returning_customer(
            restaurant_id, customer, customer_phone,
            final_name=final_name, name_changed=name_changed,
        )

    # Fallback
    return {"status": "error", "next_state": "identity"}


async def _finalise_returning_customer(
    restaurant_id: str,
    customer: Dict[str, Any],
    customer_phone: str,
    final_name: str,
    name_changed: bool,
) -> Dict[str, Any]:
    """Persist any name change, update last visit, send confirmation."""
    if name_changed:
        # Perf: name update and visit update are independent — run concurrently
        await asyncio.gather(
            update_customer_name(customer["id"], final_name, reason="customer_corrected"),
            update_last_visit(customer["id"]),
        )
    else:
        await update_last_visit(customer["id"])

    await send_whatsapp_message(
        customer_phone,
        f"Perfect, {final_name}! 😊",
        restaurant_id,
    )

    return {
        "status": "identified",
        "customer_id": customer["id"],
        "customer_name": final_name,
        "next_state": "booking",
        "identity_step": "completed",
        "booking_step": "ask_service",
        "pending_button_step": None,
    }


# ─────────────────────────────────────────────
# UTILITY — simple affirmative text check
# (keeps backwards-compat with the old is_affirmative import)
# ─────────────────────────────────────────────

from agents.customer.conversation_intelligence import is_affirmative as _ci_is_affirmative

def _is_affirmative_text(text: str) -> bool:
    """Thin wrapper so we keep one canonical source of truth."""
    return _ci_is_affirmative(text)
