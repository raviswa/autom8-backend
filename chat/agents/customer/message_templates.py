"""Warm, restaurant-specific WhatsApp message templates for customer conversations."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

_CUISINE_LINES: dict[str, str] = {
    "veg": "Serving fresh, flavourful vegetarian food every day!",
    "non_veg": "Serving fresh, flavourful non-vegetarian favourites every day!",
    "asian": "Serving bold, wok-fresh Asian flavours every day!",
    "continental": "Serving fresh, flavourful continental classics every day!",
    "fast_food": "Serving hot, fresh comfort bites every day!",
}

_CUISINE_MENU_HOOKS: dict[str, str] = {
    "veg": "Everything on our menu is 100% vegetarian.",
    "non_veg": "From starters to mains — all made fresh.",
    "asian": "Wok-fresh, every order.",
    "continental": "Made to order, plated with care.",
    "fast_food": "Fast, fresh, and exactly how you like it.",
}


def parse_cuisine_tags(cuisine_type: str | None) -> list[str]:
    """Map restaurants.cuisine_type text to template cuisine keys."""
    raw = (cuisine_type or "").lower()
    tags: list[str] = []
    if "non" in raw and "veg" in raw:
        tags.append("non_veg")
    elif "veg" in raw or "vegetarian" in raw:
        tags.append("veg")
    for key in ("asian", "continental", "fast_food"):
        token = key.replace("_", " ")
        if token in raw or key in raw:
            tags.append(key)
    return tags


def get_time_period(timezone: str) -> tuple[str, str]:
    """Returns (period_name, emoji) based on restaurant local time."""
    try:
        tz = ZoneInfo(timezone or "Asia/Kolkata")
    except Exception:
        tz = ZoneInfo("Asia/Kolkata")
    hour = datetime.now(tz).hour
    if 5 <= hour < 12:
        return "morning", "🌅"
    if 12 <= hour < 17:
        return "afternoon", "☀️"
    if 17 <= hour < 21:
        return "evening", "🌆"
    return "night", "🌙"


def build_greeting(
    is_new: bool,
    customer_name: str | None,
    restaurant_display_name: str,
    restaurant_cuisine: list[str],
    timezone: str,
) -> str:
    """Structured greeting for service menu opening."""
    period, _ = get_time_period(timezone)
    display = (restaurant_display_name or "our restaurant").strip()

    primary_cuisine = next(
        (c for c in (restaurant_cuisine or []) if c in _CUISINE_LINES),
        None,
    )
    warmth = _CUISINE_LINES.get(primary_cuisine, "Good food, your way.")

    greet = f"Good {period.capitalize()}"
    welcome = "Welcome to" if is_new else "Welcome back to"

    return (
        f"{greet} 👋\n"
        f"{welcome} *{display}* 🍽️\n"
        f"{warmth}"
    )


def build_menu_intro(
    restaurant_display_name: str,
    restaurant_cuisine: list[str],
    customer_name: str | None,
    is_new: bool,
) -> str:
    """Warm menu opening message. Cuisine-aware, not generic."""
    display = (restaurant_display_name or "our restaurant").strip()
    primary = next(
        (c for c in (restaurant_cuisine or []) if c in _CUISINE_MENU_HOOKS),
        None,
    )
    hook = _CUISINE_MENU_HOOKS.get(primary, "Fresh and made to order.")

    name_line = ""
    db_name = (customer_name or "").strip()
    if db_name and not is_new:
        first = db_name.split()[0]
        name_line = f"Here's what's on today, {first}:\n"

    return (
        f"🍽️ *{display}*\n"
        f"{name_line}"
        f"{hook}\n\n"
        f"Browse the menu below, pick your items, and we'll take care of the rest."
    )


async def ensure_restaurant_greeting_context(
    session_state: dict[str, Any],
    restaurant_id: str,
) -> None:
    """Load restaurant display name, cuisine, and timezone once per session."""
    if session_state.get("_greeting_ctx_loaded"):
        return
    from tools.booking_mechanisms import fetch_restaurant_info

    info = await fetch_restaurant_info(restaurant_id)
    session_state["_restaurant_display_name"] = (
        (info.get("display_name") or info.get("name") or "our restaurant").strip()
    )
    session_state["_restaurant_timezone"] = (info.get("timezone") or "Asia/Kolkata").strip()
    session_state["_restaurant_cuisine"] = parse_cuisine_tags(info.get("cuisine_type"))
    session_state["_greeting_ctx_loaded"] = True


async def resolve_is_new_customer(
    session_state: dict[str, Any],
    restaurant_id: str,
    customer_phone: str,
) -> bool:
    """
    True = first conversation from this phone at this restaurant.
    Prefer session flag set at identity completion; fall back to fresh DB lookup.
    """
    if "is_new_customer" in session_state:
        return bool(session_state["is_new_customer"])

    from tools.db_tools import get_customer

    customer = await get_customer(restaurant_id, customer_phone)
    is_new = customer is None
    session_state["is_new_customer"] = is_new
    session_state["is_returning_customer"] = not is_new
    if customer:
        session_state["_customer_db_name"] = customer.get("name")
    return is_new


async def build_conversation_greeting(
    session_state: dict[str, Any],
    restaurant_id: str,
    customer_phone: str,
    customer_name: str,
) -> str:
    """Build greeting from fresh is_new signal and restaurant context."""
    await ensure_restaurant_greeting_context(session_state, restaurant_id)
    is_new = await resolve_is_new_customer(session_state, restaurant_id, customer_phone)

    db_name = session_state.get("_customer_db_name")
    if db_name is None and not is_new:
        from tools.db_tools import get_customer

        customer = await get_customer(restaurant_id, customer_phone)
        if customer:
            db_name = customer.get("name")
            session_state["_customer_db_name"] = db_name

    name_for_greeting = None if is_new else (db_name or customer_name or None)

    return build_greeting(
        is_new=is_new,
        customer_name=name_for_greeting,
        restaurant_display_name=session_state.get("_restaurant_display_name", "our restaurant"),
        restaurant_cuisine=session_state.get("_restaurant_cuisine", []),
        timezone=session_state.get("_restaurant_timezone", "Asia/Kolkata"),
    )
