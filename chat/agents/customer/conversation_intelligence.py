"""Conversation Intelligence - intent classification and fallback handling.

FIX LOG
-------
  Fix 1 — handle_fallback() "cancel" path used plain text asking customer to
           reply "Yes" to confirm cancellation. Replaced with a 2-button
           interactive message:
             [Yes, cancel]  [Continue my order]
           Button IDs: CANCEL:CONFIRM  CANCEL:ABORT
           The dispatcher / booking_agent must handle these IDs in the
           awaiting_cancel_confirmation step added below.

  Fix 2 — handle_fallback() "modify_order" path (pre-payment) used plain text
           "Sure! Let's update your order. What would you like instead?"
           which gave no structured path. Added a 2-button prompt:
             [Clear & reorder]  [Change quantity]
           Button IDs: MODIFY:CLEAR_REORDER  MODIFY:CHANGE_QTY
           Post-payment path is unchanged (text only - no cart to modify).

  Fix 3 — handle_fallback() "complaint" path sent no acknowledgement button
           to the customer after alerting the manager. Added a 1-button
           interactive message so the customer can tap to continue ordering:
             [Continue ordering]
           Button ID: COMPLAINT:CONTINUE

  Fix 4 — classify_intent() now uses google-genai (new SDK, replaces
           google-generativeai). Package: pip install google-genai
           Model: gemini-2.0-flash. API key via settings.google_api_key.
           Falls back to "on_track" silently on any failure so the booking
           flow is never blocked.

  Fix 5 — OFF_TRACK intercept must be wired into booking_agent.handle_booking_flow().
           classify_intent() is called BEFORE the state machine, and if
           the intent is in the OFF_TRACK set, handle_fallback() is invoked
           and the state machine is skipped for that turn.
           on_track / affirmative / negative / change_name all fall through
           to the state machine unchanged -- no AI on the happy path.

  Note: all three button IDs from Fixes 1-3 must be present in
  root_agent._make_message_dict() so they are correctly reconstructed as
  button_reply interactive dicts when main.py passes the body string to
  route_message().

HOW TO WIRE THE INTERCEPT IN booking_agent.py
----------------------------------------------
Replace the existing lines at the top of handle_booking_flow() that read:

    context = await _safe_load_context(restaurant_id, customer_id)
    intent  = await _safe_classify_intent(message, "booking_flow", context)

    await _safe_log_event(...)

    current_step = session_state.get("booking_step", "ask_service")

With:

    import asyncio
    from agents.customer.conversation_intelligence import handle_fallback

    context      = await _safe_load_context(restaurant_id, customer_id)
    current_step = session_state.get("booking_step", "ask_service")   # <-- moved up
    intent       = await _safe_classify_intent(message, current_step, context)

    await _safe_log_event(
        restaurant_id, customer_id,
        f"booking_{current_step}",
        "booking_message", intent, message,
    )

    _OFF_TRACK = {
        "complaint", "cancel", "modify_order", "greeting",
        "service_query", "payment_query", "unrelated", "gibberish",
    }
    if intent in _OFF_TRACK:
        restaurant_name = session_state.get("restaurant_name", "our restaurant")
        response = await handle_fallback(
            intent=intent,
            message=message,
            current_state=current_step,
            customer_name=customer_name,
            restaurant_id=restaurant_id,
            restaurant_name=restaurant_name,
            session_context={
                **session_state,
                "customer_phone": customer_phone,
                "manager_phone":  manager_phone,
            },
        )
        if response:
            await send_whatsapp_message(customer_phone, response, restaurant_id)
        asyncio.create_task(_safe_log_event(
            restaurant_id, customer_id,
            f"booking_{current_step}",
            "fallback_triggered", intent, message,
        ))
        return {"status": "fallback_handled"}

    # existing state machine continues below -- _RESET_KEYWORDS check etc.
"""

import json
import logging
import asyncio
import os
from typing import Dict, Any

import httpx as _httpx

from tools.whatsapp_tools import send_whatsapp_message
from tools.db_tools import get_menu
from config.settings import settings

logger = logging.getLogger(__name__)


# -----------------------------------------------------------------------------
# SHARED: MULTILINGUAL AFFIRMATIVE DETECTION
# -----------------------------------------------------------------------------

_AFFIRMATIVES: frozenset[str] = frozenset({
    # English
    "yes", "yeah", "yep", "yup", "yea", "ya", "y",
    # Very common shorthand / single-letter
    "s",
    "k", "kk",
    # Filler affirmatives
    "ok", "okay", "sure", "right", "correct", "fine", "alright", "alrite",
    "confirmed", "confirm", "go", "go ahead",
    # Tamil
    "aama", "ama", "aamam", "aamboda", "seri", "sari", "sowkiyama",
    "ha", "haa",
    # Hindi / Hinglish
    "haan", "han", "bilkul", "theek", "theek hai",
    "theekh hai", "achha", "acha", "accha", "ji", "ji haan", "bhai haan",
    # Telugu
    "avunu", "avuna", "ayya", "aunu",
    # Kannada
    "houdu", "huda", "hauda",
    # Malayalam
    "athe", "aanu", "aw", "athu shan",
    # Bengali
    "hya",
    # Common WhatsApp casual / emoji-adjacent
    "\U0001f44d", "\u2705",
})


def is_affirmative(text: str) -> bool:
    """Return True if text is any recognised affirmative across supported languages."""
    return text.strip().lower() in _AFFIRMATIVES


# -----------------------------------------------------------------------------
# INTERACTIVE BUTTON SENDER (local helper)
# Mirrors _send_interactive in cart_tools without importing it to avoid
# circular imports. Same env vars, same endpoint.
# -----------------------------------------------------------------------------

_TOKEN    = os.getenv("META_GRAPH_API_TOKEN", "")
_PHONE_ID = os.getenv("WABA_PHONE_NUMBER_ID", "")
_API_VER  = os.getenv("META_GRAPH_VERSION", "v20.0")
_BASE_URL = f"https://graph.facebook.com/{_API_VER}"


async def _send_interactive_ci(
    customer_phone: str,
    payload: dict,
    restaurant_id: str | None = None,
) -> bool:
    """POST an interactive WhatsApp message from conversation_intelligence context."""
    from tools.restaurant_config import get_whatsapp_credentials

    creds = await get_whatsapp_credentials(restaurant_id)
    if not creds:
        logger.warning(
            "_send_interactive_ci: no WhatsApp credentials for restaurant %s",
            restaurant_id,
        )
        return False
    api_endpoint = creds["api_endpoint"].rstrip("/")
    url     = f"{api_endpoint}/{creds['phone_number_id']}/messages"
    headers = {
        "Authorization": f"Bearer {creds['access_token']}",
        "Content-Type":  "application/json",
    }
    try:
        async with _httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(url, headers=headers, json={
                "messaging_product": "whatsapp",
                "recipient_type":    "individual",
                "to":                customer_phone,
                "type":              "interactive",
                **payload,
            })
        if resp.status_code != 200:
            logger.warning(f"_send_interactive_ci got {resp.status_code}: {resp.text[:200]}")
        return resp.status_code == 200
    except Exception as e:
        logger.error(f"_send_interactive_ci failed: {e}")
        return False


# -----------------------------------------------------------------------------
# PART A: INTENT CLASSIFIER
# Uses google-genai (new SDK). Install: pip install google-genai
# Never called on button taps or list replies -- only on free-text messages.
# Falls back to "on_track" silently on any error.
# -----------------------------------------------------------------------------

async def classify_intent(message: str, current_state: str, context: dict) -> Dict[str, Any]:
    """
    Classify customer message intent using Gemini 2.0 Flash.

    Only called for free-text messages. Button taps and list replies
    are exact-match handled by the state machine and never reach here.

    Returns a dict:
      intent          str   -- see valid intents below
      confidence      float -- 0.0 to 1.0
      extracted_value str|None
      language        str   -- english|tamil|hinglish|mixed
      sentiment       str   -- positive|neutral|negative

    Falls back to on_track on any failure so the booking flow
    is never blocked by an AI dependency.
    """
    _fallback = {
        "intent":          "on_track",
        "confidence":      0.5,
        "extracted_value": None,
        "language":        "english",
        "sentiment":       "neutral",
    }

    try:
        from google import genai  # pip install google-genai

        client = genai.Client(api_key=settings.google_api_key)

        expected_input_map = {
            "ask_service":                "1/2/3/4",
            "awaiting_service_selection": "1/2/3/4",
            "awaiting_party_size":        "number of people",
            "awaiting_order":             "food items",
            "awaiting_address":           "delivery address",
            "awaiting_datetime":          "date and time",
            "awaiting_flow_datetime":     "date and time from flow",
            "awaiting_name":              "customer name",
            "awaiting_name_confirm":      "yes or new name",
            "awaiting_special_notes":     "dietary notes or tap no notes",
            "awaiting_payment":           "payment confirmation",
            "awaiting_table_assignment":  "waiting for table",
            "awaiting_advance_confirmation": "yes or no",
        }
        expected_input = expected_input_map.get(current_state, "user input")

        prompt = (
            "Classify this WhatsApp message intent for an Indian restaurant bot.\n"
            "Return ONLY a JSON object. No markdown, no explanation, no extra text.\n\n"
            f"Current state: {current_state}\n"
            f"Expected input: {expected_input}\n"
            f'Message: "{message}"\n\n'
            "Valid intents:\n"
            "- on_track: message matches what is expected at this step\n"
            "- greeting: hi / hello / namaste / vanakkam / welcome etc\n"
            "- service_query: asking about menu, timings, location, specials\n"
            "- modify_order: wants to change or update their order\n"
            "- cancel: wants to cancel the booking or order\n"
            "- payment_query: asking about how to pay, UPI, cash, card\n"
            "- complaint: expressing dissatisfaction about past or current experience\n"
            "- unrelated: completely off-topic message\n"
            "- gibberish: random characters, unclear, nonsensical\n"
            "- change_name: wants to update their name\n"
            "- affirmative: yes / ok / sure / ha / seri / haan\n"
            "- negative: no / nope / illa / nahi\n\n"
            "Return exactly this JSON structure:\n"
            '{\n'
            '    "intent": "string",\n'
            '    "confidence": 0.0,\n'
            '    "extracted_value": "string or null",\n'
            '    "language": "english|tamil|hinglish|mixed",\n'
            '    "sentiment": "positive|neutral|negative"\n'
            '}'
        )

        response = client.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
        )

        result_text = response.text.strip()

        # Strip markdown fences if Gemini wraps anyway
        if "```" in result_text:
            parts = result_text.split("```")
            result_text = parts[1] if len(parts) > 1 else parts[0]
            if result_text.startswith("json"):
                result_text = result_text[4:]
            result_text = result_text.strip()

        result = json.loads(result_text)
        logger.info(
            f"[intent] {result.get('intent')} "
            f"conf={result.get('confidence')} "
            f"lang={result.get('language')} "
            f"state={current_state}"
        )
        return result

    except Exception as e:
        logger.debug(f"classify_intent fallback (non-fatal): {e}")
        return _fallback


# -----------------------------------------------------------------------------
# PART B: FALLBACK HANDLER
# Called by booking_agent ONLY when intent is in the OFF_TRACK set.
# Never called on button taps or state-machine happy path.
# -----------------------------------------------------------------------------

async def handle_fallback(
    intent: str,
    message: str,
    current_state: str,
    customer_name: str,
    restaurant_id: str,
    restaurant_name: str,
    session_context: Dict[str, Any],
) -> str:
    """
    Handle off-track intents gracefully.

    For intents that benefit from interactive buttons (cancel, modify_order,
    complaint) we send the WhatsApp message directly and return an empty
    string -- the caller must not send an additional plain-text message.

    For all other intents we return a plain-text string for the caller to send.
    """
    customer_phone = session_context.get("customer_phone", "")
    manager_phone  = session_context.get("manager_phone", "")

    # ── Greeting mid-booking ─────────────────────────────────────────────────
    if intent == "greeting":
        return (
            f"Hi {customer_name}! We were right in the middle of your booking. "
            "Let's continue -- you're almost there!"
        )

    # ── Service / info query ─────────────────────────────────────────────────
    elif intent == "service_query":
        msg_lower = message.lower()
        if any(w in msg_lower for w in ("timing", "open", "hour", "close", "time")):
            return (
                "We're open Monday to Sunday, 7 AM to 10:30 PM. "
                "Shall we get back to your booking?"
            )
        elif any(w in msg_lower for w in ("menu", "item", "food", "what do you")):
            try:
                menu_items = await get_menu(restaurant_id)
                if menu_items:
                    top = ", ".join(
                        f"{i['name']} (\u20b9{i['price']})" for i in menu_items[:3]
                    )
                    return (
                        f"Some popular items today: {top}. "
                        "You can browse the full catalog when you order. Shall we continue?"
                    )
            except Exception:
                pass
            return (
                "You can browse our full menu when you place your order. "
                "Shall we continue?"
            )
        elif any(w in msg_lower for w in ("location", "address", "where", "direction", "map")):
            return (
                f"We'll share our location when you need directions. "
                "Shall we continue with your booking?"
            )
        else:
            return (
                f"Happy to help with any questions about {restaurant_name}. "
                "Shall we get back to your booking?"
            )

    # ── Modify order -- Fix 2: 2-button interactive pre-payment ─────────────
    elif intent == "modify_order":
        if session_context.get("payment_status") == "paid":
            return (
                "Payment has already been made -- I can't modify the order now. "
                "Would you like to cancel instead? Reply Yes or No."
            )
        if customer_phone:
            sent = await _send_interactive_ci(customer_phone, {
                "interactive": {
                    "type": "button",
                    "body": {
                        "text": (
                            f"No problem, {customer_name}!\n\n"
                            "How would you like to update your order?"
                        )
                    },
                    "footer": {"text": "Tap an option below"},
                    "action": {
                        "buttons": [
                            {
                                "type": "reply",
                                "reply": {
                                    "id":    "MODIFY:CLEAR_REORDER",
                                    "title": "Clear & reorder",
                                },
                            },
                            {
                                "type": "reply",
                                "reply": {
                                    "id":    "MODIFY:CHANGE_QTY",
                                    "title": "Change quantity",
                                },
                            },
                        ]
                    },
                }
            }, restaurant_id)
            if sent:
                return ""
        # fallback if interactive send failed
        return "Sure! Let's update your order. What would you like to change?"

    # ── Cancel -- Fix 1: 2-button confirmation ───────────────────────────────
    elif intent == "cancel":
        if customer_phone:
            sent = await _send_interactive_ci(customer_phone, {
                "interactive": {
                    "type": "button",
                    "body": {
                        "text": (
                            f"Are you sure you want to cancel, {customer_name}?\n\n"
                            "If a payment was made, a full refund will be processed."
                        )
                    },
                    "footer": {"text": "Tap to confirm your choice"},
                    "action": {
                        "buttons": [
                            {
                                "type": "reply",
                                "reply": {
                                    "id":    "CANCEL:CONFIRM",
                                    "title": "Yes, cancel",
                                },
                            },
                            {
                                "type": "reply",
                                "reply": {
                                    "id":    "CANCEL:ABORT",
                                    "title": "Continue my order",
                                },
                            },
                        ]
                    },
                }
            }, restaurant_id)
            if sent:
                return ""
        return (
            f"Are you sure you want to cancel, {customer_name}? "
            "If payment was made, a full refund will be processed. "
            "Reply Yes to confirm cancellation."
        )

    # ── Payment query ────────────────────────────────────────────────────────
    elif intent == "payment_query":
        return (
            "We accept UPI payments via a secure link -- no cash or card needed. "
            "The payment link will appear once your order is confirmed. Shall we continue?"
        )

    # ── Complaint -- Fix 3: 1-button ack + manager alert ────────────────────
    elif intent == "complaint":
        # Alert the manager immediately (fire-and-forget)
        if manager_phone:
            asyncio.create_task(send_whatsapp_message(
                manager_phone,
                f"\u26a0\ufe0f *Customer complaint*\n\n"
                f"Customer: {customer_name} ({session_context.get('customer_phone', '')})\n"
                f"Message: {message}",
                restaurant_id,
            ))
        if customer_phone:
            sent = await _send_interactive_ci(customer_phone, {
                "interactive": {
                    "type": "button",
                    "body": {
                        "text": (
                            f"{customer_name}, I am so sorry to hear that.\n\n"
                            "That is not the experience we want for you. "
                            "I have flagged this for our manager right now -- "
                            "your concern is important to us."
                        )
                    },
                    "footer": {"text": "We'll make it right"},
                    "action": {
                        "buttons": [
                            {
                                "type": "reply",
                                "reply": {
                                    "id":    "COMPLAINT:CONTINUE",
                                    "title": "Continue ordering",
                                },
                            },
                        ]
                    },
                }
            }, restaurant_id)
            if sent:
                return ""
        # fallback plain text if interactive failed
        return (
            f"{customer_name}, I am so sorry to hear that. "
            "That is not the experience we want for you. "
            "I have flagged this for our manager right now."
        )

    # ── Unrelated ────────────────────────────────────────────────────────────
    elif intent == "unrelated":
        return (
            f"I can only help with bookings and orders at {restaurant_name} right now. "
            "Shall we get back to your booking?"
        )

    # ── Gibberish ────────────────────────────────────────────────────────────
    elif intent == "gibberish":
        return (
            f"Sorry, I did not catch that {customer_name}. "
            "Please reply with a number (1, 2, 3, or 4) or type your response clearly."
        )

    # ── Change name ──────────────────────────────────────────────────────────
    elif intent == "change_name":
        return "Sure! What would you like your name to be?"

    # ── Catch-all ────────────────────────────────────────────────────────────
    else:
        return (
            f"Thanks for that, {customer_name}. "
            "Shall we continue with your booking?"
        )


# -----------------------------------------------------------------------------
# PART C: CONTEXT MEMORY LOADER
# Returns sensible defaults for every field -- callers never need to guard
# against None. Never raises.
# -----------------------------------------------------------------------------

async def load_conversation_context(customer_id: str, restaurant_id: str) -> Dict[str, Any]:
    """Load customer profile and conversation context."""
    _default: Dict[str, Any] = {
        "customer_id":           str(customer_id),
        "profile":               None,
        "last_3_orders":         [],
        "last_visit_date":       None,
        "days_since_last_visit": 0,
        "favourite_item":        None,
        "rfm_segment":           "new_customer",
        "visit_count":           0,
        "avg_spend":             0,
        "preferred_service":     None,
    }

    try:
        from tools.db_tools import get_session
        from db.models import Customer, CustomerProfile
        from sqlalchemy import select
        from sqlalchemy.sql import and_
        from datetime import datetime
        from uuid import UUID

        async with await get_session() as session:
            result = await session.execute(
                select(Customer).where(Customer.id == UUID(customer_id))
            )
            customer = result.scalar_one_or_none()
            if not customer:
                return _default

            result = await session.execute(
                select(CustomerProfile).where(
                    and_(
                        CustomerProfile.customer_id  == UUID(customer_id),
                        CustomerProfile.restaurant_id == UUID(restaurant_id),
                    )
                )
            )
            profile = result.scalar_one_or_none()

            days_since = 0
            if customer.last_visit_date:
                try:
                    last_visit = datetime.strptime(customer.last_visit_date, "%Y-%m-%d")
                    days_since = (datetime.utcnow() - last_visit).days
                except ValueError:
                    pass

            favourite_item = None
            if profile and profile.favourite_items:
                fav = (
                    json.loads(profile.favourite_items)
                    if isinstance(profile.favourite_items, str)
                    else profile.favourite_items
                )
                if fav:
                    favourite_item = fav[0].get("name")

            return {
                "customer_id": str(customer_id),
                "profile": {
                    "rfm_segment":       profile.rfm_segment       if profile else "new_customer",
                    "favourite_items":   profile.favourite_items   if profile else None,
                    "preferred_service": profile.preferred_service if profile else None,
                    "preferred_day":     profile.preferred_day     if profile else None,
                    "preferred_time":    profile.preferred_time    if profile else None,
                    "visit_streak":      profile.visit_streak      if profile else 0,
                    "avg_spend":         float(profile.avg_spend)  if profile else 0,
                    "total_spend":       float(profile.total_spend) if profile else 0,
                } if profile else None,
                "last_visit_date":       customer.last_visit_date,
                "days_since_last_visit": days_since,
                "favourite_item":        favourite_item,
                "rfm_segment":           profile.rfm_segment if profile else "new_customer",
                "visit_count":           customer.visit_count,
                "avg_spend":             float(profile.avg_spend) if profile else 0,
                "preferred_service":     profile.preferred_service if profile else None,
                "last_3_orders":         [],
            }

    except Exception as e:
        logger.debug(f"load_conversation_context failed (non-fatal): {e}")
        return _default


# -----------------------------------------------------------------------------
# PART D: CONVERSATION EVENT LOGGER  (fire-and-forget)
# Always use:  asyncio.create_task(log_conversation_event(...))
# Never await directly -- it must never block the booking flow.
# -----------------------------------------------------------------------------

async def log_conversation_event(
    restaurant_id: str,
    customer_id: str,
    session_id: str,
    event_type: str,
    intent: str | None,
    raw_message: str,
    resolved: bool = True,
) -> None:
    """Insert a conversation_events row. Non-blocking -- always fire-and-forget."""
    try:
        from tools.db_tools import get_session
        from db.models import ConversationEvent
        from uuid import UUID

        async with await get_session() as session:
            event = ConversationEvent(
                restaurant_id=UUID(restaurant_id),
                customer_id=UUID(customer_id),
                session_id=session_id,
                event_type=event_type,
                intent=intent,
                raw_message=raw_message[:1000],  # guard against oversized payloads
                resolved=resolved,
            )
            session.add(event)
            await session.commit()
            logger.debug(
                f"[conv-event] {event_type}/{intent} "
                f"customer={customer_id[:8]} session={session_id[:16]}"
            )

    except Exception as e:
        logger.debug(f"log_conversation_event failed (non-fatal): {e}")
