"""
agents/customer/booking_helpers.py
────────────────────────────────────
Pure helper functions extracted from booking_agent.py.
No flow logic here — only utilities consumed by flow modules and the router.

Sections
--------
  A. Constants
  B. Time utilities
  C. Menu keyword sets + special-notes hint builder
  D. Party-size parser
  E. Message classification helpers
  F. Reset helpers                 (Fix 39 applied in do_reset)
  G. Service-menu sender
  H. Booking-datetime parser
  I. Smart greeting builder
  J. Special-notes nudge stubs

Note: send_catalog_with_fallback lives in tools/booking_mechanisms.py
      (merged with the existing catalog/cart strategy). Import it from there.
"""

from __future__ import annotations

import asyncio
import logging
import re
import re as _re_party
import time
from datetime import datetime
from typing import Dict, Any
from zoneinfo import ZoneInfo

from tools.whatsapp_tools import send_whatsapp_message
from tools.cart_tools import clear_cart, _send_interactive, sanitize_list_rows
from tools.feature_gate import build_service_menu_rows
from tools.db_tools import update_booking_status

# send_catalog_with_fallback is the alias for send_unified_booking_menu
from tools.booking_mechanisms import (  # noqa: F401 — re-exported
    send_catalog_with_fallback,
    status_after_booking_menu,
)

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────
# A. CONSTANTS
# ─────────────────────────────────────────────

MANAGER_PORTAL_URL            = "https://app.autom8.works/dashboard/manager"
LARGE_PARTY_THRESHOLD         = 8
_HOME_HINT                    = "\n\n💡 Type *HOM* to start a fresh booking anytime."
_PAYMENT_PLACEHOLDER_SENTINEL = "placeholder"
_GENERIC_GREETINGS: set[str]  = {"welcome!", "welcome", "hi!", "hi", "hello!", "hello", ""}

# Session idle timeout — after this, mid-flow state is cleared (B2B spec: 30 min).
SESSION_IDLE_SECONDS = 30 * 60

# Do not expire while waiting for manager approval or Razorpay prepay on scheduled orders.
_SCHEDULED_PAYMENT_IDLE_EXEMPT: frozenset[str] = frozenset({
    "awaiting_scheduled_takeaway_approval",
    "awaiting_scheduled_takeaway_payment",
    "awaiting_scheduled_delivery_approval",
    "awaiting_scheduled_delivery_payment",
})

# Home / menu always start fresh; no continue/start-over prompt.
_DIRECT_RESET_KEYWORDS: set[str] = {"home", "menu", "main menu", "mainmenu", "hom", "mnu"}

# Full identity restart without continue/start-over prompt.
_FULL_RESET_KEYWORDS: set[str] = {
    "restart", "start over", "startover", "reboot", "new", "mulakarunga", "shuru",
    "మొదలు", "modalu", "തുടങ്ങുക", "thudanguka",
}


def touch_session_activity(session_state: Dict[str, Any]) -> None:
    session_state["_last_activity_at"] = datetime.now(ZoneInfo("Asia/Kolkata")).isoformat()


def is_session_stale(session_state: Dict[str, Any]) -> bool:
    step = session_state.get("booking_step", "") or ""
    if step in _SCHEDULED_PAYMENT_IDLE_EXEMPT:
        return False
    raw = session_state.get("_last_activity_at")
    if not raw:
        # Legacy sessions without timestamp — any mid-flow step is treated as stale.
        if step in ("visit_complete", "ask_service", "awaiting_service_selection"):
            return False
        return bool(step)
    try:
        last = datetime.fromisoformat(str(raw))
        if last.tzinfo is None:
            last = last.replace(tzinfo=ZoneInfo("Asia/Kolkata"))
        now = datetime.now(ZoneInfo("Asia/Kolkata"))
        return (now - last).total_seconds() > SESSION_IDLE_SECONDS
    except (ValueError, TypeError):
        return True


def expire_session_if_stale(
    session_state: Dict[str, Any],
    *,
    customer_id: str | None = None,
    customer_name: str | None = None,
) -> bool:
    """Clear mid-flow state when idle too long. Returns True if expired."""
    if not is_session_stale(session_state):
        return False
    step = session_state.get("booking_step", "")
    if step in _SCHEDULED_PAYMENT_IDLE_EXEMPT:
        touch_session_activity(session_state)
        return False
    if step in ("visit_complete", "ask_service", "awaiting_service_selection", None, ""):
        touch_session_activity(session_state)
        return False

    logger.info(f"[session] Expiring stale step={step!r} (idle>{SESSION_IDLE_SECONDS}s)")
    _prev_cid = session_state.get("customer_id") or customer_id
    _prev_cname = session_state.get("customer_name") or customer_name
    _prev_visits = session_state.get("visit_count", 0)
    _prev_last = session_state.get("last_order_summary", "")
    _prev_svc = session_state.get("service_type") or session_state.get("last_service_type")
    _pending_pay = session_state.get("pending_prepay_fulfillment")
    _booking_id = session_state.get("booking_id")
    _payment_link = session_state.get("payment_link")
    _razorpay_link_id = session_state.get("razorpay_payment_link_id")
    _razorpay_order_id = session_state.get("razorpay_order_id")
    _order_summary = session_state.get("order_confirmed_summary")
    _order_total = session_state.get("order_total")
    session_state.clear()
    if _prev_cid:
        session_state["customer_id"] = _prev_cid
    if _prev_cname:
        session_state["customer_name"] = _prev_cname
    if _prev_cid:
        session_state["is_returning_customer"] = True
        session_state["is_new_customer"] = False
    if _prev_visits:
        session_state["visit_count"] = _prev_visits
    if _prev_last:
        session_state["last_order_summary"] = strip_order_quantity(_prev_last)
    if _prev_svc:
        session_state["last_service_type"] = _prev_svc
    if _pending_pay:
        session_state["pending_prepay_fulfillment"] = _pending_pay
    if _booking_id:
        session_state["booking_id"] = _booking_id
    if _payment_link:
        session_state["payment_link"] = _payment_link
    if _razorpay_link_id:
        session_state["razorpay_payment_link_id"] = _razorpay_link_id
    if _razorpay_order_id:
        session_state["razorpay_order_id"] = _razorpay_order_id
    if _order_summary:
        session_state["order_confirmed_summary"] = _order_summary
    if _order_total is not None:
        session_state["order_total"] = _order_total
    # Never resume prepay UX after idle — visit is over; webhooks still use preserved ids.
    session_state["booking_step"] = (
        "visit_complete" if step in ("awaiting_prepay", "awaiting_payment") else "ask_service"
    )
    touch_session_activity(session_state)
    return True


# ─────────────────────────────────────────────
# B. TIME UTILITIES
# ─────────────────────────────────────────────

def now_display() -> str:
    return datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%d-%b-%y, %H:%M")


# ─────────────────────────────────────────────
# C. SPECIAL-NOTES HINT (catalog-aware — see tools/kitchen_notes.py)
# ─────────────────────────────────────────────

from tools.kitchen_notes import build_notes_hint  # noqa: F401 — re-exported


# ─────────────────────────────────────────────
# D. PARTY-SIZE PARSER
# ─────────────────────────────────────────────

_PARTY_WORD_MAP = {
    "one":1,"two":2,"three":3,"four":4,"five":5,"six":6,"seven":7,"eight":8,"nine":9,"ten":10,
    "eleven":11,"twelve":12,
    "ek":1,"do":2,"teen":3,"char":4,"paanch":5,"chhe":6,"saat":7,"aath":8,"nau":9,"das":10,
    "ondru":1,"rendu":2,"moonru":3,"naalu":4,"anju":5,
    "aaru":6,"ezhu":7,"ettu":8,"ombodu":9,"pathu":10,
}
_SOLO_PHRASES = frozenset({
    "just me","only me","me alone","myself alone","solo","alone",
    "naan mattum","oru aal","sirf main","sirf mein","akela","akelaa",
})
_RELATIONSHIP_WORDS = frozenset({
    "wife","husband","partner","girlfriend","boyfriend","friend","friends",
    "colleague","colleagues","kid","kids","child","children","son","sons",
    "daughter","daughters","brother","brothers","sister","sisters",
    "mom","dad","mother","father","parent","parents","uncle","aunt",
    "nephew","niece","cousin","cousins","guest","guests","wifey","hubby",
    "babe","baby","mummy","mama","papa","daddy","bro","sis","granny","nana",
    "grandma","grandpa","grandkid","grandkids","jaan","biwi","bhai","behan",
    "dost","yaar","pondati","pillai","pillaikal","anna","akka","amma","appa",
    "thambi","thangai","paati","thatha","aaji","ajji","avaru","abba",
})
_COUNTABLE_WORDS = frozenset({
    "kid","kids","child","children","son","sons","daughter","daughters",
    "friend","friends","colleague","colleagues","brother","brothers","sister","sisters",
    "adults","adult","people","persons","members","pax","others","more","guests","guest",
    "baby","babies","toddler","toddlers","infant","infants","teen","teens",
    "grandkid","grandkids","pillai","pillaikal","dost","log","perum","pear","dendrum",
})
_ADDITIVE_WORDS = frozenset({"plus","and","with","along","+","another","additional","extra","more","bringing","aur","ke","saath","um","kooda"})
_MOTION_WORDS   = frozenset({"coming","arriving","joining"})
_SELF_WORDS     = frozenset({"me","myself","i","naan","en","main","mein"})
_NEGATION_WORDS = frozenset({"not","no","without","excluding"})

_TOTAL_MARKERS = [
    _re_party.compile(r"\b(?:total|overall|altogether|in\s+all)\s+(\d+|\w+)\b", _re_party.I),
    _re_party.compile(r"\b(\d+|\w+)\s+(?:total|overall|in\s+total|altogether)\b", _re_party.I),
    _re_party.compile(r"\bwe(?:\s+will|\s*'ll)?\s+be\s+(\d+|\w+)\b", _re_party.I),
    _re_party.compile(r"\bwe\s+are\s+(\d+|\w+)\b", _re_party.I),
    _re_party.compile(r"\bhum\s+(\d+|\w+)\s+hain\b", _re_party.I),
    _re_party.compile(r"\b(?:table|party|group|booking|reservation|seats?)\s+(?:for|of)\s+(\d+|\w+)\b", _re_party.I),
    _re_party.compile(r"\b(\d+|\w+)\s+of\s+us\b", _re_party.I),
    _re_party.compile(r"\b(?:make\s+it|actually|it(?:'s|\s+is))\s+(\d+|\w+)\b", _re_party.I),
]
_NEGATED_SOLO_RE = _re_party.compile(
    r"\b(?:not|no)\s+(?:just\s+|only\s+)?(?:me|myself|alone|solo|"
    r"naan\s+mattum|sirf\s+main|sirf\s+mein)\b", _re_party.I,
)


def _word_to_int(s: str) -> int | None:
    s = s.strip()
    if s.isdigit():
        return int(s)
    return _PARTY_WORD_MAP.get(s.lower())


def parse_party_size(text: str) -> int:
    t = text.strip()
    if t.isdigit():
        return int(t)

    t_clean = _re_party.sub(r"[,;]", " ", t)
    t_lower = t_clean.lower()

    for pattern in _TOTAL_MARKERS:
        m = pattern.search(t_lower)
        if m:
            val = _word_to_int(m.group(1))
            if val is not None:
                return val

    t_lower = _re_party.sub(r"\b(?:not|no)\s+(\d+)\b",
                              lambda m: " " * len(m.group(0)), t_lower)

    negated_solo = bool(_NEGATED_SOLO_RE.search(t_lower))
    if negated_solo:
        t_lower = _NEGATED_SOLO_RE.sub(" ", t_lower)

    if not negated_solo:
        for phrase in _SOLO_PHRASES:
            if phrase in t_lower:
                idx = t_lower.find(phrase)
                remainder = t_lower[idx + len(phrase):]
                digits_after = _re_party.findall(r"\b(\d+)\b", remainder)
                words_after  = [w for w in remainder.split()
                                if _re_party.sub(r"[^a-z]", "", w) in _PARTY_WORD_MAP]
                if digits_after:
                    return 1 + int(digits_after[0])
                if words_after:
                    return 1 + _PARTY_WORD_MAP[_re_party.sub(r"[^a-z]", "", words_after[0])]
                return 1

    words = t_lower.split()
    tokens = []
    self_seen = False
    for w in words:
        wc  = _re_party.sub(r"[^a-z+]", "", w)
        raw = w.strip()
        if raw.isdigit():
            tokens.append(("num", int(raw))); self_seen = False
        elif wc in _PARTY_WORD_MAP:
            tokens.append(("wordnum", _PARTY_WORD_MAP[wc])); self_seen = False
        elif wc in _SELF_WORDS:
            if not self_seen: tokens.append(("self", 1)); self_seen = True
        elif wc in _MOTION_WORDS:
            tokens.append(("motion", 1)); self_seen = True
        elif wc in _ADDITIVE_WORDS or raw == "+":
            tokens.append(("add", 0)); self_seen = False
        elif wc in _COUNTABLE_WORDS:
            tokens.append(("count", 1)); self_seen = False
        elif wc in _RELATIONSHIP_WORDS:
            tokens.append(("rel", 1)); self_seen = False
        elif wc in _NEGATION_WORDS:
            tokens.append(("neg", 0))
        else:
            self_seen = False

    clean = []
    skip_next_self = False
    for kind, val in tokens:
        if kind == "neg":
            skip_next_self = True
        elif kind == "self" and skip_next_self:
            skip_next_self = False
        else:
            skip_next_self = False
            clean.append((kind, val))
    tokens = clean

    if negated_solo and not any(k in ("self", "motion") for k, _ in tokens):
        tokens.insert(0, ("self", 1))
    if not tokens:
        raise ValueError(f"Cannot parse party size from: {t!r}")

    total = 0; additive_mode = False; i = 0
    while i < len(tokens):
        kind, val = tokens[i]
        if kind == "self":
            total += 1; i += 1
        elif kind == "motion":
            total += 1; additive_mode = True; i += 1
        elif kind == "rel":
            total += 1; additive_mode = False; i += 1
        elif kind == "add":
            additive_mode = True; i += 1
        elif kind in ("num", "wordnum"):
            next_kind = tokens[i + 1][0] if i + 1 < len(tokens) else None
            if next_kind in ("count", "rel"):
                total += val; additive_mode = False; i += 2
            elif additive_mode or total > 0:
                total += val; additive_mode = False; i += 1
            else:
                has_add_ahead = any(tokens[k][0] in ("add", "motion")
                                    for k in range(i + 1, len(tokens)))
                if has_add_ahead:
                    total += val; i += 1
                else:
                    return val
        elif kind == "count":
            total += 1; additive_mode = False; i += 1
        else:
            i += 1

    if total > 0:
        return total
    raise ValueError(f"Cannot parse party size from: {t!r}")


# ─────────────────────────────────────────────
# E. MESSAGE CLASSIFICATION HELPERS
# ─────────────────────────────────────────────

_GREETING_WORDS: set[str] = {
    "hi","hello","holla","hola","hey","howdy","sup","yo","ok","okay","k",
    "yes","no","yep","nope","thanks","thank you","thankyou","bye","goodbye",
    "help","start","back","reset","restart","cancel",
}
_RESET_KEYWORDS: set[str] = _DIRECT_RESET_KEYWORDS | _FULL_RESET_KEYWORDS | {"begin"}


def is_reset_keyword(text: str) -> bool:
    """True for Home/Menu/restart — must bypass feedback and start fresh booking."""
    return (text or "").strip().lower() in _RESET_KEYWORDS
_STEPS_ALLOWING_SHORT_REPLY: set[str] = {
    "ask_service","awaiting_service_selection","awaiting_reset_confirmation",
    "awaiting__confirmation","awaiting_quantity","awaiting_item_qty",
    "awaiting_numbered_order","awaiting_payment","awaiting_prepay","awaiting_special_notes",
    "awaiting_flow_datetime","awaiting_table_assignment",
    "awaiting_large_party_response","awaiting_manager_approval","visit_complete",
    "awaiting_order","awaiting_address","confirming_order","awaiting_cart_action",
    "awaiting_scheduled_time", "awaiting_scheduled_flow",
    "awaiting_scheduled_delivery_approval", "awaiting_scheduled_delivery_payment",
    "awaiting_scheduled_takeaway_approval", "awaiting_scheduled_takeaway_payment",
    "awaiting_takeaway_scheduled_flow", "awaiting_takeaway_scheduled_time",
    "kitchen_closed",
}

_FEEDBACK_RE = re.compile(r"^\s*[1-5]\b", re.IGNORECASE)
_FEEDBACK_WORDS: frozenset[str] = frozenset({
    "excellent", "good", "average", "below_average", "below average", "poor",
    "skip", "skip_aspects", "skip_comment",
})
_FEEDBACK_SKIP = frozenset({"skip", "s", "none", "no", "done", "ok", "okay"})


def is_feedback_reply(text: str) -> bool:
    """Rating tap, star digit, or feedback-flow keyword — not a new order."""
    raw = (text or "").strip()
    if not raw:
        return False
    t = raw.lower()
    if _FEEDBACK_RE.match(t):
        return True
    if t in _FEEDBACK_WORDS or t in _FEEDBACK_SKIP:
        return True
    stars = raw.count("⭐") + raw.count("★")
    if 1 <= stars <= 5 and len(raw) <= 8:
        return True
    return False


def is_feedback_aspect_reply(text: str) -> bool:
    """Numbered aspect selection during step 2 (e.g. 1 3 or 1,3,5 or all)."""
    t = (text or "").strip().lower()
    if t in _FEEDBACK_SKIP or t in {"all", "everything"}:
        return True
    if re.fullmatch(r"[\d\s,;]+", t) and re.search(r"\d", t):
        return True
    return False


def is_greeting(text: str) -> bool:
    return text.strip().lower() in _GREETING_WORDS


def mark_session_visit_complete(session_state: Dict[str, Any]) -> None:
    """End a visit: clear prepay UX keys, keep identity and last order for greetings."""
    summary = session_state.get("order_confirmed_summary")
    if summary:
        cleaned = _clean_order_summary(str(summary))
        if cleaned:
            session_state["last_order_summary"] = strip_order_quantity(cleaned)
    for key in (
        "payment_link",
        "razorpay_payment_link_id",
        "razorpay_order_id",
        "order_confirmed_summary",
        "order_total",
    ):
        session_state.pop(key, None)
    session_state["booking_step"] = "visit_complete"


_ABANDON_FLOW_KEYS = (
    "cart", "pending_cart", "pending_item", "pending_item_queue",
    "service_type", "order_mode", "token_number", "display_token",
    "table_number", "assigned_tables", "scheduled_at", "delivery_address",
    "delivery_lat", "delivery_lng", "delivery_charge_preview",
    "order_from_cart", "booking_mechanism", "booking_mechanism_order_source",
    "current_category", "_catalog_sent_after_party", "order_totals",
    "pending_order_text", "schedule_flow_sent", "scheduled_delivery_approved",
    "scheduled_takeaway_approved", "kitchen_start_at", "kitchen_start_at_label",
    "booking_id", "flow_token", "_scheduled_payment_sent", "_menu_sent",
)


def _clean_order_summary(summary: str) -> str:
    """Remove stale prepay suffix from a stored order summary."""
    if not summary:
        return summary
    return re.sub(r"\s*—\s*awaiting payment\s*$", "", summary, flags=re.I).strip()


async def abandon_incomplete_session(
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
) -> None:
    """
    Close an in-progress visit with no submitted order before Home / fresh start.
    Dismisses feedback invites and clears mid-flow cart state atomically.
    """
    from tools.feedback_bridge import try_dismiss_feedback_via_api
    from tools.feedback_intent import clear_session_feedback

    had_cart = bool(session_state.get("cart"))
    step = session_state.get("booking_step", "")

    await try_dismiss_feedback_via_api(customer_phone, restaurant_id)
    clear_session_feedback(session_state)
    clear_cart(session_state)

    from tools.db_tools import supersede_active_scheduled_tokens_for_phone
    await supersede_active_scheduled_tokens_for_phone(
        restaurant_id, customer_phone, reason="session_abandoned",
    )

    for key in _ABANDON_FLOW_KEYS:
        session_state.pop(key, None)

    session_state["booking_step"] = "kitchen_closed" if step else "ask_service"
    session_state["_session_abandoned_at"] = datetime.now(ZoneInfo("Asia/Kolkata")).isoformat()
    if had_cart or step in (
        "awaiting_order", "awaiting_category_selection", "awaiting_cart_action",
        "confirming_order", "awaiting_address", "awaiting_table_assignment",
    ):
        session_state["_last_visit_abandoned"] = True
        logger.info(
            f"[session] Abandoned incomplete visit for {customer_phone} "
            f"(step={step!r}, had_cart={had_cart})"
        )


async def start_fresh_visit(
    customer_phone: str,
    restaurant_id: str,
    customer_name: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Clear mid-flow state and show the service menu (Home / Hi after an order)."""
    from agents.customer.message_templates import build_conversation_greeting

    await abandon_incomplete_session(customer_phone, restaurant_id, session_state)

    _prev_cid = session_state.get("customer_id")
    _prev_cname = session_state.get("customer_name") or customer_name
    _prev_visits = session_state.get("visit_count", 0)
    _prev_last = session_state.get("last_order_summary", "")
    _prev_svc = session_state.get("service_type") or session_state.get("last_service_type")
    _pending_pay = session_state.get("pending_prepay_fulfillment")
    _abandoned = session_state.pop("_last_visit_abandoned", False)
    session_state.clear()
    if _prev_cid:
        session_state["customer_id"] = _prev_cid
    if _prev_cname:
        session_state["customer_name"] = _prev_cname
    session_state["is_returning_customer"] = True
    session_state["is_new_customer"] = False
    if _prev_visits:
        session_state["visit_count"] = _prev_visits
    if _prev_last:
        session_state["last_order_summary"] = strip_order_quantity(_prev_last)
    if _prev_svc:
        session_state["last_service_type"] = _prev_svc
    if _pending_pay:
        session_state["pending_prepay_fulfillment"] = _pending_pay
    if _abandoned:
        session_state["_last_visit_abandoned"] = True
    session_state["booking_step"] = "ask_service"
    greeting = await build_conversation_greeting(
        session_state, restaurant_id, customer_phone, _prev_cname or customer_name,
    )
    await send_service_menu(customer_phone, restaurant_id, greeting, session_state)
    session_state["booking_step"] = "awaiting_service_selection"
    touch_session_activity(session_state)
    return {"status": "awaiting_service_selection"}


def is_placeholder_payment_link(link: str) -> bool:
    if not link:
        return True
    return _PAYMENT_PLACEHOLDER_SENTINEL in link.lower()


# ─────────────────────────────────────────────
# F. RESET HELPERS  (Fix 39 applied)
# ─────────────────────────────────────────────

async def ask_continue_or_reset(
    customer_phone: str, restaurant_id: str, *, full_restart: bool = False,
) -> None:
    option2_title = "Start over 🔄" if full_restart else "Start over"
    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "button",
            "body": {"text": "😊 What would you like to do?"},
            "action": {"buttons": [
                {"type": "reply", "reply": {"id": "1", "title": "Continue my order ▶️"}},
                {"type": "reply", "reply": {"id": "2", "title": option2_title}},
            ]},
        }
    })
    if not ok:
        label = "Take me back to the very first message 🔄" if full_restart else "Start over from the beginning"
        await send_whatsapp_message(
            customer_phone,
            f"😊 What would you like to do?\n\n1️⃣  Continue my current order\n2️⃣  {label}\n\nReply with *1* or *2*.",
            restaurant_id,
        )


async def do_reset(
    customer_id: str, customer_name: str, customer_phone: str,
    restaurant_id: str, session_state: Dict[str, Any], *, full_restart: bool = False,
) -> None:
    booking_id = session_state.get("booking_id")
    await abandon_incomplete_session(customer_phone, restaurant_id, session_state)

    if booking_id:
        try:
            await update_booking_status(booking_id, "cancelled")
            logger.info(f"Cancelled ghost booking {booking_id} on reset.")
        except Exception as e:
            logger.error(f"Failed to cancel booking {booking_id} on reset: {e}")

    if full_restart:
        # Preserve returning-customer signals before wipe so greeting stays correct.
        _prev_ret    = session_state.get("is_returning_customer", False)
        _prev_is_new = session_state.get("is_new_customer")
        _prev_visits = session_state.get("visit_count", 0)
        _prev_last   = session_state.get("last_order_summary", "")
        _prev_svc    = session_state.get("service_type") or session_state.get("last_service_type")
        session_state.clear()
        session_state["next_state"]    = "identity"
        session_state["identity_step"] = "initial"
        if _prev_ret or _prev_visits:
            session_state["is_returning_customer"] = True
            session_state["is_new_customer"] = False
            session_state["visit_count"] = _prev_visits
        elif _prev_is_new is not None:
            session_state["is_new_customer"] = _prev_is_new
            session_state["is_returning_customer"] = not _prev_is_new
        if _prev_last:
            session_state["last_order_summary"] = strip_order_quantity(_prev_last)
        if _prev_svc:
            session_state["last_service_type"] = _prev_svc
        return

    _cid     = session_state.get("customer_id")
    _cname   = session_state.get("customer_name")
    _mphone  = session_state.get("manager_phone")
    _last    = session_state.get("last_order_summary")
    _ret     = session_state.get("is_returning_customer")
    _is_new  = session_state.get("is_new_customer")
    _visits  = session_state.get("visit_count", 0)
    _prev_svc = session_state.get("service_type") or session_state.get("last_service_type")
    session_state.clear()
    if _cid:    session_state["customer_id"]           = _cid
    if _cname:  session_state["customer_name"]         = _cname
    if _mphone: session_state["manager_phone"]         = _mphone
    if _last:   session_state["last_order_summary"]    = strip_order_quantity(_last)
    if _ret:    session_state["is_returning_customer"] = _ret
    if _is_new is not None:
        session_state["is_new_customer"] = _is_new
    elif _cid:
        session_state["is_new_customer"] = False
        session_state["is_returning_customer"] = True
    if _visits: session_state["visit_count"]           = _visits
    if _prev_svc: session_state["last_service_type"]   = _prev_svc
    session_state["booking_step"]          = "awaiting_service_selection"

    from agents.customer.message_templates import build_conversation_greeting
    greeting = await build_conversation_greeting(
        session_state, restaurant_id, customer_phone, customer_name,
    )
    await send_service_menu(customer_phone, restaurant_id, greeting, session_state)


# ─────────────────────────────────────────────
# G. SERVICE MENU SENDER
# ─────────────────────────────────────────────

async def send_service_menu(
    customer_phone: str,
    restaurant_id: str,
    greeting: str,
    session_state: Dict[str, Any] | None = None,
    *,
    announce_closed: bool = True,
) -> None:
    from tools.kitchen_hours import (
        build_blanket_closed_message,
        kitchen_accepting_orders,
        refresh_kitchen_acceptance,
    )

    state = session_state or {}
    from tools.booking_mechanisms import cache_restaurant_pricing
    await cache_restaurant_pricing(state, restaurant_id)
    await refresh_kitchen_acceptance(state, restaurant_id)

    if not kitchen_accepting_orders(state):
        await send_whatsapp_message(
            customer_phone,
            build_blanket_closed_message(),
            restaurant_id,
        )
        state["booking_step"] = "kitchen_closed"
        state.pop("_service_menu_rows", None)
        return

    rows = await build_service_menu_rows(restaurant_id, state)
    rows = sanitize_list_rows(rows)
    state["_service_menu_rows"] = rows

    # RULE 2: Minimum viable menu guard
    if len(rows) == 0:
        await send_whatsapp_message(
            customer_phone,
            "We're not accepting orders right now. Please check back later or contact us directly.",
            restaurant_id,
        )
        return

    # RULE 3: Single row shortcut
    if len(rows) == 1 and rows[0]["id"] != "nothing":
        single_row = rows[0]
        single_title = single_row["title"]
        await send_whatsapp_message(
            customer_phone,
            f"We'll set you up with {single_title} — let's go!",
            restaurant_id,
        )

        from tools.feature_gate import _parse_row_id, ORDER_MODE_SCHEDULED
        service_type, order_mode = _parse_row_id(single_row["id"])
        state["service_type"] = service_type
        if order_mode:
            state["order_mode"] = order_mode
        else:
            state.pop("order_mode", None)

        if service_type in ("takeaway", "delivery"):
            from agents.customer.booking_helpers import clear_cart
            clear_cart(state)

        if service_type == "dine_in":
            from agents.customer.dine_in_flow import resume_active_dine_in_token
            resumed = await resume_active_dine_in_token(
                restaurant_id, customer_phone, state.get("customer_name") or "", state,
            )
            if not resumed:
                state["last_service_type"] = "dine_in"
                await send_whatsapp_message(customer_phone, "How many people are dining today?", restaurant_id)
                state["booking_step"] = "awaiting_party_size"
            return

        elif service_type == "takeaway":
            scheduled = (order_mode == ORDER_MODE_SCHEDULED)
            if scheduled:
                from agents.customer.takeaway_flow import offer_takeaway_schedule
                from tools.kitchen_hours import is_kitchen_open
                await offer_takeaway_schedule(
                    customer_phone, restaurant_id, state.get("customer_id") or "", state.get("customer_name") or "", state,
                    kitchen_closed=not is_kitchen_open(),
                )
                return
            state["booking_step"] = "awaiting_order"
            state["last_service_type"] = "takeaway"
            from agents.customer.booking_helpers import send_catalog_with_fallback
            await send_catalog_with_fallback(customer_phone, restaurant_id, state)
            return

        elif service_type == "delivery":
            scheduled = (order_mode == ORDER_MODE_SCHEDULED)
            if scheduled:
                from tools.kitchen_hours import is_kitchen_open
                from agents.customer.delivery_flow import offer_delivery_schedule
                await offer_delivery_schedule(
                    customer_phone, restaurant_id, state.get("customer_id") or "", state.get("customer_name") or "", state,
                    kitchen_closed=not is_kitchen_open(),
                )
                return
            from tools.whatsapp_tools import send_location_request
            sent = await send_location_request(customer_phone, restaurant_id)
            if not sent:
                await send_whatsapp_message(
                    customer_phone,
                    "Great! You've selected *Deliver Now* 🛵\n\n"
                    "Please share your address so we can check if we deliver to your area.",
                    restaurant_id,
                )
                state["booking_step"] = "awaiting_address_or_location"
            else:
                state["booking_step"] = "awaiting_location_only"
            return

        elif service_type == "reserve_table":
            await send_whatsapp_message(
                customer_phone,
                "Great! You've selected *Reserve a Table* (for future booking) 🗓️\n\n"
                "How many people will be dining?",
                restaurant_id,
            )
            state["booking_step"] = "awaiting_party_size"
            return

    # Partition rows into explicit structured sections
    section1_rows = [r for r in rows if r["id"] in ("dine_in_now", "door_delivery_now", "takeaway_now")]
    section2_rows = [r for r in rows if r["id"] in ("table_reservation", "scheduled_delivery", "scheduled_pickup")]
    nothing_rows = [r for r in rows if r["id"] == "nothing"]

    sections = []
    if section1_rows:
        sections.append({
            "title": "🚀 INSTANT / NOW"[:24],
            "rows": section1_rows,
        })
    if section2_rows:
        sections.append({
            "title": "⏰ PLANNED / LATER"[:24],
            "rows": section2_rows,
        })
    if nothing_rows:
        sections.append({
            "title": "Exit"[:24],
            "rows": nothing_rows,
        })

    normalize_last_order_summary(state)
    from agents.customer.message_templates import (
        ensure_restaurant_greeting_context,
        get_time_period,
    )
    await ensure_restaurant_greeting_context(state, restaurant_id)
    period, _ = get_time_period(state.get("_restaurant_timezone", "Asia/Kolkata"))
    header = f"Good {period}".capitalize()

    body_lines = []
    if greeting and greeting.strip():
        body_lines.append(greeting.strip())

    if not state.get("_last_visit_abandoned"):
        from tools.db_tools import get_ready_takeaway_order
        ready_takeaway = await get_ready_takeaway_order(restaurant_id, customer_phone)
        if ready_takeaway:
            token = ready_takeaway.get("display_token") or ready_takeaway.get("order_number", "")
            body_lines.append(
                f"Your takeaway order *{token}* is ready — pick up at the counter."
            )

    state.pop("_last_visit_abandoned", None)
    body_lines.append("What would you like to do today?")
    body_text = "\n\n".join(body_lines)

    footer = "HOM · PAY · Update name"

    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "list",
            "header": {"type": "text", "text": header[:60]},
            "body":   {"text": body_text[:1024]},
            "footer": {"text": footer[:60]},
            "action": {
                "button": "👉 Select Service",
                "sections": sections,
            },
        }
    }, restaurant_id)
    if not ok:
        lines = "\n".join(f"{i + 1}. {r['title']}" for i, r in enumerate(rows))
        await send_whatsapp_message(
            customer_phone,
            f"{body_text}\n\n{lines}\n\nReply with a number.",
            restaurant_id,
        )


# ─────────────────────────────────────────────
# H. BOOKING DATETIME PARSER
# ─────────────────────────────────────────────

def parse_booking_datetime(text: str) -> datetime | None:
    text = text.strip()
    text = re.sub(
        r"(\d{1,2})\.(\d{2})\s*(am|pm)?",
        lambda m: f"{int(m.group(1))}:{m.group(2)}"
        + (f" {m.group(3).upper()}" if m.group(3) else ""),
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"[./]", "-", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"(\d)(AM|PM)", r"\1 \2", text, flags=re.IGNORECASE)
    text = re.sub(r"\.(\d{2})", r":\1", text)
    formats = [
        "%d-%m-%Y, %I:%M %p", "%d-%m-%Y %I:%M %p",
        "%d-%m-%Y, %H:%M",    "%d-%m-%Y %H:%M",
        "%d-%b-%Y, %I:%M %p", "%d-%b-%Y %I:%M %p",
        "%d-%b-%Y, %H:%M",    "%d-%b-%Y %H:%M",
        "%d %b %Y %I:%M %p",  "%d %b %Y %H:%M",
        "%d-%m-%Y, %I %p",    "%d-%m-%Y %I %p",
        "%d-%b-%Y %I %p",     "%d %b %Y %I %p",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def parse_flow_datetime(message: str) -> datetime | None:
    """Parse WhatsApp Flow completion: FLOW:{token}|date=YYYY-MM-DD|time=HH:MM."""
    if not message.startswith("FLOW:"):
        return None
    try:
        parts = message.split("|")
        data: dict[str, str] = {}
        for part in parts[1:]:
            if "=" in part:
                k, v = part.split("=", 1)
                data[k.strip()] = v.strip()
        date_str = data.get("date", "")
        time_str = data.get("time", "")
        if not date_str or not time_str:
            return None

        from zoneinfo import ZoneInfo

        time_norm = time_str.strip().upper()
        for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %I:%M %p", "%Y-%m-%d %I %p"):
            try:
                parsed = datetime.strptime(f"{date_str} {time_norm}", fmt)
                return parsed.replace(tzinfo=ZoneInfo("Asia/Kolkata"))
            except ValueError:
                continue
    except Exception:
        return None
    return None


def now_ist() -> datetime:
    from zoneinfo import ZoneInfo
    return datetime.now(ZoneInfo("Asia/Kolkata"))


async def offer_whatsapp_schedule_calendar(
    customer_phone: str,
    restaurant_id: str,
    customer_id: str,
    session_state: Dict[str, Any],
    *,
    flow_id: str,
    flow_token_prefix: str,
    flow_header: str,
    flow_body: str,
    booking_step: str,
    failure_message: str,
    flow_footer: str = "Calendar — pick date and time",
    flow_cta: str = "Select Date & Time",
    retry_key: str = "_schedule_flow_retry",
    resend_fn=None,
    flow_data: dict | None = None,
) -> Dict[str, Any]:
    """
    Platform rule (restaurant + supply): future date/time via WhatsApp Flow calendar only.
    Never fall back to typed date/time input — text parsing is unreliable.
    """
    import time as _time
    from tools.whatsapp_tools import send_whatsapp_flow, send_whatsapp_message
    from tools.delivery_slots import build_flow_calendar_data

    if not flow_id or flow_id == "your_flow_id_here":
        logger.warning(f"[calendar] Flow ID not configured for {customer_phone}")
        await send_whatsapp_message(customer_phone, failure_message, restaurant_id)
        session_state["booking_step"] = booking_step
        return {"status": booking_step}

    flow_token = f"{flow_token_prefix}_{customer_id}_{int(_time.time())}"
    session_state["flow_token"] = flow_token
    calendar_data = flow_data if flow_data is not None else build_flow_calendar_data()
    ok = await send_whatsapp_flow(
        phone=customer_phone,
        flow_id=flow_id,
        flow_token=flow_token,
        flow_cta=flow_cta,
        flow_header=flow_header,
        flow_body=flow_body,
        flow_footer=flow_footer,
        restaurant_id=restaurant_id,
        flow_data=calendar_data,
    )
    if ok:
        session_state["booking_step"] = booking_step
        session_state.pop("schedule_text_fallback", None)
        session_state.pop(retry_key, None)
        return {"status": booking_step}

    if not session_state.get(retry_key) and resend_fn is not None:
        session_state[retry_key] = True
        return await resend_fn()

    logger.error(f"[calendar] Flow send failed for {customer_phone}")
    # Strictly avoid text fallback if possible per user request for datepicker format
    await send_whatsapp_message(
        customer_phone,
        failure_message + "\n\n(We're having trouble opening the calendar. Please try again in a moment by typing *Home*.)",
        restaurant_id,
    )
    session_state["booking_step"] = booking_step
    return {"status": booking_step}


async def handle_unknown_booking_step(
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
    *,
    flow_name: str,
    booking_step: str | None = None,
) -> Dict[str, Any]:
    """User-visible recovery when a flow receives an unexpected booking_step."""
    step = booking_step or session_state.get("booking_step", "")
    logger.error(f"[{flow_name}] unhandled booking_step={step!r}")
    await send_whatsapp_message(
        customer_phone,
        "Sorry, something went wrong with your booking. "
        "Please reply *Home* to start again, or contact the restaurant for help."
        + _HOME_HINT,
        restaurant_id,
    )
    return {"status": "error", "message_sent": True}


async def handle_awaiting_prepay(
    customer_phone: str,
    restaurant_id: str,
    customer_name: str,
    message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Keep prepay session alive — resend payment link instead of resetting."""
    from tools.payment_tools import (
        ensure_prepay_payment_link,
        is_placeholder_payment_link,
        build_payment_line,
        format_razorpay_payment_line,
        format_payment_link_failure_message,
        recover_prepay_if_already_paid,
        resolve_payment_link_status,
    )

    msg_lower = message.strip().lower()
    if (
        is_greeting(message)
        or msg_lower in _DIRECT_RESET_KEYWORDS
        or msg_lower in ("new order", "new", "order again")
    ):
        return await start_fresh_visit(
            customer_phone, restaurant_id, customer_name, session_state,
        )

    booking_id = session_state.get("booking_id")
    summary = session_state.get(
        "order_confirmed_summary",
        f"Order *#{session_state.get('token_number', '')}*",
    )
    total = float(session_state.get("order_total") or 0)
    service_type = session_state.get("service_type") or session_state.get("last_service_type") or "takeaway"

    if booking_id:
        recovery = await recover_prepay_if_already_paid(str(booking_id), session_state)
        if recovery["state"] == "already_confirmed":
            clean_summary = _clean_order_summary(str(summary))
            await send_whatsapp_message(
                customer_phone,
                f"✅ Your order is already confirmed!\n_{clean_summary}_\n\n"
                f"Reply *Home* to place a new order.",
                restaurant_id,
            )
            mark_session_visit_complete(session_state)
            return {"status": "visit_complete"}
        if recovery["state"] == "kds_retried":
            clean_summary = _clean_order_summary(str(summary))
            await send_whatsapp_message(
                customer_phone,
                f"✅ Your order is confirmed — we've just sent it to the kitchen.\n_{clean_summary}_\n\n"
                f"Reply *Home* to place a new order.",
                restaurant_id,
            )
            mark_session_visit_complete(session_state)
            return {"status": "visit_complete"}
        if recovery["state"] == "kds_retry_failed":
            await send_whatsapp_message(
                customer_phone,
                "Your order is confirmed ✅ but the kitchen display didn't update.\n\n"
                "Please show staff your token at the counter — we're retrying in the background."
                + _HOME_HINT,
                restaurant_id,
            )
            touch_session_activity(session_state)
            return {"status": "visit_complete"}
        if recovery["state"] == "fulfilled":
            mark_session_visit_complete(session_state)
            return {"status": "visit_complete"}
        if recovery["state"] == "fulfill_failed":
            await send_whatsapp_message(
                customer_phone,
                "We received your payment ✅ but confirmation is still processing.\n\n"
                "Please wait a minute — we'll message you shortly. "
                "If nothing arrives, contact the restaurant."
                + _HOME_HINT,
                restaurant_id,
            )
            touch_session_activity(session_state)
            return {"status": "awaiting_prepay"}

    payment_link = session_state.get("payment_link")
    link_status = await resolve_payment_link_status(str(booking_id), session_state) if booking_id else None
    if link_status == "paid":
        await send_whatsapp_message(
            customer_phone,
            "Your payment is already complete ✅ We're confirming your order now — "
            "you'll get a confirmation message shortly.",
            restaurant_id,
        )
        touch_session_activity(session_state)
        return {"status": "awaiting_prepay"}

    if (not payment_link or is_placeholder_payment_link(str(payment_link))) and booking_id and total >= 1:
        payment_link = await ensure_prepay_payment_link(
            str(booking_id), total, customer_name,
            f"{str(service_type).replace('_', ' ').title()} order",
            customer_phone=customer_phone,
            session_state=session_state,
        )

    if payment_link and not is_placeholder_payment_link(str(payment_link)):
        pay_line = format_razorpay_payment_line(
            str(payment_link), label="💳 Pay here to confirm:",
        )
    else:
        pay_line = format_payment_link_failure_message()

    await _send_interactive(customer_phone, {
        "interactive": {
            "type": "button",
            "body": {
                "text": (
                    f"⏳ *Awaiting payment*\n_{summary}_\n\n"
                    f"{pay_line}\n\n"
                    "_Your order will be sent to the kitchen after payment._"
                ),
            },
            "footer": {"text": "PAY resend · HOM new order"},
            "action": {"buttons": [
                {"type": "reply", "reply": {"id": "PAY", "title": "💳 Resend link"}},
                {"type": "reply", "reply": {"id": "NEW ORDER", "title": "🆕 New order"}},
            ]},
        }
    }, restaurant_id)
    touch_session_activity(session_state)
    return {"status": "awaiting_prepay"}


# ─────────────────────────────────────────────
# I. SMART GREETING BUILDER
# ─────────────────────────────────────────────

_RETURNING_VARIANTS: dict[str, list[str]] = {
    "morning": [
        "Good morning, {first}! ☀️ Starting the day with us — we love that.",
        "Morning, {first}! 🌅 Great to see you back.",
        "Rise and dine, {first}! ☕ Welcome back.",
        "Good morning, {first}! 😊 Always a pleasure having you here.",
    ],
    "afternoon": [
        "Good afternoon, {first}! 🌤️ Perfect time for a great meal.",
        "Hey {first}! 😊 Afternoon visit — glad you're back.",
        "Welcome back, {first}! 🌞 Ready for something delicious?",
        "Good afternoon, {first}! Great to see you again.",
    ],
    "evening": [
        "Good evening, {first}! 🌙 The perfect way to end the day.",
        "Evening, {first}! ✨ Glad you're back with us tonight.",
        "Welcome back, {first}! 🌆 Great evening for a meal.",
        "Good evening, {first}! 😊 Always lovely seeing you here.",
    ],
    "night": [
        "Late-night craving, {first}? 🌙 We've got you covered.",
        "Night visit, {first}! 🌟 Great to have you back.",
        "Welcome back, {first}! The kitchen is ready whenever you are. 🍽️",
        "Good to see you, {first}! 😊 What are we having tonight?",
    ],
}
_RECALL_BUBBLES = [
    "Hope you enjoyed the {last_order} last time — it's on the menu today 🌟",
    "Last visit you had {last_order} — happy to add it again if you'd like.",
    "{last_order} is available today whenever you're in the mood.",
    "You ordered {last_order} before — tap the menu to order again anytime.",
]
_MENU_HEADERS: dict[str, str] = {
    "morning":   "Good morning",
    "afternoon": "Good afternoon",
    "evening":   "Good evening",
    "night":     "Good evening",
}


def is_name_correction_trigger(message: str, customer_name: str) -> bool:
    """Detect when a customer questions or wants to update their stored name."""
    text = (message or "").strip()
    if not text:
        return False
    lower = text.lower()
    compact = re.sub(r"[^\w\s]", "", lower).strip()
    first = _first_name(customer_name).lower()

    keywords = (
        "wrong name", "not my name", "update name", "update my name",
        "change name", "change my name", "correct name", "name is wrong",
        "my name is", "call me", "that's not me", "thats not me",
        "not me", "wrong person", "wrong number", "who is this",
        "not my number", "you have the wrong", "got the wrong",
    )
    if any(k in lower for k in keywords):
        return True

    # Brief confusion right after a mis-addressed greeting
    if compact in ("sorry", "what", "huh", "no", "nope", "excuse me"):
        return True
    if compact in ("sorry", "what", "huh") and text.endswith("?"):
        return True

    # "I'm not Vishal", "who is Vishal?", "who's Vishal" — any stated name
    if re.search(r"i(?:'m| am)\s+not\s+[a-z]{2,}", lower):
        return True
    if re.search(r"who(?:'s| is)\s+(?!this\b|that\b|the\b|it\b)[a-z]{2,}", lower):
        return True

    if first and len(first) >= 1:
        name_pat = re.escape(first)
        if re.search(rf"i(?:'m| am)\s+not\s+{name_pat}\b", lower):
            return True
        if re.search(rf"im\s+not\s+{name_pat}\b", lower):
            return True
        if re.search(rf"not\s+{name_pat}\b", lower):
            return True
        if re.search(rf"who(?:'s| is)\s+{name_pat}\b", lower):
            return True
        # "Vs?", "Vs??", "Vishal?"
        bare = re.sub(r"[^\w]", "", lower)
        if bare == first and "?" in text:
            return True
        if text.endswith("?") and lower.split()[0].rstrip("?") == first:
            return True

    return False


async def prompt_name_verification(
    customer_phone: str,
    restaurant_id: str,
    customer_name: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Re-verify stored name mid-booking (buttons → identity agent on next turn)."""
    from agents.customer.identity_agent import BTN_RET_EDIT, BTN_RET_YES
    from tools.whatsapp_buttons_helper import send_whatsapp_buttons

    first = _first_name(customer_name) or customer_name
    await send_whatsapp_buttons(
        to=customer_phone,
        body=f"We have your name as *{first}*. Is that right?",
        buttons=[
            {"id": BTN_RET_YES,  "title": "✅ Yes, that's me"},
            {"id": BTN_RET_EDIT, "title": "✏️ Update name"},
        ],
        restaurant_id=restaurant_id,
    )
    session_state["identity_step"] = "awaiting_name_confirm"
    session_state["pending_button_step"] = "awaiting_name_confirm"
    return {"status": "awaiting_name_confirmation", "next_state": "identity"}


_FIRST_TIME_VARIANTS: dict[str, list[str]] = {
    "morning": [
        "Good morning, {first}! ☀️ Welcome to Munafe — so glad you're here.",
        "Morning, {first}! 🌅 First time? You're in for a treat.",
    ],
    "afternoon": [
        "Good afternoon, {first}! 🌤️ Welcome to Munafe!",
        "Hey {first}! 😊 First time here? We hope you enjoy every bite.",
    ],
    "evening": [
        "Good evening, {first}! 🌙 Welcome to Munafe — great choice for tonight.",
        "Evening, {first}! ✨ First time with us? You picked a good night.",
    ],
    "night": [
        "Hey {first}! 🌟 Welcome to Munafe — glad you found us.",
        "Good evening, {first}! 😊 First visit? The kitchen is ready for you.",
    ],
}


def _time_of_day_label() -> str:
    hour = datetime.now(ZoneInfo("Asia/Kolkata")).hour
    if 5  <= hour < 12: return "morning"
    if 12 <= hour < 17: return "afternoon"
    if 17 <= hour < 21: return "evening"
    return "night"


def _first_name(full_name: str) -> str:
    return full_name.strip().split()[0].capitalize() if full_name.strip() else full_name


def captain_customer_display(captain_result: dict | None) -> str | None:
    """First name for customer-facing captain line; skips role placeholders."""
    if not captain_result:
        return None
    full = str(captain_result.get("captain_name") or "").strip()
    if not full:
        return None
    display = str(captain_result.get("display_name") or "").strip()
    if display and display.lower() not in ("field captain", "captain"):
        return display
    parts = full.split()
    if len(parts) >= 2 and parts[-1].lower() == "captain":
        if parts[0].lower() == "field":
            return None
        return parts[0]
    return _first_name(full) if full.lower() != "field captain" else None


def format_captain_pickup_line(captain_result: dict | None) -> str:
    display = captain_customer_display(captain_result)
    if display:
        return (
            f"\n\n👤 *{display}* is your captain and will coordinate "
            f"your pickup at the counter."
        )
    if captain_result and captain_result.get("captain_name"):
        return "\n\n👤 Our captain will coordinate your pickup at the counter."
    return ""


def strip_order_quantity(order_fragment: str) -> str:
    """'1x Vada Pav' → 'Vada Pav' for greeting / last-order memory."""
    import re
    s = (order_fragment or "").strip()
    if not s:
        return s
    m = re.match(r"^\d+\s*[x×]\s*", s, re.IGNORECASE)
    return s[m.end() :].strip() if m else s


def normalize_last_order_summary(session_state: Dict[str, Any]) -> None:
    """Strip qty prefix from persisted last_order_summary (legacy sessions)."""
    raw = session_state.get("last_order_summary")
    if raw:
        session_state["last_order_summary"] = strip_order_quantity(str(raw))


def build_smart_greeting(
    customer_name: str,
    raw_greeting: str,
    session_state: Dict[str, Any],
) -> str:
    """
    Deprecated — use build_conversation_greeting() for async greeting generation.
    Kept for backwards compatibility in tests; does not use visit_count or raw_greeting bypass.
    """
    from agents.customer.message_templates import build_greeting

    is_new = bool(session_state.get("is_new_customer", True))
    if "is_new_customer" not in session_state:
        is_new = not session_state.get("is_returning_customer", False)

    db_name = session_state.get("_customer_db_name")
    name_for_greeting = None if is_new else (db_name or customer_name or None)

    return build_greeting(
        is_new=is_new,
        customer_name=name_for_greeting,
        restaurant_display_name=session_state.get("_restaurant_display_name", "our restaurant"),
        restaurant_cuisine=session_state.get("_restaurant_cuisine", []),
        timezone=session_state.get("_restaurant_timezone", "Asia/Kolkata"),
    )


def build_recall_message(session_state: Dict[str, Any]) -> str | None:
    """Short standalone bubble for last-order memory (sent before the service menu)."""
    normalize_last_order_summary(session_state)
    last_order = session_state.get("last_order_summary", "")
    if not last_order:
        return None
    first = _first_name(session_state.get("customer_name", ""))
    idx = (len(last_order) + len(first)) % len(_RECALL_BUBBLES)
    return _RECALL_BUBBLES[idx].format(last_order=last_order)


async def send_closed_kitchen_notice(
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
    *,
    service_type: str | None = None,
) -> None:
    """Increment attempt counter and send a warmer closed-hours notice."""
    from tools.kitchen_hours import build_closed_notice

    attempt = int(session_state.get("closed_kitchen_attempts") or 0) + 1
    session_state["closed_kitchen_attempts"] = attempt
    await send_whatsapp_message(
        customer_phone,
        build_closed_notice(attempt=attempt, service_type=service_type),
        restaurant_id,
    )


async def gate_ordering_service(
    customer_phone: str,
    restaurant_id: str,
    session_state: Dict[str, Any],
    service_type: str,
) -> bool:
    """
    Block takeaway/delivery when the kitchen is not accepting orders.
    Returns True if the service was blocked (caller should return early).
    """
    from tools.kitchen_hours import (
        build_blanket_closed_message,
        kitchen_accepting_orders,
        ordering_blocked_for_service,
        refresh_kitchen_acceptance,
    )

    await refresh_kitchen_acceptance(session_state, restaurant_id)

    if not kitchen_accepting_orders(session_state):
        await send_whatsapp_message(
            customer_phone, build_blanket_closed_message(), restaurant_id,
        )
        session_state["booking_step"] = "kitchen_closed"
        return True

    if not ordering_blocked_for_service(service_type, session_state):
        return False

    await send_whatsapp_message(
        customer_phone, build_blanket_closed_message(), restaurant_id,
    )
    session_state["booking_step"] = "kitchen_closed"
    return True


# ─────────────────────────────────────────────
# J. SPECIAL-NOTES KITCHEN TIMER (2-minute wait before KDS/KOT)
# ─────────────────────────────────────────────

_nudge_tasks: dict = {}


SPECIAL_NOTES_WAIT_SECS = 120


def start_special_notes_timer(
    customer_phone: str,
    restaurant_id: str,
    *,
    on_timeout=None,
    wait_secs: int | None = None,
) -> None:
    """Wait up to 2 minutes; if customer hasn't replied, run on_timeout coroutine."""
    stop_special_notes_timer(customer_phone)
    if on_timeout is None:
        logger.debug(f"[special-notes] timer skipped (no handler) for {customer_phone}")
        return

    delay = wait_secs if wait_secs is not None else SPECIAL_NOTES_WAIT_SECS
    delay = max(1, min(delay, SPECIAL_NOTES_WAIT_SECS))

    async def _job() -> None:
        try:
            await asyncio.sleep(delay)
            await on_timeout()
        except asyncio.CancelledError:
            logger.debug(f"[special-notes] timer cancelled for {customer_phone}")

    _nudge_tasks[customer_phone] = asyncio.create_task(_job())
    logger.info(
        f"[special-notes] {delay}s kitchen timer started "
        f"for {customer_phone} @ {restaurant_id}"
    )


async def ensure_special_notes_kitchen_delivery(
    restaurant_id: str,
    customer_phone: str,
    session_state: dict,
    *,
    on_timeout,
) -> None:
    """
    Resume kitchen handoff after chat-service restarts.
    KDS is sent at order confirm; this only recovers missed customer-note timeouts.
    """
    if session_state.get("booking_step") != "awaiting_special_notes":
        return
    if session_state.get("_kitchen_sent"):
        return
    pending = session_state.get("_pending_kitchen") or {}
    if not pending.get("order_text") or not pending.get("cart"):
        logger.warning(
            f"[special-notes] awaiting notes but no pending kitchen payload "
            f"for {customer_phone}"
        )
        return

    asked_at = float(session_state.get("special_notes_asked_at") or 0)
    if not asked_at:
        start_special_notes_timer(
            customer_phone, restaurant_id, on_timeout=on_timeout,
        )
        return

    elapsed = time.time() - asked_at
    if elapsed >= SPECIAL_NOTES_WAIT_SECS:
        logger.info(
            f"[special-notes] overdue ({int(elapsed)}s) — sending {customer_phone} to KDS"
        )
        await on_timeout()
        return

    remaining = int(SPECIAL_NOTES_WAIT_SECS - elapsed)
    start_special_notes_timer(
        customer_phone,
        restaurant_id,
        on_timeout=on_timeout,
        wait_secs=remaining,
    )


def stop_special_notes_timer(customer_phone: str) -> None:
    """Cancel any pending nudge task (no-op if none exist)."""
    task = _nudge_tasks.pop(customer_phone, None)
    if task and not task.done():
        task.cancel()
    logger.debug(f"[special-notes-nudge] timer stopped for {customer_phone}")
