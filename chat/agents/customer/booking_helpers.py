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
from tools.booking_mechanisms import send_catalog_with_fallback  # noqa: F401 — re-exported

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
# C. MENU KEYWORD SETS + SPECIAL-NOTES HINT
# ─────────────────────────────────────────────

_VEG_KEYWORDS = {
    "paneer","veg","vegetable","dal","rajma","chole","aloo","gobi","palak",
    "mushroom","tofu","idli","dosa","uttapam","upma","pongal","parotta",
    "chapati","roti","naan","salad","soup",
}
_SOUTH_INDIAN_KEYWORDS = {
    "idli","dosa","uttapam","upma","pongal","vada","medu vada","sambar","rasam",
    "kootu","kuzhambu","rice","biryani","biriyani","parotta","kothu","appam","puttu",
    "idiyappam","pesarattu","curd rice","lemon rice","tamarind rice","puliyodharai",
    "chicken curry","fish curry","prawn masala","mutton kuzhambu",
}
_SIDES_KEYWORDS   = {"biryani","biriyani","rice","parotta","kothu","idli","dosa","pongal","upma","appam","puttu","roti","naan","chapati"}
_MEAT_KEYWORDS    = {"chicken","mutton","fish","prawn","egg","beef","pork","lamb","seafood","crab","squid","tuna","sardine","anchovy","meat","non-veg","nonveg"}
_RICE_KEYWORDS    = {"biriyani","biryani","fried rice","pulao","rice"}
_BREAD_KEYWORDS   = {"naan","roti","parotta","chapati","kulcha","paratha"}
_DESSERT_KEYWORDS = {"ice cream","halwa","kheer","gulab","jalebi","payasam","pudding","cake","brownie","sweet"}
_DRINK_KEYWORDS   = {"juice","lassi","buttermilk","tea","coffee","shake","smoothie","soda","water"}


def build_notes_hint(order_text: str) -> str:
    lower = order_text.lower()
    has_meat         = any(k in lower for k in _MEAT_KEYWORDS)
    has_veg          = any(k in lower for k in _VEG_KEYWORDS)
    has_rice         = any(k in lower for k in _RICE_KEYWORDS)
    has_bread        = any(k in lower for k in _BREAD_KEYWORDS)
    has_dessert      = any(k in lower for k in _DESSERT_KEYWORDS)
    has_drink        = any(k in lower for k in _DRINK_KEYWORDS)
    has_south_indian = any(k in lower for k in _SOUTH_INDIAN_KEYWORDS)
    has_sides        = any(k in lower for k in _SIDES_KEYWORDS)
    hints = []
    if has_meat or has_rice or has_veg or has_south_indian:
        hints.append("🌶️ Spice level (less spicy / medium / extra spicy)")
    if has_south_indian and has_sides:
        hints.append("🥣 Extra sambar on the side?")
        hints.append("🥛 Extra chutney (coconut / tomato / mint)?")
    if "biryani" in lower or "biriyani" in lower or "rice" in lower:
        hints.append("🥗 Extra raita or salan on the side?")
        hints.append("🍚 Less oil / less ghee?")
    if "parotta" in lower or "kothu" in lower:
        hints.append("🥣 Salna or kurma on the side?")
    if "idli" in lower or "dosa" in lower or "uttapam" in lower:
        hints.append("🥣 Extra sambar or chutney?")
        hints.append("🧈 Butter on top?")
    if "curd rice" in lower or "rasam" in lower:
        hints.append("🌿 Less spice / plain preferred?")
    if has_meat:
        hints.append("🍗 Cooking preference (well-done / medium)")
        hints.append("🧅 Remove onion or garlic?")
    if has_veg and not has_meat:
        hints.append("🧅 No onion / no garlic?")
    if has_bread and not has_south_indian:
        hints.append("🫓 Butter / plain / whole-wheat preference?")
    if has_dessert:
        hints.append("🍬 Sugar-free or less sweet?")
    if has_drink:
        hints.append("🧊 Less sugar / no ice?")
    hints.append("⚠️ Any allergies we should know about?")
    if not hints:
        return ("e.g. less spicy, extra sambar, no onion, allergies — "
                "anything that helps the kitchen prepare it just right for you.")
    return "e.g.\n" + "\n".join(f"• {h}" for h in hints)


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
        session_state.clear()
        session_state["next_state"]    = "identity"
        session_state["identity_step"] = "initial"
        if _prev_ret or _prev_visits:
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = _prev_visits
        if _prev_last:
            session_state["last_order_summary"] = _prev_last
        return

    _cid     = session_state.get("customer_id")
    _cname   = session_state.get("customer_name")
    _mphone  = session_state.get("manager_phone")
    _last    = session_state.get("last_order_summary")
    _ret     = session_state.get("is_returning_customer")
    _visits  = session_state.get("visit_count", 0)
    session_state.clear()
    if _cid:    session_state["customer_id"]           = _cid
    if _cname:  session_state["customer_name"]         = _cname
    if _mphone: session_state["manager_phone"]         = _mphone
    if _last:   session_state["last_order_summary"]    = _last
    if _ret:    session_state["is_returning_customer"] = _ret
    if _visits: session_state["visit_count"]           = _visits
    session_state["booking_step"]          = "awaiting_service_selection"
    session_state["is_returning_customer"] = True

    from agents.customer.conversation_helpers import safe_build_greeting
    raw_greeting   = await safe_build_greeting(customer_id, restaurant_id) if customer_id else ""
    reset_greeting = build_smart_greeting(customer_name, raw_greeting, session_state)
    await send_service_menu(customer_phone, restaurant_id, reset_greeting)


# ─────────────────────────────────────────────
# G. SERVICE MENU SENDER
# ─────────────────────────────────────────────

async def send_service_menu(customer_phone: str, restaurant_id: str, greeting: str) -> None:
    rows = await build_service_menu_rows(restaurant_id)
    _header_text = greeting[:57] + "..." if len(greeting) > 60 else greeting
    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "list",
            "header": {"type": "text", "text": _header_text},
            "body":   {"text": "What would you like to do today?"},
            "footer": {"text": "Tap below to choose"},
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
            f"{greeting}\n\nWhat would you like to do today?\n\n{lines}\n\nReply with a number.",
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
_LAST_ORDER_SUFFIXES = [
    " Your {last_order} last time was a great choice — want to go again?",
    " Loved the {last_order} on your last visit?",
    " The {last_order} was popular last time — it's on the menu again today! 😋",
    " Coming back for the {last_order} again? 😄",
]
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

    last_order   = session_state.get("last_order_summary", "")
    is_returning = session_state.get("is_returning_customer", False)
    visit_count  = session_state.get("visit_count", 0)

    if is_returning or visit_count > 1:
        base     = _RETURNING_VARIANTS.get(tod, _RETURNING_VARIANTS["evening"])[idx]
        greeting = base.format(first=first)
        if last_order:
            suffix_idx = idx % len(_LAST_ORDER_SUFFIXES)
            suffix = _LAST_ORDER_SUFFIXES[suffix_idx].format(last_order=last_order)
            if len(greeting) + len(suffix) <= 300:
                greeting += suffix
    else:
        variants = _FIRST_TIME_VARIANTS.get(tod, _FIRST_TIME_VARIANTS["evening"])
        greeting = variants[idx % len(variants)].format(first=first)

    return greeting


# ─────────────────────────────────────────────
# J. SPECIAL-NOTES NUDGE STUBS
#    auto_nudge_special_notes_loop removed — was a no-op stub never
#    registered with APScheduler (dead code).
# ─────────────────────────────────────────────

_nudge_tasks: dict = {}


def start_special_notes_timer(customer_phone: str, restaurant_id: str) -> None:
    """No-op stub — timeout enforced via session special_notes_asked_at."""
    logger.debug(f"[special-notes-nudge] timer started for {customer_phone}")


def stop_special_notes_timer(customer_phone: str) -> None:
    """Cancel any pending nudge task (no-op if none exist)."""
    task = _nudge_tasks.pop(customer_phone, None)
    if task and not task.done():
        task.cancel()
    logger.debug(f"[special-notes-nudge] timer stopped for {customer_phone}")
