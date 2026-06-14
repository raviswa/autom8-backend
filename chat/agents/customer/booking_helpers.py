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
from tools.cart_tools import clear_cart, _send_interactive
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
_HOME_HINT                    = "\n\n💡 Type *Home* to start a fresh booking anytime."
_PAYMENT_PLACEHOLDER_SENTINEL = "placeholder"
_GENERIC_GREETINGS: set[str]  = {"welcome!", "welcome", "hi!", "hi", "hello!", "hello", ""}


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
_RESET_KEYWORDS: set[str] = {
    "home","menu","restart","start over","startover","main menu","mainmenu",
    "begin","reboot","new","mulakarunga","shuru",
    "మొదలు","modalu","തുടങ്ങുക","thudanguka",
}
_STEPS_ALLOWING_SHORT_REPLY: set[str] = {
    "ask_service","awaiting_service_selection","awaiting_reset_confirmation",
    "awaiting__confirmation","awaiting_quantity","awaiting_item_qty",
    "awaiting_numbered_order","awaiting_payment","awaiting_special_notes",
    "awaiting_flow_datetime","awaiting_table_assignment",
    "awaiting_large_party_response","awaiting_manager_approval","visit_complete",
    "awaiting_order","awaiting_address","confirming_order","awaiting_cart_action",
}

_FEEDBACK_RE = re.compile(r"^\s*[1-5]\b", re.IGNORECASE)


def is_greeting(text: str) -> bool:
    return text.strip().lower() in _GREETING_WORDS


def is_feedback_reply(text: str) -> bool:
    return bool(_FEEDBACK_RE.match(text.strip()))


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
    if booking_id:
        try:
            await update_booking_status(booking_id, "cancelled")
            logger.info(f"Cancelled ghost booking {booking_id} on reset.")
        except Exception as e:
            logger.error(f"Failed to cancel booking {booking_id} on reset: {e}")

    if full_restart:
        # Fix 39: preserve returning-customer signals before wipe so greeting
        # never falls into the first-timer branch after a full restart.
        _prev_ret    = session_state.get("is_returning_customer", False)
        _prev_visits = session_state.get("visit_count", 0)
        _prev_last   = session_state.get("last_order_summary", "")
        _prev_svc    = session_state.get("service_type") or session_state.get("last_service_type")
        session_state.clear()
        session_state["next_state"]    = "identity"
        session_state["identity_step"] = "initial"
        if _prev_ret or _prev_visits:
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = _prev_visits
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
    _visits  = session_state.get("visit_count", 0)
    _prev_svc = session_state.get("service_type") or session_state.get("last_service_type")
    session_state.clear()
    if _cid:    session_state["customer_id"]           = _cid
    if _cname:  session_state["customer_name"]         = _cname
    if _mphone: session_state["manager_phone"]         = _mphone
    if _last:   session_state["last_order_summary"]    = strip_order_quantity(_last)
    if _ret:    session_state["is_returning_customer"] = _ret
    if _visits: session_state["visit_count"]           = _visits
    if _prev_svc: session_state["last_service_type"]   = _prev_svc
    session_state["booking_step"]          = "awaiting_service_selection"
    session_state["is_returning_customer"] = True

    from agents.customer.conversation_helpers import safe_build_greeting
    raw_greeting   = await safe_build_greeting(customer_id, restaurant_id) if customer_id else ""
    reset_greeting = build_smart_greeting(customer_name, raw_greeting, session_state)
    await send_service_menu(customer_phone, restaurant_id, reset_greeting, session_state)


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
    from tools.kitchen_hours import is_kitchen_open, next_open_label

    rows = await build_service_menu_rows(restaurant_id)
    state = session_state or {}
    normalize_last_order_summary(state)
    tod = _time_of_day_label()
    header = _MENU_HEADERS.get(tod, "Welcome")

    recall = build_recall_message(state)
    if recall:
        await send_whatsapp_message(customer_phone, recall, restaurant_id)

    if not is_kitchen_open() and announce_closed:
        await send_closed_kitchen_notice(customer_phone, restaurant_id, state)

    body_lines = []
    if greeting and greeting.strip():
        body_lines.append(greeting.strip())

    from tools.db_tools import get_ready_takeaway_order

    ready_takeaway = await get_ready_takeaway_order(restaurant_id, customer_phone)
    if ready_takeaway:
        token = ready_takeaway.get("display_token") or ready_takeaway.get("order_number", "")
        body_lines.append(
            f"Your takeaway order *{token}* is ready — pick up at the counter."
        )
    elif not is_kitchen_open():
        body_lines.append(
            f"Takeaway and delivery open at *{next_open_label()}*. "
            f"Dine-in and reservations are still available."
        )
    body_lines.append("What would you like to do today?")
    body_text = "\n\n".join(body_lines)

    footer = "Reply *Update name* to fix your name"

    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "list",
            "header": {"type": "text", "text": header[:60]},
            "body":   {"text": body_text[:1024]},
            "footer": {"text": footer[:60]},
            "action": {
                "button": "View options",
                "sections": [{"title": "Our services", "rows": rows}],
            },
        }
    })
    if not ok:
        lines = "\n".join(f"{r['id']}. {r['title']}" for r in rows)
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
    lower = text.lower().rstrip("?").strip()
    first = _first_name(customer_name).lower()
    if first and len(lower) <= max(len(first) + 2, 8):
        if lower == first or lower in (f"not {first}", f"im not {first}", f"i'm not {first}"):
            return True
        if text.endswith("?") and lower.split()[0] == first:
            return True
    keywords = (
        "wrong name", "not my name", "update name", "update my name",
        "change name", "change my name", "correct name", "name is wrong",
        "my name is", "call me",
    )
    return any(k in lower for k in keywords)


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
    if raw_greeting and raw_greeting.strip().lower() not in _GENERIC_GREETINGS:
        return raw_greeting

    tod   = _time_of_day_label()
    first = _first_name(customer_name)
    idx   = (len(customer_name) + len(first)) % 4

    normalize_last_order_summary(session_state)
    last_order   = session_state.get("last_order_summary", "")
    is_returning = session_state.get("is_returning_customer", False)
    visit_count  = session_state.get("visit_count", 0)

    if is_returning or visit_count > 1:
        base     = _RETURNING_VARIANTS.get(tod, _RETURNING_VARIANTS["evening"])[idx]
        greeting = base.format(first=first)
    else:
        variants = _FIRST_TIME_VARIANTS.get(tod, _FIRST_TIME_VARIANTS["evening"])
        greeting = variants[idx % len(variants)].format(first=first)

    return greeting


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
    Block takeaway/delivery when the kitchen slot is closed.
    Returns True if the service was blocked (caller should return early).
    """
    from tools.kitchen_hours import ordering_blocked_for_service

    if not ordering_blocked_for_service(service_type):
        return False

    await send_closed_kitchen_notice(
        customer_phone, restaurant_id, session_state, service_type=service_type,
    )
    session_state["booking_step"] = "awaiting_service_selection"
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
