"""Root coordinator agent - routes customer vs manager requests."""

from typing import Dict, Any
import logging
import time
import re

from agents.customer.identity_agent import handle_identity_flow
from agents.customer.booking_agent import handle_booking_flow
from agents.manager.commands_agent import parse_manager_command
from tools.cart_tools import handle_incoming_message
# from tools.whatsapp_tools import send_whatsapp_message  # no longer needed

logger = logging.getLogger(__name__)

# In-memory dedup cache: maps wamid → timestamp
_SEEN: dict[str, float] = {}
_DEDUP_TTL = 120  # seconds

_HOME_WORDS = {"home", "start", "menu", "main menu"}
_GREET_WORDS = {"hi", "hello", "hey", "hii", "helo"}

# DEFECT FIX (2026-07-06): "Hi Munafe" / "Hi psl" sent by a customer who is
# already mid-session (pinned, booking_step already set) used to fail the
# exact-match _GREET_WORDS check below, fall through into the booking flow's
# awaiting_service_selection handler, miss _SERVICE_TEXT_MAP, and dead-end on
# the generic "Sorry, I did not catch that" fallback. A bare greeting word
# followed by a single trailing token (restaurant name / short code) should
# still be treated as a fresh greeting. Multi-word messages after the
# greeting ("hi, I'd like a table for 4") are intentionally NOT matched here,
# so real free-text messages keep going through the normal flow.
_GREETING_PREFIX_RE = re.compile(r"^(hi|hello|hey|hii|helo|hola|namaste)\b")


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _is_greeting_like(user_text: str) -> bool:
    """
    True for a bare greeting ("hi") or a greeting plus a single trailing
    word ("hi munafe", "hi psl"). `user_text` is expected to already be
    normalized (lowercased, whitespace-collapsed) via `_norm()`.
    """
    if user_text in _GREET_WORDS:
        return True
    match = _GREETING_PREFIX_RE.match(user_text)
    if not match:
        return False
    remainder = user_text[match.end():].strip()
    return len(remainder.split()) <= 1

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
    FIX: handle_incoming_message() in cart_tools expects a raw WhatsApp
    message dict so it can read message["text"]["body"] for quantity replies
    and message["interactive"] for button/list replies.

    main.py extracts the body string before calling route_message(), so the
    raw dict is gone by the time we reach here. We reconstruct a minimal
    dict that satisfies both paths in handle_incoming_message():

      Plain text "4"       → {"type": "text", "text": {"body": "4"}}
      "CAT:South Indian"   → {"type": "interactive", "interactive": {"type": "list_reply", ...}}
      "ITEM:M003"          → {"type": "interactive", "interactive": {"type": "list_reply", ...}}
      "CART:CONFIRM"       → {"type": "interactive", "interactive": {"type": "button_reply", ...}}
    """
    if isinstance(message, dict):
        return message  # already a dict — pass through untouched

    text = str(message)

    # Fallback button IDs from conversation_intelligence handle_fallback()
    if text in (
        "CANCEL:CONFIRM", "CANCEL:ABORT",
        "MODIFY:CLEAR_REORDER", "MODIFY:CHANGE_QTY",
        "COMPLAINT:CONTINUE",
    ):
        return {
            "type": "interactive",
            "interactive": {
                "type": "button_reply",
                "button_reply": {"id": text, "title": text},
            },
        }

    if text.startswith("CAT:") or text.startswith("ITEM:"):
        return {
            "type": "interactive",
            "interactive": {
                "type": "list_reply",
                "list_reply": {"id": text, "title": text},
            },
        }

    if text.startswith("CART:"):
        return {
            "type": "interactive",
            "interactive": {
                "type": "button_reply",
                "button_reply": {"id": text, "title": text},
            },
        }

    # Typed shortcuts → canonical handler ids (booking_agent expands most; belt-and-braces here)
    _SHORTCUT_BUTTONS = {
        "CFM": "CART:CONFIRM", "ADD": "CART:ADD_MORE", "CLR": "CART:CLEAR",
        "SUM": "CART:SHOW_SUMMARY", "SKP": "SKIP", "NVG": "NON_VEG", "ANY": "BOTH",
        "NEW": "NEW ORDER",
    }
    if text in _SHORTCUT_BUTTONS:
        canon = _SHORTCUT_BUTTONS[text]
        return {
            "type": "interactive",
            "interactive": {
                "type": "button_reply",
                "button_reply": {"id": canon, "title": canon},
            },
        }

    # Plain text — quantity reply, "DONE", numbered order, etc.
    return {"type": "text", "text": {"body": text}}


async def route_message(
    sender_phone: str,
    restaurant_manager_phone: str,
    restaurant_id: str,
    message: str | Dict[str, Any],
    whatsapp_profile_name: str | None = None,
    table_number: int | None = None,
    session_state: Dict[str, Any] | None = None,
    raw_message_obj: Dict[str, Any] | None = None,
    message_id: str | None = None,
) -> Dict[str, Any]:
    if session_state is None:
        session_state = {}

    def _lat(stage: str, t0: float) -> None:
        dur_ms = int((time.monotonic() - t0) * 1000)
        wid = message_id or "unknown"
        logger.info(f"[LATENCY] wamid={wid} stage={stage} dur_ms={dur_ms}")

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

    if not message_id and isinstance(raw_message_obj, dict):
        message_id = raw_message_obj.get("id") or message_id

    # ── 0b. EXTRACT INTERACTIVE REPLY ID ─────────────────────────────────────
    # BUG 2 FIX: Capture the raw dict BEFORE converting to a string.
    # identity_agent.handle_identity_flow() needs the original WhatsApp message
    # dict to detect button replies (e.g. name-confirmation buttons).
    # raw_message_obj is passed from main.py — preserve it!
    if raw_message_obj is None:
        raw_message_obj = message if isinstance(message, dict) else None
    message = _extract_interactive_reply_id(message)

    # ── 1. MANAGER ROUTE ─────────────────────────────────────────────────────
    if sender_phone == restaurant_manager_phone:
        logger.info(f"Manager command from {sender_phone}: {message[:50]}")
        _t = time.monotonic()
        result = await parse_manager_command(restaurant_id, sender_phone, message)
        _lat("route_manager", _t)
        return result

    # ── 2. IDENTITY ROUTE ────────────────────────────────────────────────────
    logger.info(f"Customer message from {sender_phone}: {message[:50]}")

    customer_id   = session_state.get("customer_id")
    identity_step = session_state.get("identity_step")

    # Route to identity when:
    #   - No customer_id yet (fresh session or after a full restart)
    #   - Identity flow is mid-way through name collection steps
    needs_identity = (
        not customer_id
        or identity_step in (
            "awaiting_name",
            "awaiting_name_confirm",
            "awaiting_name_text",
        )
    )

    if needs_identity:
        logger.info(f"Routing to Identity Agent. Current step: {identity_step}")

        _t = time.monotonic()
        result = await handle_identity_flow(
            restaurant_id=restaurant_id,
            customer_phone=sender_phone,
            whatsapp_profile_name=whatsapp_profile_name,
            message=message,
            session_state=session_state,
            message_obj=raw_message_obj,  # BUG 2 FIX: pass raw dict for button detection
        )
        _lat("route_identity", _t)

        if "identity_step" in result:
            session_state["identity_step"] = result["identity_step"]
        
        # ✨ FIX: Merge pending_button_step for button detection
        if "pending_button_step" in result:
            session_state["pending_button_step"] = result["pending_button_step"]

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

            _t = time.monotonic()
            result = await handle_booking_flow(
                restaurant_id=restaurant_id,
                customer_id=session_state["customer_id"],
                customer_name=session_state["customer_name"],
                customer_phone=sender_phone,
                manager_phone=restaurant_manager_phone,
                message=message,
                session_state=session_state,
                table_number=table_number,
                raw_message_obj=raw_message_obj,
            )
            _lat("route_booking", _t)

            if result.get("status") != "error":
                session_state["current_state"] = "booking"

        logger.info(
            f"Message from {sender_phone} routed — "
            f"status: {result.get('status')} | Next State: {session_state.get('current_state')}"
        )
        return result

    # ── 2.5 DETERMINISTIC BASIC INTENTS (NO LLM / NO CLOSED-GUARD) ─────────
    user_text = _norm(message)

    if user_text in _HOME_WORDS:
        session_state["current_state"] = "booking"
        session_state["booking_step"] = "ask_service"

        # Delegate to booking agent so it sends native interactive service picker
        _t = time.monotonic()
        result = await handle_booking_flow(
            restaurant_id=restaurant_id,
            customer_id=customer_id,
            customer_name=session_state.get("customer_name", "Guest"),
            customer_phone=sender_phone,
            manager_phone=restaurant_manager_phone,
            message="home",
            session_state=session_state,
            table_number=table_number,
            raw_message_obj=raw_message_obj,
        )
        _lat("route_booking", _t)
        if result.get("status") != "error":
            session_state["current_state"] = "booking"
        return result

    if _is_greeting_like(user_text) and session_state.get("booking_step") in (None, "awaiting_service_selection", "ask_service"):
        session_state["current_state"] = "booking"
        session_state["booking_step"] = "ask_service"

        # Delegate to booking agent so it sends native interactive service picker
        _t = time.monotonic()
        result = await handle_booking_flow(
            restaurant_id=restaurant_id,
            customer_id=customer_id,
            customer_name=session_state.get("customer_name", "Guest"),
            customer_phone=sender_phone,
            manager_phone=restaurant_manager_phone,
            message="hi",
            session_state=session_state,
            table_number=table_number,
            raw_message_obj=raw_message_obj,
        )
        _lat("route_booking", _t)
        if result.get("status") != "error":
            session_state["current_state"] = "booking"
        return result

    # ── 3. CART PRE-ROUTER ────────────────────────────────────────────────────
    # handle_incoming_message() owns these steps exclusively:
    #   - awaiting_quantity      — quantity text replies e.g. "4"
    #   - awaiting_item_selection — numbered text, "DONE"
    #   - All interactive replies — CAT:, ITEM:, CART: buttons/lists
    #
    # IMPORTANT: main.py calls _extract_message_body() before route_message(),
    # so `message` is already a plain string here. We reconstruct a minimal
    # message dict via _make_message_dict() so handle_incoming_message() can
    # read message["text"]["body"] (for quantity) or message["interactive"]
    # (for button/list taps) as it expects.
    customer_name = session_state.get("customer_name", "Guest")

    if not session_state.get("booking_step"):
        session_state["booking_step"] = "ask_service"

    logger.info(f"Customer {sender_phone} ({customer_name}) - Booking flow")

    message_dict = _make_message_dict(message)
    _t = time.monotonic()
    cart_handled = await handle_incoming_message(
        customer_phone=sender_phone,
        message=message_dict,
        session_state=session_state,
    )
    _lat("route_cart", _t)

    if cart_handled:
        session_state["current_state"] = "booking"
        status = session_state.get("booking_step", "ok")
        logger.info(
            f"Processed {sender_phone} | Status: {status} | Next State: booking"
        )
        return {"status": status}

    # ── 4. BOOKING FLOW ───────────────────────────────────────────────────────
    # Handles everything cart_tools doesn't own:
    # awaiting_service_selection, awaiting_party_size, awaiting_order,
    # awaiting_cart_action (CONFIRM/ADD_MORE/CLEAR as plain text fallback),
    # awaiting_address, awaiting_datetime, awaiting_payment, etc.
    _t = time.monotonic()
    result = await handle_booking_flow(
        restaurant_id=restaurant_id,
        customer_id=customer_id,
        customer_name=customer_name,
        customer_phone=sender_phone,
        manager_phone=restaurant_manager_phone,
        message=message,
        session_state=session_state,
        table_number=table_number,
        raw_message_obj=raw_message_obj,
    )
    _lat("route_booking", _t)

    if result.get("status") != "error":
        session_state["current_state"] = "booking"

    # ── BUG 1 FIX: Handle full restart (identity_restart) ────────────────────
    # When the customer taps "Start over" and confirms a full restart,
    # _do_reset() in booking_agent clears the session and returns
    # {"status": "identity_restart"}. We wipe the session and immediately
    # chain into identity so the welcome prompt fires on this same turn.
    if result.get("status") == "identity_restart":
        session_state.pop("customer_id",   None)
        session_state.pop("customer_name", None)
        session_state.pop("booking_step",  None)
        session_state.pop("service_type",  None)
        session_state.pop("identity_step", None)
        session_state["current_state"] = "idle"
        logger.info(
            f"Full restart for {sender_phone} — session wiped, re-entering identity"
        )

        # Chain into identity immediately so the welcome prompt fires now
        _t = time.monotonic()
        result = await handle_identity_flow(
            restaurant_id=restaurant_id,
            customer_phone=sender_phone,
            whatsapp_profile_name=whatsapp_profile_name,
            message=message,
            session_state=session_state,
            message_obj=raw_message_obj,
        )
        _lat("route_identity", _t)

        if "identity_step" in result:
            session_state["identity_step"] = result["identity_step"]
        
        # ✨ FIX: Merge pending_button_step for button detection
        if "pending_button_step" in result:
            session_state["pending_button_step"] = result["pending_button_step"]

        if result.get("status") == "identified":
            session_state["customer_id"]   = result.get("customer_id")
            session_state["customer_name"] = result.get("customer_name")
            session_state["booking_step"]  = "ask_service"
            session_state.pop("identity_step", None)

            _t = time.monotonic()
            result = await handle_booking_flow(
                restaurant_id=restaurant_id,
                customer_id=session_state["customer_id"],
                customer_name=session_state["customer_name"],
                customer_phone=sender_phone,
                manager_phone=restaurant_manager_phone,
                message=message,
                session_state=session_state,
                table_number=table_number,
                raw_message_obj=raw_message_obj,
            )
            _lat("route_booking", _t)

            if result.get("status") != "error":
                session_state["current_state"] = "booking"

    # ── Soft cancel (user chose "Nothing, thanks") ────────────────────────────
    # Keep identity intact, just clear the booking state.
    elif result.get("status") == "cancelled":
        session_state.pop("booking_step", None)
        session_state.pop("service_type", None)
        # Re-pin identity so the customer doesn't have to re-identify
        session_state["customer_id"]   = customer_id
        session_state["customer_name"] = customer_name
        session_state["current_state"] = "idle"

    logger.info(
        f"Processed {sender_phone} | "
        f"Status: {result.get('status')} | "
        f"Next State: {session_state.get('current_state')}"
    )
    return result
