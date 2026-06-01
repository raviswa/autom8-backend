"""Customer booking agent - handles all booking flows (dine-in, takeaway, delivery, reserve).

FIX LOG
-------
  Fix 1  — awaiting_payment stale-button guard
  Fix 2  — token_number persisted in session for all service types
  Fix 3  — order_confirmed_summary stored in session for all service types
  Fix 4  — special requirements step added to dine-in flow
  Fix 5  — Interactive buttons / list replace free-text prompts throughout
  Fix 6  — Dietary preference filtering
  Fix 7  — Optional special notes
  Fix 8  — SyntaxError at line 1095 (CRASH FIX)
  Fix 9  — WhatsApp Flow date/time picker for reserve table
  Fix 10 — Portal token sync: POST /api/tokens on dine-in + reserve
  Fix 11 — KDS notification: POST /api/kds/notify on order confirmation
  Fix 12 — Delivery catalog fix
  Fix 13 — Walk-in WhatsApp notification restored with portal URL
  Fix 14 — Booking summary removed from dine-in customer confirmation
  Fix 15 — Manager WhatsApp notification removed from reserve_table flow
  Fix 16 — Removed table assignment validation from awaiting_order step
  Fix 17 — google.generativeai missing module: hard fallback in classify_intent
  Fix 18 — AsyncSession await error: safe wrappers tightened
  Fix 19 — Razorpay placeholder URL: graceful fallback message
  Fix 20 — Catalog launch fallback: retry + interactive menu fallback
  Fix 21 — awaiting_table_assignment Supabase lookup: corrected endpoint
  Fix 22 — Large party handling
  Fix 23 — Special notes 2-minute auto-nudge
  Fix 24 — visit_complete episode boundary
  Fix 25 — special_notes_nudge inlined as stubs
  Fix 26 — Dine-in catalog time-slot filtering
  Fix 27 — Takeaway/Delivery catalog fallback loop: booking_step set to
            awaiting_category_selection after send_category_list so the main
            router (not the sub-flow) handles CAT:/ITEM:/cart interactions.
            Also corrected awaiting_service_selection branch to set the step
            BEFORE returning, ensuring the sub-flow receives the right state.
  Fix 28 — Copy/UX rewrites: special-notes footer, greeting messages,
            service-menu body text, dine-in check-in message.
  Fix 31 — Takeaway/Delivery silent-stall fix:
            (a) _send_catalog_with_fallback: full diagnostic logging, last-resort
                static prompt guarantees customer never sees silence;
            (b) awaiting_order + awaiting_address + confirming_order added to
                _STEPS_ALLOWING_SHORT_REPLY so catalog order messages are never
                swallowed by the greeting guard;
            (c) empty-cart + short-message guard in takeaway & delivery
                awaiting_order re-sends catalog instead of creating ₹0 booking.
"""

from datetime import datetime
from zoneinfo import ZoneInfo
from typing import Dict, Any
import asyncio
import logging
import re
import time
import aiohttp

from tools.db_tools import (
    get_menu,
    create_booking,
    update_booking_status,
    check_availability,
    get_restaurant_by_whatsapp_number,
    get_next_token_number,
    get_available_tables,
)
from tools.payment_tools import create_payment_link
from tools.whatsapp_tools import send_whatsapp_message, send_location_request, send_whatsapp_flow
from config.settings import settings
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
from tools.feature_gate import (
    Feature, require_feature, FeatureNotSubscribed, denial_message,
    build_service_menu_rows, resolve_service_choice,
)
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

# Fix 25 — stubs so server starts without external special_notes_nudge module
_nudge_tasks: dict = {}

def start_special_notes_timer(customer_phone: str, restaurant_id: str) -> None:
    """No-op stub — timeout enforced via session special_notes_asked_at."""
    logger.debug(f"[special-notes-nudge] timer started for {customer_phone}")

def stop_special_notes_timer(customer_phone: str) -> None:
    """Cancel any pending nudge task for this customer (no-op if none)."""
    import asyncio as _asyncio
    task = _nudge_tasks.pop(customer_phone, None)
    if task and not task.done():
        task.cancel()
    logger.debug(f"[special-notes-nudge] timer stopped for {customer_phone}")

async def auto_nudge_special_notes_loop() -> None:
    """No-op stub."""
    logger.info("[special-notes-nudge] loop started (stub — session-level timeout active)")
    return

logger = logging.getLogger(__name__)

DELIVERY_CHARGE = 40.00
MANAGER_PORTAL_URL = "https://autom8-frontend-production.up.railway.app/dashboard/manager"

PORTAL_API_URL       = "https://autom8-backend-production.up.railway.app/api/tokens"
AUTOM8_KDS_URL       = "https://autom8-backend-production.up.railway.app/api/kds/notify"
PORTAL_RESTAURANT_ID = "46fb9b9e-431a-43c9-9edb-d316b0fef216"
_KDS_SECRET          = "munafe_kds_sync_2026"

_PAYMENT_PLACEHOLDER_SENTINEL = "placeholder"
LARGE_PARTY_THRESHOLD = 8


# ─────────────────────────────────────────────
# LARGE PARTY HELPERS
# ─────────────────────────────────────────────

async def _check_large_party_seating(party_size: int, restaurant_id: str) -> dict:
    try:
        tables = await get_available_tables(restaurant_id)
    except Exception as e:
        logger.warning(f"[large-party] get_available_tables failed (non-fatal): {e}")
        return {"can_seat": True, "total_available": 99, "combination": [], "shortfall": 0}

    total_available = sum(t["capacity"] for t in tables)
    if total_available < party_size:
        return {
            "can_seat": False, "total_available": total_available,
            "combination": [], "shortfall": party_size - total_available,
        }

    combo = []
    remaining = party_size
    for t in tables:
        if remaining <= 0:
            break
        seats_used = min(t["capacity"], remaining)
        combo.append((t["table_number"], t["capacity"], seats_used))
        remaining -= seats_used

    return {
        "can_seat": remaining <= 0, "total_available": total_available,
        "combination": combo, "shortfall": max(0, remaining),
    }


def _format_combo_message(combo: list, party_size: int) -> str:
    lines = "\n".join(f"• Table {t[0]} — {t[2]} of {t[1]} seats" for t in combo)
    return (
        f"We can seat your party of *{party_size}* across multiple tables:\n\n"
        f"{lines}\n\n"
        f"Would you like to confirm this arrangement?\n\n"
        f"Or tap *Reserve* to book for a future date, or *Change* to enter a different party size."
    )


# ─────────────────────────────────────────────
# PORTAL SYNC
# ─────────────────────────────────────────────

async def _sync_token_to_portal(
    customer_name: str, customer_phone: str, token_type: str, pax: int,
) -> str | None:
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                PORTAL_API_URL,
                json={
                    "restaurant_id": PORTAL_RESTAURANT_ID,
                    "name": customer_name, "phone": customer_phone,
                    "type": token_type, "pax": pax,
                },
                timeout=aiohttp.ClientTimeout(total=5),
            )
            if resp.status == 201:
                data = await resp.json()
                token_id = data.get("token", {}).get("id")
                logger.info(f"[portal-sync] Token created: {token_id}")
                return token_id
            else:
                text = await resp.text()
                logger.warning(f"[portal-sync] Non-201 response {resp.status}: {text}")
                return None
    except Exception as e:
        logger.warning(f"[portal-sync] Failed (non-fatal): {e}")
        return None


async def _sync_token_to_portal_large_party(
    customer_name: str, customer_phone: str, pax: int, combo: list,
) -> str | None:
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                PORTAL_API_URL,
                params={"notify": "false"},
                json={
                    "restaurant_id": PORTAL_RESTAURANT_ID,
                    "name": customer_name, "phone": customer_phone,
                    "type": "large_party", "pax": pax,
                    "meta": {"combo": combo},
                },
                timeout=aiohttp.ClientTimeout(total=5),
            )
            if resp.status == 201:
                data = await resp.json()
                token_id = data.get("token", {}).get("id")
                logger.info(f"[portal-sync-large] Token created: {token_id}")
                return token_id
            else:
                text = await resp.text()
                logger.warning(f"[portal-sync-large] Non-201 {resp.status}: {text}")
                return None
    except Exception as e:
        logger.warning(f"[portal-sync-large] Failed (non-fatal): {e}")
        return None


async def _lookup_table_assignment(customer_phone: str) -> str | None:
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.get(
                PORTAL_API_URL,
                params={"phone": customer_phone, "restaurant_id": PORTAL_RESTAURANT_ID},
                timeout=aiohttp.ClientTimeout(total=3),
            )
            if resp.status == 200:
                data = await resp.json()
                tokens = data if isinstance(data, list) else data.get("tokens", [])
                for token_record in tokens:
                    tbl = token_record.get("table_number")
                    if tbl:
                        logger.info(f"[table-check] Found table {tbl} for {customer_phone}")
                        return str(tbl)
    except Exception as e:
        logger.warning(f"[table-check] Portal lookup failed (non-fatal): {e}")
    return None


# ─────────────────────────────────────────────
# KDS NOTIFICATION
# ─────────────────────────────────────────────

async def _notify_kds(
    customer_name: str, customer_phone: str, order_text: str, cart: dict,
    table_number: str | int | None, token_number: str, service_type: str,
    special_notes: str | None = None,
) -> None:
    try:
        items = []
        for item_id, line in cart.items():
            items.append({
                "retailer_id": item_id, "name": line["title"],
                "qty": line["qty"], "unit_price": line["unit_price"],
            })
        if not items:
            items = [{"retailer_id": "manual", "name": order_text, "qty": 1, "unit_price": 0}]

        payload = {
            "restaurant_id": PORTAL_RESTAURANT_ID,
            "customer_name": customer_name, "customer_phone": customer_phone,
            "token_number": token_number,
            "table_number": str(table_number) if table_number else None,
            "service_type": service_type, "items": items,
            "special_notes": special_notes, "secret": _KDS_SECRET,
        }
        async with aiohttp.ClientSession() as http:
            resp = await http.post(AUTOM8_KDS_URL, json=payload, timeout=aiohttp.ClientTimeout(total=5))
            if resp.status in (200, 201):
                data = await resp.json()
                logger.info(
                    f"[kds-notify] ✅ {data.get('kds_items_created', '?')} KDS item(s) created "
                    f"for token {token_number} | table {table_number}"
                )
            else:
                text = await resp.text()
                logger.warning(f"[kds-notify] Non-2xx {resp.status}: {text[:200]}")
    except Exception as e:
        logger.warning(f"[kds-notify] Failed (non-fatal): {e}")


# ─────────────────────────────────────────────
# GENERAL HELPERS
# ─────────────────────────────────────────────

def _now_display() -> str:
    ist_now = datetime.now(ZoneInfo("Asia/Kolkata"))
    return ist_now.strftime("%d-%b-%y, %H:%M")


_VEG_KEYWORDS = {"paneer","veg","vegetable","dal","rajma","chole","aloo","gobi","palak",
                 "mushroom","tofu","idli","dosa","uttapam","upma","pongal","parotta",
                 "chapati","roti","naan","salad","soup"}
_SOUTH_INDIAN_KEYWORDS = {
    "idli","dosa","uttapam","upma","pongal","vada","medu vada","sambar","rasam",
    "kootu","kuzhambu","rice","biryani","biriyani","parotta","kothu","appam","puttu",
    "idiyappam","pesarattu","curd rice","lemon rice","tamarind rice","puliyodharai",
    "chicken curry","fish curry","prawn masala","mutton kuzhambu",
}
_SIDES_KEYWORDS = {"biryani","biriyani","rice","parotta","kothu","idli","dosa",
                   "pongal","upma","appam","puttu","roti","naan","chapati"}
_MEAT_KEYWORDS = {"chicken","mutton","fish","prawn","egg","beef","pork","lamb",
                  "seafood","crab","squid","tuna","sardine","anchovy","meat","non-veg","nonveg"}
_RICE_KEYWORDS    = {"biriyani","biryani","fried rice","pulao","rice"}
_BREAD_KEYWORDS   = {"naan","roti","parotta","chapati","kulcha","paratha"}
_DESSERT_KEYWORDS = {"ice cream","halwa","kheer","gulab","jalebi","payasam",
                     "pudding","cake","brownie","sweet"}
_DRINK_KEYWORDS   = {"juice","lassi","buttermilk","tea","coffee","shake",
                     "smoothie","soda","water"}


def _build_notes_hint(order_text: str) -> str:
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


import re as _re_party

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
_ADDITIVE_WORDS = frozenset({
    "plus","and","with","along","+","another","additional","extra","more",
    "bringing","aur","ke","saath","um","kooda",
})
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
    if s.isdigit(): return int(s)
    return _PARTY_WORD_MAP.get(s.lower())


def _parse_party_size(text: str) -> int:
    t = text.strip()
    if t.isdigit(): return int(t)

    t_clean = _re_party.sub(r"[,;]", " ", t)
    t_lower = t_clean.lower()

    for pattern in _TOTAL_MARKERS:
        m = pattern.search(t_lower)
        if m:
            val = _word_to_int(m.group(1))
            if val is not None: return val

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
                if digits_after: return 1 + int(digits_after[0])
                if words_after:  return 1 + _PARTY_WORD_MAP[_re_party.sub(r"[^a-z]", "", words_after[0])]
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

    if negated_solo and not any(k in ("self","motion") for k,_ in tokens):
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
            next_kind = tokens[i+1][0] if i+1 < len(tokens) else None
            if next_kind in ("count","rel"):
                total += val; additive_mode = False; i += 2
            elif additive_mode or total > 0:
                total += val; additive_mode = False; i += 1
            else:
                has_add_ahead = any(tokens[k][0] in ("add","motion")
                                    for k in range(i+1, len(tokens)))
                if has_add_ahead: total += val; i += 1
                else: return val
        elif kind == "count":
            total += 1; additive_mode = False; i += 1
        else:
            i += 1

    if total > 0: return total
    raise ValueError(f"Cannot parse party size from: {t!r}")


_GREETING_WORDS = {
    "hi","hello","holla","hola","hey","howdy","sup","yo","ok","okay","k",
    "yes","no","yep","nope","thanks","thank you","thankyou","bye","goodbye",
    "help","start","back","reset","restart","cancel",
}
_RESET_KEYWORDS: set[str] = {
    "home","menu","restart","start over","startover","main menu","mainmenu",
    "begin","reboot","new","mulakarunga","shuru",
    "మొదలు","modalu","തുടങ്ങുക","thudanguka",
}
_STEPS_ALLOWING_SHORT_REPLY = {
    "ask_service","awaiting_service_selection","awaiting_reset_confirmation",
    "awaiting__confirmation","awaiting_quantity","awaiting_item_qty",
    "awaiting_numbered_order","awaiting_payment","awaiting_special_notes",
    "awaiting_flow_datetime","awaiting_table_assignment",
    "awaiting_large_party_response","awaiting_manager_approval","visit_complete",
    # Fix 31: order-related steps must allow structured/short messages so that
    # WhatsApp catalog order submissions are never swallowed by the greeting guard.
    "awaiting_order","awaiting_address","confirming_order","awaiting_cart_action",
}
_GENERIC_GREETINGS = {"welcome!","welcome","hi!","hi","hello!","hello",""}

def _is_greeting(text: str) -> bool:
    return text.strip().lower() in _GREETING_WORDS

_FEEDBACK_RE = re.compile(r"^\s*[1-5]\b", re.IGNORECASE)
def _is_feedback_reply(text: str) -> bool:
    return bool(_FEEDBACK_RE.match(text.strip()))

def _is_placeholder_payment_link(link: str) -> bool:
    if not link: return True
    return _PAYMENT_PLACEHOLDER_SENTINEL in link.lower()


# ─────────────────────────────────────────────
# CATALOG FALLBACK
# ─────────────────────────────────────────────

async def _send_catalog_with_fallback(
    customer_phone: str, restaurant_id: str, session_state: Dict[str, Any],
) -> None:
    """
    Fix 30/31 — Catalog-first, time-slot-safe, guaranteed delivery.

    Attempt 1 : native WhatsApp Catalog API
    Attempt 2 : single retry after 2 s (handles transient Meta API blips)
    Hard fallback : plain-text numbered menu from MENU_ITEMS with NO time-slot
                    filtering (no send_category_list / send_item_list / items_for_slot)
    Last resort   : static prompt — customer is NEVER left with silence

    booking_step after this call:
      catalog delivered        → unchanged  (caller already set "awaiting_order")
      plain-text delivered     → "awaiting_numbered_order"
      last-resort static sent  → "awaiting_order" (re-attempt on next message)
    """
    logger.info(f"[catalog] _send_catalog_with_fallback called for {customer_phone}")

    # ── Attempt 1 ──────────────────────────────────────────────────────────────
    catalog_sent = False
    try:
        catalog_sent = await send_whatsapp_catalog_message(customer_phone, restaurant_id)
        logger.info(f"[catalog] attempt-1 result={catalog_sent} for {customer_phone}")
    except Exception as e:
        logger.warning(f"[catalog] attempt-1 raised: {e}")

    if catalog_sent:
        return

    # ── Attempt 2: retry after 2 s ────────────────────────────────────────────
    logger.warning(f"[catalog] attempt-1 failed for {customer_phone} — retrying in 2 s")
    await asyncio.sleep(2)
    try:
        catalog_sent = await send_whatsapp_catalog_message(customer_phone, restaurant_id)
        logger.info(f"[catalog] attempt-2 result={catalog_sent} for {customer_phone}")
    except Exception as e:
        logger.warning(f"[catalog] attempt-2 raised: {e}")

    if catalog_sent:
        return

    # ── Hard fallback: plain-text numbered menu ────────────────────────────────
    logger.warning(f"[catalog] both attempts failed for {customer_phone} — plain-text fallback")
    try:
        menu_text = plain_text_menu()   # no time-slot filtering
        if menu_text and menu_text.strip():
            await send_whatsapp_message(customer_phone, menu_text, restaurant_id)
            session_state["booking_step"] = "awaiting_numbered_order"
            logger.info(f"[catalog-fallback] plain-text menu delivered to {customer_phone}")
            return
        logger.error(f"[catalog-fallback] plain_text_menu() returned empty for {customer_phone}")
    except Exception as e:
        logger.error(f"[catalog-fallback] plain_text_menu() raised: {e}")

    # ── Last resort: static prompt — NEVER leave the customer in silence ───────
    logger.error(f"[catalog-fallback] last-resort static prompt for {customer_phone}")
    try:
        await send_whatsapp_message(
            customer_phone,
            (
                "🍽️ Our full menu is ready for you!\n\n"
                "Please type what you'd like to order, or reply *MENU* to see today's items.\n\n"
                "You can also tap the 🛍️ Shop icon at the top of this chat to browse and add items."
            ),
            restaurant_id,
        )
        session_state["booking_step"] = session_state.get("booking_step", "awaiting_order")
    except Exception as e:
        logger.critical(f"[catalog-fallback] even last-resort message failed for {customer_phone}: {e}")


# ─────────────────────────────────────────────
# RESET HELPERS
# ─────────────────────────────────────────────

async def _ask_continue_or_reset(
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


async def _do_reset(
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
        session_state.clear()
        session_state["next_state"] = "identity"
        session_state["identity_step"] = "initial"
        return

    _cid     = session_state.get("customer_id")
    _cname   = session_state.get("customer_name")
    _mphone  = session_state.get("manager_phone")
    _last    = session_state.get("last_order_summary")
    _ret     = session_state.get("is_returning_customer")
    _visits  = session_state.get("visit_count", 0)
    session_state.clear()
    if _cid:    session_state["customer_id"]          = _cid
    if _cname:  session_state["customer_name"]        = _cname
    if _mphone: session_state["manager_phone"]        = _mphone
    if _last:   session_state["last_order_summary"]   = _last
    if _ret:    session_state["is_returning_customer"]= _ret
    if _visits: session_state["visit_count"]          = _visits
    session_state["booking_step"] = "awaiting_service_selection"
    session_state["is_returning_customer"] = True
    raw_greeting = await _safe_build_greeting(customer_id, restaurant_id) if customer_id else ""
    reset_greeting = _build_smart_greeting(customer_name, raw_greeting, session_state)
    await _send_service_menu(customer_phone, restaurant_id, reset_greeting)


# ─────────────────────────────────────────────
# SHARED HELPERS
# ─────────────────────────────────────────────

async def _send_service_menu(customer_phone: str, restaurant_id: str, greeting: str) -> None:
    rows = await build_service_menu_rows(restaurant_id)
    _header_text = greeting[:57] + "..." if len(greeting) > 60 else greeting
    # Fix 28: body text no longer repeats the name; cleaner CTA
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


def _parse_booking_datetime(text: str) -> datetime | None:
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
        try: return datetime.strptime(text, fmt)
        except ValueError: continue
    return None


async def _send_menu(
    customer_phone: str, restaurant_id: str, session_state: Dict[str, Any] | None = None,
) -> None:
    """
    Fix 30: Catalog-first, no time-slot filtering.
    Delegates entirely to _send_catalog_with_fallback so the retry logic and
    plain-text hard fallback are in one place. send_category_list / send_item_list /
    items_for_slot are never called here.
    """
    if session_state is None:
        session_state = {}
    await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)


# ─────────────────────────────────────────────
# CONVERSATION INTELLIGENCE HELPERS
# ─────────────────────────────────────────────

async def _safe_classify_intent(message: str, flow: str, context: dict) -> str:
    try:
        result = await classify_intent(message, flow, context)
        return result.get("intent", "unknown")
    except ModuleNotFoundError as e:
        logger.debug(f"classify_intent skipped — missing module ({e}).")
        return "unknown"
    except Exception as e:
        logger.debug(f"classify_intent failed (non-fatal): {e}")
        return "unknown"

async def _safe_load_context(restaurant_id: str, customer_id: str) -> dict:
    try: return await load_conversation_context(restaurant_id, customer_id)
    except TypeError as e: logger.debug(f"load_conversation_context AsyncSession issue: {e}"); return {}
    except Exception as e: logger.debug(f"load_conversation_context failed: {e}"); return {}

async def _safe_log_event(
    restaurant_id: str, customer_id: str, session_id: str,
    event_type: str, intent: str, message: str,
) -> None:
    try:
        await log_conversation_event(restaurant_id, customer_id, session_id, event_type, intent, message)
    except TypeError as e: logger.debug(f"log_conversation_event AsyncSession issue: {e}")
    except Exception as e: logger.debug(f"log_conversation_event failed: {e}")

async def _safe_build_greeting(customer_id: str, restaurant_id: str) -> str:
    try: return await build_personalised_greeting(customer_id, restaurant_id)
    except TypeError as e: logger.debug(f"build_personalised_greeting AsyncSession issue: {e}"); return ""
    except Exception as e: logger.debug(f"build_personalised_greeting failed: {e}"); return ""

async def _safe_build_order_suggestion(customer_id: str, restaurant_id: str) -> str:
    try: return await build_order_suggestion(customer_id, restaurant_id)
    except TypeError as e: logger.debug(f"build_order_suggestion AsyncSession issue: {e}"); return ""
    except Exception as e: logger.debug(f"build_order_suggestion failed: {e}"); return ""


# ─────────────────────────────────────────────
# SMART GREETING BUILDER  (Fix 29)
# ─────────────────────────────────────────────

def _time_of_day_label() -> str:
    hour = datetime.now(ZoneInfo("Asia/Kolkata")).hour
    if 5  <= hour < 12: return "morning"
    if 12 <= hour < 17: return "afternoon"
    if 17 <= hour < 21: return "evening"
    return "night"


def _first_name(full_name: str) -> str:
    """Return first token of name, capitalised."""
    return full_name.strip().split()[0].capitalize() if full_name.strip() else full_name


# Warm returning-customer variants — keyed by (time_of_day, index % 4)
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

# Variants that mention the last order — appended when last_order is known
_LAST_ORDER_SUFFIXES = [
    " Your {last_order} last time was a great choice — want to go again?",
    " Loved the {last_order} on your last visit?",
    " The {last_order} was popular last time — it's on the menu again today! 😋",
    " Coming back for the {last_order} again? 😄",
]

# Variants for first-time customers
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


def _build_smart_greeting(
    customer_name: str,
    raw_greeting: str,
    session_state: Dict[str, Any],
) -> str:
    """
    Build a contextual greeting.

    Priority:
      1. If build_personalised_greeting returned a non-generic string → use it as-is.
      2. If session carries last_order/last_service → inject into returning variant.
      3. If session marks customer as returning → returning variant (no order hint).
      4. First-time / unknown → first-time variant or plain welcome.

    Greeting is capped at 60 chars for the WhatsApp list header; longer strings
    are used in full for plain-text fallback (header truncation handled elsewhere).
    """
    # Priority 1: trust personalisation_tools if it gave us something real
    if raw_greeting and raw_greeting.strip().lower() not in _GENERIC_GREETINGS:
        return raw_greeting

    tod   = _time_of_day_label()
    first = _first_name(customer_name)

    # Seed a stable-ish index from customer name length (no randomness = reproducible)
    idx = (len(customer_name) + len(first)) % 4

    last_order   = session_state.get("last_order_summary", "")   # e.g. "Chicken Biryani"
    is_returning = session_state.get("is_returning_customer", False)
    visit_count  = session_state.get("visit_count", 0)

    if is_returning or visit_count > 1:
        base = _RETURNING_VARIANTS.get(tod, _RETURNING_VARIANTS["evening"])[idx]
        greeting = base.format(first=first)
        if last_order:
            suffix_idx = idx % len(_LAST_ORDER_SUFFIXES)
            suffix = _LAST_ORDER_SUFFIXES[suffix_idx].format(last_order=last_order)
            # Keep total under 300 chars for WhatsApp body comfort
            if len(greeting) + len(suffix) <= 300:
                greeting += suffix
    else:
        variants = _FIRST_TIME_VARIANTS.get(tod, _FIRST_TIME_VARIANTS["evening"])
        greeting = variants[idx % len(variants)].format(first=first)

    return greeting


# ─────────────────────────────────────────────
# MAIN BOOKING FLOW ROUTER
# ─────────────────────────────────────────────

async def handle_booking_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any], table_number: int | None = None,
) -> Dict[str, Any]:

    context = await _safe_load_context(restaurant_id, customer_id)
    intent  = await _safe_classify_intent(message, "booking_flow", context)
    await _safe_log_event(
        restaurant_id, customer_id,
        f"booking_{session_state.get('booking_step', 'start')}",
        "booking_message", intent, message,
    )
    current_step = session_state.get("booking_step", "ask_service")

    # Fix 24: visit_complete
    if current_step == "visit_complete":
        if _is_feedback_reply(message):
            await send_whatsapp_message(
                customer_phone,
                "Thank you for your feedback! 🙏 We hope to see you again soon. 😊",
                restaurant_id,
            )
            return {"status": "visit_complete"}
        logger.info(f"[visit_complete] New message from {customer_phone} — treating as fresh visit.")
        session_state.clear()
        session_state["booking_step"] = "ask_service"
        current_step = "ask_service"

    # Explicit reset-keyword intercept
    if (current_step not in {"awaiting_reset_confirmation"}
            and message.strip().lower() in _RESET_KEYWORDS):
        session_state["step_before_reset"]     = current_step
        session_state["booking_step"]          = "awaiting_reset_confirmation"
        session_state["_full_restart_pending"] = True
        await _ask_continue_or_reset(customer_phone, restaurant_id, full_restart=True)
        return {"status": "awaiting_reset_confirmation"}

    # Global escape hatch
    if (current_step not in _STEPS_ALLOWING_SHORT_REPLY and _is_greeting(message)):
        session_state["step_before_reset"] = current_step
        session_state["booking_step"]      = "awaiting_reset_confirmation"
        await _ask_continue_or_reset(customer_phone, restaurant_id)
        return {"status": "awaiting_reset_confirmation"}

    # awaiting_payment stale-button guard
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
            raw_greeting = await _safe_build_greeting(customer_id, restaurant_id)
            # Mark as returning so smart greeting picks the right variant
            session_state["is_returning_customer"] = True
            ret_greeting = _build_smart_greeting(customer_name, raw_greeting, session_state)
            await _send_service_menu(customer_phone, restaurant_id, ret_greeting)
            session_state["booking_step"] = "awaiting_service_selection"
            return {"status": "awaiting_service_selection"}
        summary = session_state.get("order_confirmed_summary",
                                    f"Token *#{session_state.get('token_number', '')}*")
        await _send_interactive(customer_phone, {
            "interactive": {
                "type": "button",
                "body": {"text": f"✅ Your order is confirmed and being prepared!\n_{summary}_"},
                "footer": {"text": "Want to order something else?"},
                "action": {"buttons": [
                    {"type": "reply", "reply": {"id": "NEW ORDER", "title": "🆕 Place New Order"}},
                ]},
            }
        })
        return {"status": "awaiting_payment"}

    # Step 1: Show the service menu
    if current_step == "ask_service":
        if not session_state.get("_menu_sent"):
            raw_greeting = await _safe_build_greeting(customer_id, restaurant_id)
            greeting = _build_smart_greeting(customer_name, raw_greeting, session_state)
            await _send_service_menu(customer_phone, restaurant_id, greeting)
            session_state["_menu_sent"]   = True
            session_state["booking_step"] = "awaiting_service_selection"
        return {"status": "menu_sent"}

    # Step 2: Parse the service selection
    if current_step == "awaiting_service_selection":
        _raw_choice = message.strip()
        _SERVICE_TEXT_MAP = {
            "dine":"1","dine in":"1","dinein":"1","dine-in":"1","dine in now":"1","dining":"1","table":"1","eat in":"1",
            "takeaway":"2","take away":"2","take-away":"2","pickup":"2","pick up":"2","carry out":"2","parcel":"2","take out":"2","takeaway now":"2",
            "delivery":"3","deliver":"3","home delivery":"3","delivery now":"3",
            "reserve":"4","reservation":"4","book":"4","booking":"4","book a table":"4","reserve a table":"4",
        }
        choice = _SERVICE_TEXT_MAP.get(_raw_choice.lower(), _raw_choice)
        try:
            service_type = await resolve_service_choice(restaurant_id, choice)
        except ValueError:
            await send_whatsapp_message(customer_phone, "Sorry, I did not catch that. Please tap one of the options above.", restaurant_id)
            return {"status": "error"}

        if service_type is None:
            await send_whatsapp_message(customer_phone, "No problem! Feel free to message us anytime you need help. 😊", restaurant_id)
            session_state.clear()
            return {"status": "cancelled"}

        session_state["service_type"]  = service_type
        session_state["customer_name"] = customer_name
        session_state["manager_phone"] = manager_phone

        if service_type == "dine_in":
            await send_whatsapp_message(customer_phone, "How many people are dining today?", restaurant_id)
            session_state["booking_step"] = "awaiting_party_size"
            session_state["table_number"] = table_number
        elif service_type == "takeaway":
            await send_whatsapp_message(
                customer_phone,
                "Great! You've selected Takeaway 🛍️\n\nBrowse today's menu and add items to your basket 🛒",
                restaurant_id,
            )
            clear_cart(session_state)
            # Fix 27: set step BEFORE calling fallback so it cannot be overwritten
            # back to awaiting_order if catalog succeeds; fallback sets its own step.
            session_state["booking_step"] = "awaiting_order"
            await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
        elif service_type == "delivery":
            sent = await send_location_request(customer_phone, restaurant_id)
            if not sent:
                await send_whatsapp_message(
                    customer_phone,
                    "Great! You've selected Delivery 🛵\n\nPlease share your delivery address.",
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

    # Step 2b: Reset confirmation
    if current_step == "awaiting_reset_confirmation":
        choice = message.strip()
        if choice == "1":
            restored_step = session_state.pop("step_before_reset", "ask_service")
            session_state["booking_step"] = restored_step
            if restored_step in ("awaiting_order","awaiting_category_selection",
                                 "awaiting_item_selection","awaiting_cart_action",
                                 "awaiting_quantity","awaiting_item_qty","awaiting_numbered_order"):
                await send_whatsapp_message(customer_phone, "No problem, let's continue! 😊\n\nHere's the menu — tap to add items to your basket 🛒", restaurant_id)
                session_state["booking_step"] = "awaiting_order"
                await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            else:
                await send_whatsapp_message(customer_phone, "No problem, let's continue! 😊\n\nPlease tell us what you'd like to order.\nType *MENU* to see today's full menu.", restaurant_id)
            return {"status": restored_step}
        elif choice == "2":
            full_restart = session_state.pop("_full_restart_pending", False)
            await _do_reset(customer_id, customer_name, customer_phone, restaurant_id, session_state, full_restart=full_restart)
            return {"status": "identity_restart" if full_restart else "reset_complete"}
        else:
            await send_whatsapp_message(customer_phone, "Please tap *Continue my order* or *Start over*.", restaurant_id)
            return {"status": "error"}

    # Cart: confirming_order
    if current_step == "confirming_order":
        cart = session_state.get("cart", {})
        if not cart:
            await send_whatsapp_message(customer_phone, "Your cart is empty. Please add items first.", restaurant_id)
            session_state["booking_step"] = "awaiting_order"
            await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}
        session_state["order_from_cart"] = True
        session_state["booking_step"]    = "awaiting_order"
        svc = session_state.get("service_type")
        mp  = session_state.get("manager_phone", manager_phone)
        ot  = cart_to_order_text(cart)
        if svc == "dine_in":
            return await handle_dine_in_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state, table_number)
        elif svc == "takeaway":
            return await handle_takeaway_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state)
        elif svc == "delivery":
            return await handle_delivery_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state)
        else:
            # service_type unknown — re-send service menu cleanly
            raw_g = await _safe_build_greeting(customer_id, restaurant_id)
            greet = _build_smart_greeting(customer_name, raw_g, session_state)
            await _send_service_menu(customer_phone, restaurant_id, greet)
            session_state["booking_step"] = "awaiting_service_selection"
            return {"status": "awaiting_service_selection"}

    # Cart: awaiting_category_selection / awaiting_item_selection
    # Fix 30: These steps are now dead-paths — the catalog API is the only entry
    # point for browsing. If the customer somehow lands here (e.g. stale session),
    # re-send the catalog. Never call send_item_list / items_for_slot / current_time_slot.
    if current_step in ("awaiting_category_selection", "awaiting_item_selection"):
        logger.info(f"[router] stale step {current_step} for {customer_phone} — re-sending catalog")
        session_state["booking_step"] = "awaiting_order"
        await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
        return {"status": session_state.get("booking_step", "awaiting_order")}

    # Cart: awaiting_cart_action
    if current_step == "awaiting_cart_action":
        action = message.strip().upper()
        if action in ("CART:CONFIRM","CONFIRM","YES","Y","OK","OKAY"):
            cart = session_state.get("cart", {})
            if not cart:
                await send_whatsapp_message(customer_phone, "Your cart is empty. Please add items first.", restaurant_id)
                session_state["booking_step"] = "awaiting_order"
                await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
                return {"status": session_state.get("booking_step", "awaiting_order")}
            session_state["order_from_cart"] = True
            session_state["booking_step"]    = "awaiting_order"
            svc = session_state.get("service_type")
            mp  = session_state.get("manager_phone", manager_phone)
            ot  = cart_to_order_text(cart)
            if svc == "dine_in":
                return await handle_dine_in_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state, table_number)
            elif svc == "takeaway":
                return await handle_takeaway_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state)
            elif svc == "delivery":
                return await handle_delivery_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state)
        elif action in ("CART:ADD_MORE","ADD MORE","ADD","MORE"):
            # Fix 30: catalog-first, no send_category_list / items_for_slot
            session_state["booking_step"] = "awaiting_order"
            await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}
        elif action in ("CART:CLEAR","CLEAR","RESET CART"):
            clear_cart(session_state)
            await send_whatsapp_message(customer_phone, "Cart cleared! 🗑️ Let's start fresh.", restaurant_id)
            # Fix 30: catalog-first, no send_category_list / items_for_slot
            session_state["booking_step"] = "awaiting_order"
            await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}
        else:
            await send_cart_summary_buttons(customer_phone, session_state)
            return {"status": "awaiting_cart_action"}

    # Cart: awaiting_numbered_order
    # Emergency plain-text path — only reached when the catalog API failed twice.
    # Primary goal: get customer back onto the catalog ASAP, or submit their order.
    if current_step == "awaiting_numbered_order":
        text = message.strip()
        cat  = session_state.get("current_category")

        # "DONE" or "CONFIRM" — submit whatever is in the cart
        if text.upper() in ("DONE", "CONFIRM"):
            cart = session_state.get("cart", {})
            if not cart:
                # Cart empty — retry the catalog so they can pick items properly
                await send_whatsapp_message(customer_phone, "Your cart is empty. Retrying the menu for you...", restaurant_id)
                session_state["booking_step"] = "awaiting_order"
                await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
                return {"status": session_state.get("booking_step", "awaiting_order")}
            # Cart has items — forward directly to the right sub-flow
            session_state["order_from_cart"] = True
            session_state["booking_step"]    = "awaiting_order"
            svc = session_state.get("service_type")
            mp  = session_state.get("manager_phone", manager_phone)
            ot  = cart_to_order_text(cart)
            if svc == "dine_in":
                return await handle_dine_in_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state, table_number)
            elif svc == "takeaway":
                return await handle_takeaway_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state)
            elif svc == "delivery":
                return await handle_delivery_flow(restaurant_id, customer_id, customer_name, customer_phone, mp, ot, session_state)

        # "MENU" — re-attempt the catalog (primary channel) instead of re-sending plain text
        if text.upper() == "MENU":
            session_state["booking_step"] = "awaiting_order"
            await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        # Numbered item selection (plain-text fallback ordering)
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

    # Step 3: delegate to sub-flow
    service_type  = session_state.get("service_type")
    manager_phone = session_state.get("manager_phone", manager_phone)
    if service_type == "dine_in":
        return await handle_dine_in_flow(restaurant_id, customer_id, customer_name, customer_phone, manager_phone, message, session_state, table_number)
    elif service_type == "takeaway":
        return await handle_takeaway_flow(restaurant_id, customer_id, customer_name, customer_phone, manager_phone, message, session_state)
    elif service_type == "delivery":
        return await handle_delivery_flow(restaurant_id, customer_id, customer_name, customer_phone, manager_phone, message, session_state)
    elif service_type == "reserve_table":
        return await handle_reserve_table_flow(restaurant_id, customer_id, customer_name, customer_phone, manager_phone, message, session_state)

    raw_greeting = await _safe_build_greeting(customer_id, restaurant_id)
    greeting = (raw_greeting if raw_greeting and raw_greeting.strip().lower() not in _GENERIC_GREETINGS
                else f"Welcome, {customer_name}! 😊")
    await _send_service_menu(customer_phone, restaurant_id, greeting)
    session_state["booking_step"] = "awaiting_service_selection"
    return {"status": "menu_sent"}


# ─────────────────────────────────────────────
# DINE-IN FLOW
# ─────────────────────────────────────────────

async def handle_dine_in_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any], table_number: int | None = None,
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    if booking_step == "awaiting_party_size":
        try:
            party_size = _parse_party_size(message)
            session_state["party_size"] = party_size

            if party_size > LARGE_PARTY_THRESHOLD:
                result = await _check_large_party_seating(party_size, restaurant_id)

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
                    combo_msg = _format_combo_message(result["combination"], party_size)
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

            # Normal flow
            token        = await get_next_token_number(restaurant_id)
            booking_time = _now_display()
            session_state["token_number"] = token

            portal_token_id = await _sync_token_to_portal(
                customer_name=customer_name, customer_phone=customer_phone,
                token_type="dinein", pax=party_size,
            )
            display_token = portal_token_id or token
            session_state["display_token"] = display_token

            await send_whatsapp_message(
                manager_phone,
                f"🪑 *New Walk-in* — Token *{display_token}*\n"
                f"👤 {customer_name}, {party_size} {'person' if party_size == 1 else 'people'}\n"
                f"🍽️ Dine-in\n🕐 {booking_time}\n\n"
                f"Open portal to assign table:\n{MANAGER_PORTAL_URL}",
                restaurant_id,
            )
            # Fix 28: reworded dine-in check-in message — shorter wait hint + catalog tip
            await send_whatsapp_message(
                customer_phone,
                f"You're all checked in! 🍽️\n\n"
                f"*Token: {display_token}*\n\n"
                f"We're assigning your table now — usually takes just a minute or two. "
                f"You'll get a WhatsApp message the moment it's confirmed.\n\n"
                f"While you wait, feel free to browse the menu using the 🛍️ Shop icon at the top of this chat. 😊",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_table_assignment"
            return {"status": "awaiting_table_assignment"}

        except ValueError:
            await send_whatsapp_message(customer_phone, "Please enter a valid number of people (e.g. 2).", restaurant_id)
            return {"status": "error"}

    elif booking_step == "awaiting_large_party_response":
        reply = message.strip().upper()

        if reply in ("RESERVE",):
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
            await send_whatsapp_message(customer_phone, "No problem! How many people will be dining today?", restaurant_id)
            return {"status": "awaiting_party_size"}

        elif reply in ("YES", "CONFIRM") and session_state.get("_pending_combo"):
            combo      = session_state.get("_pending_combo", [])
            party_size = session_state.get("party_size", 1)
            portal_token_id = await _sync_token_to_portal_large_party(
                customer_name=customer_name, customer_phone=customer_phone, pax=party_size, combo=combo,
            )
            display_token = portal_token_id or f"#{party_size}pax"
            session_state["display_token"] = display_token
            await send_whatsapp_message(
                customer_phone,
                f"✅ Your request for *{party_size} people* has been sent to our manager for approval.\n\n"
                f"Token: *{display_token}*\n\n"
                f"We'll confirm your tables shortly. If you don't hear back within "
                f"5 minutes, please speak to our staff directly. 😊",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_manager_approval"
            return {"status": "awaiting_manager_approval"}

        else:
            await send_whatsapp_message(customer_phone, "Please tap one of the options above to continue.", restaurant_id)
            return {"status": "awaiting_large_party_response"}

    elif booking_step == "awaiting_manager_approval":
        await send_whatsapp_message(
            customer_phone,
            "⏳ We're still waiting for manager confirmation on your table arrangement. "
            "Please hold on — we'll notify you shortly! 😊\n\n"
            "If it's urgent, please speak to our staff directly.",
            restaurant_id,
        )
        return {"status": "awaiting_manager_approval"}

    elif booking_step == "awaiting_table_assignment":
        table_assigned = session_state.get("table_number")
        if not table_assigned:
            table_assigned = await _lookup_table_assignment(customer_phone)
            if table_assigned:
                session_state["table_number"] = table_assigned

        if table_assigned:
            session_state["booking_step"] = "awaiting_order"
            await send_whatsapp_message(
                customer_phone,
                f"✅ Your table has been confirmed — *Table {table_assigned}*!\n\n"
                f"Browse our menu below and place your order 🍽️",
                restaurant_id,
            )
            # Fix 26: time-slot filtering via _send_catalog_with_fallback
            await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": "awaiting_order"}
        else:
            await send_whatsapp_message(
                customer_phone,
                "⏳ We're still assigning your table. You'll receive a WhatsApp message "
                "with your table number shortly. If you've been waiting more than 5 minutes, "
                "please speak to our staff directly. 😊",
                restaurant_id,
            )
            return {"status": "awaiting_table_assignment"}

    elif booking_step == "awaiting_order":
        order_text = message.strip()
        if order_text.upper() == "MENU":
            await _send_menu(customer_phone, restaurant_id, session_state)
            return {"status": "awaiting_order"}

        cart          = session_state.get("cart", {})
        cart_snapshot = dict(cart)
        total         = cart_total(cart) if cart else 0.0
        token         = session_state.get("display_token", session_state.get("token_number", ""))
        booking_time  = session_state.get("booking_time", _now_display())
        suggestion    = await _safe_build_order_suggestion(customer_id, restaurant_id)

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
            payment_line = ("💳 Payment can be made at the counter."
                            if _is_placeholder_payment_link(payment_link)
                            else f"Pay here: {payment_link}")

            confirmation = (
                f"Your order has been placed! 🎉\n"
                f"────────────────────\n"
                f"Token: {token}\nOrder: {order_text}\n"
                f"────────────────────\n"
                f"Total: ₹{total:.0f}\n\n{payment_line}"
            )
            if suggestion: confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            # Fix 28: reworded special-notes prompt — warmer, removes cold "2-minute" footer
            notes_hint = _build_notes_hint(order_text)
            await _send_interactive(customer_phone, {
                "interactive": {
                    "type": "button",
                    "body": {"text": (
                        f"👨‍🍳 Any requests for the kitchen? (optional)\n\n"
                        f"{notes_hint}\n\n"
                        "Just type it out, or tap below to skip 👇"
                    )},
                    "footer": {"text": "Your order is already being prepared!"},
                    "action": {"buttons": [
                        {"type": "reply", "reply": {"id": "SKIP", "title": "⏭️ No notes"}},
                    ]},
                }
            })
            session_state["special_notes_asked_at"] = time.time()
            start_special_notes_timer(customer_phone, restaurant_id)  # Fix 23

            await send_whatsapp_message(
                manager_phone,
                f"📋 Order Received — Dine-in\n────────────────────\n"
                f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                f"Table: {session_state.get('table_number', 'TBD')}\n"
                f"Guests: {session_state.get('party_size')}\nBooking Time: {booking_time}\n"
                f"Order: {order_text}\nTotal: ₹{total:.0f}\n────────────────────",
                restaurant_id,
            )
            session_state["order_confirmed_summary"] = (
                f"Dine-in Token *{token}* — {order_text} "
                f"({session_state.get('party_size')} guests, ₹{total:.0f})"
            )
            # Fix 29: persist for smart greeting on next visit
            _first_item = order_text.split(",")[0].strip()[:40]
            session_state["last_order_summary"]    = _first_item
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = session_state.get("visit_count", 0) + 1
            session_state["_kds_cart_snapshot"] = cart_snapshot
            session_state["_kds_order_text"]    = order_text
            session_state["booking_step"] = "awaiting_special_notes"
            clear_cart(session_state)
            return {"status": "awaiting_special_notes", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create dine-in booking: {e}")
            await send_whatsapp_message(customer_phone, "Sorry, there was an error processing your order. Please try again.", restaurant_id)
            return {"status": "error"}

    elif booking_step == "awaiting_special_notes":
        raw_notes: str = message.strip()
        token = session_state.get("display_token", session_state.get("token_number", ""))

        stop_special_notes_timer(customer_phone)  # Fix 23

        # Auto-close: more than 2 minutes → treat as no notes
        asked_at  = session_state.get("special_notes_asked_at", 0)
        timed_out = (time.time() - asked_at) > 120
        if timed_out:
            raw_notes = "SKIP"

        if not raw_notes or raw_notes.upper() in ("SKIP", "NO", "NONE"):
            special_notes: str | None = None
            await send_whatsapp_message(customer_phone, "No problem! Your order is being prepared. Enjoy your meal! 🍽️", restaurant_id)
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
            await send_whatsapp_message(
                customer_phone,
                "✅ Got it! Your notes have been saved.\n\n"
                "Sit back and enjoy — your order is being prepared! 🍽️",
                restaurant_id,
            )

        session_state["special_notes"] = special_notes
        session_state["booking_step"]  = "awaiting_payment"

        await _notify_kds(
            customer_name=customer_name,
            customer_phone=customer_phone,
            order_text=session_state.pop("_kds_order_text", ""),
            cart=session_state.pop("_kds_cart_snapshot", {}),
            table_number=session_state.get("table_number"),
            token_number=token,
            service_type="dine_in",
            special_notes=special_notes,
        )

        # Queue feedback request — sent 2 hours later via server.js scheduler
        try:
            async with aiohttp.ClientSession() as http:
                await http.post(
                    "https://autom8-backend-production.up.railway.app/api/feedback/queue",
                    json={
                        "customer_phone": customer_phone,
                        "customer_name":  customer_name,
                        "token_number":   token,
                        "table_number":   str(session_state.get("table_number", "")),
                    },
                    headers={"Authorization": f"Bearer {_KDS_SECRET}"},
                    timeout=aiohttp.ClientTimeout(total=5),
                )
        except Exception as fb_err:
            logger.warning(f"[feedback-queue] Non-fatal: {fb_err}")

        # Fix 24: transition to visit_complete (not awaiting_payment)
        session_state["booking_step"] = "visit_complete"
        return {"status": "visit_complete"}

    return {"status": "error"}


# ─────────────────────────────────────────────
# TAKEAWAY FLOW
# ─────────────────────────────────────────────

async def handle_takeaway_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    if booking_step == "awaiting_order":
        order_text = message.strip()
        if order_text.upper() == "MENU":
            await _send_menu(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart = session_state.get("cart", {})

        # Fix 31: empty cart + noise message → re-send catalog, don't create ₹0 booking
        if not cart and len(order_text) < 3:
            logger.info(f"[takeaway] empty cart + short message '{order_text}' — re-sending catalog")
            await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart_snapshot = dict(cart)
        total         = cart_total(cart) if cart else 0.0
        token         = await get_next_token_number(restaurant_id)
        booking_time  = _now_display()
        session_state["token_number"] = token

        portal_token_id = await _sync_token_to_portal(
            customer_name=customer_name, customer_phone=customer_phone,
            token_type="takeaway", pax=1,
        )
        display_token = portal_token_id or token
        session_state["display_token"] = display_token

        await send_whatsapp_message(
            manager_phone,
            f"🛍️ *New Walk-in* — Token *{display_token}*\n"
            f"👤 {customer_name}\n📦 Takeaway\n🕐 {booking_time}\n\n"
            f"Open portal to manage:\n{MANAGER_PORTAL_URL}",
            restaurant_id,
        )

        try:
            booking = await create_booking(restaurant_id, customer_id, "takeaway", token_number=token)
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            payment_link = await create_payment_link(booking_id, total, customer_name, f"Takeaway {token}")
            suggestion   = await _safe_build_order_suggestion(customer_id, restaurant_id)
            payment_line = ("💳 Payment can be made at the counter."
                            if _is_placeholder_payment_link(payment_link)
                            else f"Pay here: {payment_link}")

            confirmation = (
                f"Your order has been placed! 🎉\n────────────────────\n"
                f"Token: {display_token}\nBooking Time: {booking_time}\n"
                f"Order: {order_text}\n────────────────────\n"
                f"Total: ₹{total:.0f}\n\n{payment_line}"
            )
            if suggestion: confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            await send_whatsapp_message(
                manager_phone,
                f"📋 Order Details — Takeaway\n────────────────────\n"
                f"Token: {display_token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                f"Booking Time: {booking_time}\nOrder: {order_text}\nTotal: ₹{total:.0f}\n"
                f"────────────────────",
                restaurant_id,
            )
            session_state["order_confirmed_summary"] = (
                f"Takeaway Token *{display_token}* — {order_text} (₹{total:.0f})"
            )
            # Fix 29: persist for smart greeting on next visit
            _first_item = order_text.split(",")[0].strip()[:40]
            session_state["last_order_summary"]    = _first_item
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = session_state.get("visit_count", 0) + 1
            session_state["booking_step"] = "awaiting_payment"
            clear_cart(session_state)

            await _notify_kds(
                customer_name=customer_name, customer_phone=customer_phone,
                order_text=order_text, cart=cart_snapshot, table_number=None,
                token_number=display_token, service_type="takeaway",
            )
            return {"status": "awaiting_payment", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create takeaway booking: {e}")
            return {"status": "error"}

    return {"status": "error"}


# ─────────────────────────────────────────────
# DELIVERY FLOW
# ─────────────────────────────────────────────

async def handle_delivery_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    if booking_step == "awaiting_address":
        raw = message.strip()
        if raw.startswith("LOCATION:"):
            try:
                coords_part, label = raw[len("LOCATION:"):].split("|", 1)
                lat, lng = coords_part.split(",", 1)
                maps_link = f"https://maps.google.com/?q={lat.strip()},{lng.strip()}"
                delivery_address = f"{label.strip()} ({maps_link})"
            except Exception:
                delivery_address = raw
        else:
            delivery_address = raw

        session_state["delivery_address"] = delivery_address
        await send_whatsapp_message(
            customer_phone,
            "Thank you! Estimated delivery: 30-45 mins.\n\nBrowse today's menu below and add items to your basket 🛒",
            restaurant_id,
        )
        clear_cart(session_state)
        # Fix 27: set step to awaiting_order; _send_catalog_with_fallback will
        # override to awaiting_category_selection if it needs the fallback path.
        session_state["booking_step"] = "awaiting_order"
        await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
        return {"status": session_state["booking_step"]}

    elif booking_step == "awaiting_order":
        order_text = message.strip()
        if order_text.upper() == "MENU":
            await _send_menu(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart = session_state.get("cart", {})

        # Fix 31: empty cart + noise message → re-send catalog, don't create ₹0 booking
        if not cart and len(order_text) < 3:
            logger.info(f"[delivery] empty cart + short message '{order_text}' — re-sending catalog")
            await _send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart_snapshot = dict(cart)
        items_total   = cart_total(cart) if cart else 0.0
        total         = items_total + DELIVERY_CHARGE
        token         = await get_next_token_number(restaurant_id)
        booking_time  = _now_display()
        session_state["token_number"] = token

        try:
            booking = await create_booking(
                restaurant_id, customer_id, "delivery",
                delivery_address=session_state.get("delivery_address"), token_number=token,
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            payment_link = await create_payment_link(booking_id, total, customer_name, f"Delivery {token}")
            suggestion   = await _safe_build_order_suggestion(customer_id, restaurant_id)
            payment_line = ("💳 Payment can be made on delivery."
                            if _is_placeholder_payment_link(payment_link)
                            else f"Pay here: {payment_link}")

            confirmation = (
                f"Your order has been placed! 🎉\n────────────────────\n"
                f"Token: {token}\nBooking Time: {booking_time}\nOrder: {order_text}\n"
                f"Items: ₹{items_total:.0f}\nDelivery charge: ₹{DELIVERY_CHARGE:.0f}\n"
                f"────────────────────\nTotal: ₹{total:.0f}\n\n{payment_line}"
            )
            if suggestion: confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            await send_whatsapp_message(
                manager_phone,
                f"🛵 New Delivery Order\n────────────────────\n"
                f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                f"Address: {session_state.get('delivery_address')}\nBooking Time: {booking_time}\n"
                f"Order: {order_text}\nTotal: ₹{total:.0f} (incl. ₹{DELIVERY_CHARGE:.0f} delivery)\n"
                f"────────────────────",
                restaurant_id,
            )
            session_state["order_confirmed_summary"] = (
                f"Delivery Token *{token}* — {order_text} "
                f"to {session_state.get('delivery_address', '')[:40]} (₹{total:.0f})"
            )
            # Fix 29: persist for smart greeting on next visit
            _first_item = order_text.split(",")[0].strip()[:40]
            session_state["last_order_summary"]    = _first_item
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = session_state.get("visit_count", 0) + 1
            session_state["booking_step"] = "awaiting_payment"
            clear_cart(session_state)

            await _notify_kds(
                customer_name=customer_name, customer_phone=customer_phone,
                order_text=order_text, cart=cart_snapshot, table_number=None,
                token_number=token, service_type="delivery",
            )
            return {"status": "awaiting_payment", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create delivery booking: {e}")
            return {"status": "error"}

    return {"status": "error"}


# ─────────────────────────────────────────────
# RESERVE TABLE FLOW
# ─────────────────────────────────────────────

async def handle_reserve_table_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    if booking_step == "awaiting_party_size":
        try:
            party_size = _parse_party_size(message)
            session_state["party_size"] = party_size

            flow_id = settings.meta_flow_reservation_id
            if flow_id and flow_id != "your_flow_id_here":
                flow_token = f"reserve_{customer_id}_{int(time.time())}"
                session_state["flow_token"] = flow_token
                ok = await send_whatsapp_flow(
                    phone=customer_phone, flow_id=flow_id, flow_token=flow_token,
                    flow_cta="Select Date & Time", flow_header="📅 Table Reservation",
                    flow_body=(
                        f"Hi {customer_name}! Please select your preferred date and time "
                        f"for your party of {party_size} guests."
                    ),
                    flow_footer="Restaurant hours: 10:00 AM - 11:00 PM",
                    restaurant_id=restaurant_id,
                )
                if ok:
                    session_state["booking_step"] = "awaiting_flow_datetime"
                    return {"status": "awaiting_flow_datetime"}

            await send_whatsapp_message(
                customer_phone,
                "Please share your preferred date and time.\nExample: 25-05-2026, 8:00 PM",
                restaurant_id,
            )
            session_state["booking_step"] = "awaiting_datetime"
            return {"status": "awaiting_datetime"}

        except ValueError:
            await send_whatsapp_message(customer_phone, "Please enter a valid number of people (e.g. 4).", restaurant_id)
            return {"status": "error"}

    elif booking_step in ("awaiting_datetime", "awaiting_flow_datetime"):
        parsed_dt = None

        if booking_step == "awaiting_flow_datetime" and message.startswith("FLOW:"):
            try:
                parts = message.split("|")
                data  = {}
                for part in parts[1:]:
                    if "=" in part:
                        k, v = part.split("=", 1)
                        data[k.strip()] = v.strip()
                date_str = data.get("date", "")
                time_str = data.get("time", "")
                if date_str and time_str:
                    parsed_dt = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
            except Exception as e:
                logger.error(f"Failed to parse Flow response: {e}")
        else:
            parsed_dt = _parse_booking_datetime(message.strip())

        if parsed_dt is None:
            await send_whatsapp_message(
                customer_phone,
                "Sorry, I couldn't understand that date and time. 🙏\n\n"
                "Please use this format:\nExample: 25-05-2026, 8:00 PM",
                restaurant_id,
            )
            return {"status": "error"}

        if parsed_dt <= datetime.now():
            await send_whatsapp_message(
                customer_phone,
                f"Oops! *{parsed_dt.strftime('%d %b %Y, %I:%M %p')}* has already passed. 😊\n\n"
                "Please send a future date and time.\nExample: 25-05-2026, 8:00 PM",
                restaurant_id,
            )
            return {"status": "error"}

        advance_amount = 150.0
        formatted_dt   = parsed_dt.strftime("%d %b %Y, %I:%M %p")
        session_state["booking_datetime"] = parsed_dt.isoformat()
        session_state["advance_amount"]   = advance_amount
        session_state["booking_step"]     = "awaiting_advance_confirmation"

        ok = await _send_interactive(customer_phone, {
            "interactive": {
                "type": "button",
                "body": {"text": (
                    f"Great choice! Here's your reservation summary:\n────────────────────\n"
                    f"Name: {customer_name}\nDate & Time: {formatted_dt}\n"
                    f"Guests: {session_state.get('party_size')}\n────────────────────\n\n"
                    f"A token advance of ₹{advance_amount:.0f} is required to confirm your table. This amount will be adjusted during your visit"
                )},
                "footer": {"text": "Tap to confirm or cancel"},
                "action": {"buttons": [
                    {"type": "reply", "reply": {"id": "YES", "title": "✅ Yes, confirm"}},
                    {"type": "reply", "reply": {"id": "NO",  "title": "❌ Cancel"}},
                ]},
            }
        })
        if not ok:
            await send_whatsapp_message(
                customer_phone,
                f"Great choice! Here's your reservation summary:\n────────────────────\n"
                f"Name: {customer_name}\nDate & Time: {formatted_dt}\n"
                f"Guests: {session_state.get('party_size')}\n────────────────────\n\n"
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
            await send_whatsapp_message(customer_phone, "Please tap *Yes, confirm* to proceed or *Cancel* to cancel.", restaurant_id)
            return {"status": "error"}

        token                = await get_next_token_number(restaurant_id)
        booking_time         = _now_display()
        advance_amount       = session_state.get("advance_amount", 150.0)
        party_size           = session_state.get("party_size")
        booking_datetime_iso = session_state.get("booking_datetime", "")
        session_state["token_number"] = token

        await _sync_token_to_portal(
            customer_name=customer_name, customer_phone=customer_phone,
            token_type="dinein", pax=party_size or 1,
        )

        try:
            booking = await create_booking(
                restaurant_id, customer_id, "reserve_table",
                party_size=party_size, booking_datetime=booking_datetime_iso, token_number=token,
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            payment_link = await create_payment_link(
                booking_id, advance_amount, customer_name,
                f"Reservation {token} for {party_size} people",
            )

            try:
                display_dt = datetime.fromisoformat(booking_datetime_iso).strftime("%d %b %Y, %I:%M %p")
            except Exception:
                display_dt = booking_datetime_iso

            if _is_placeholder_payment_link(payment_link):
                payment_line = (
                    f"💳 Please pay the advance of ₹{advance_amount:.0f} at the counter when you arrive.\n"
                    f"Your table is provisionally held."
                )
            else:
                payment_line = f"Please complete payment to secure your table:\n{payment_link}"

            summary = (
                f"Reservation confirmed! 🎉\n────────────────────\n"
                f"Token: {token}\nBooking Time: {booking_time}\n"
                f"Date & Time: {display_dt}\nGuests: {party_size}\n"
                f"Advance: ₹{advance_amount:.0f}\n────────────────────\n\n"
                f"{payment_line}\n\nJust tell our staff your token *{token}* when you arrive!"
            )
            await send_whatsapp_message(customer_phone, summary, restaurant_id)

            session_state["order_confirmed_summary"] = (
                f"Table Reservation Token *{token}* — {display_dt} "
                f"for {party_size} guests (advance ₹{advance_amount:.0f})"
            )
            session_state["booking_step"] = "awaiting_payment"
            return {"status": "awaiting_payment", "booking_id": booking_id, "total": advance_amount}

        except Exception as e:
            logger.error(f"Failed to create reservation: {e}")
            await send_whatsapp_message(customer_phone, "Sorry, there was an error creating your reservation. Please try again.", restaurant_id)
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
