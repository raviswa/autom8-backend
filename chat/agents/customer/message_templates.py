"""Warm, restaurant-specific WhatsApp message templates for customer conversations."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from locales.customer import reply, session_lang

_CUISINE_KEYS = ("veg", "non_veg", "asian", "continental", "fast_food")


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


def get_time_period(timezone: str, lang: str | None = None) -> tuple[str, str]:
    """Returns (localized period_name, emoji) based on restaurant local time."""
    try:
        tz = ZoneInfo(timezone or "Asia/Kolkata")
    except Exception:
        tz = ZoneInfo("Asia/Kolkata")
    hour = datetime.now(tz).hour
    if 5 <= hour < 12:
        key = "period_morning"
        emoji = "🌅"
    elif 12 <= hour < 17:
        key = "period_afternoon"
        emoji = "☀️"
    elif 17 <= hour < 21:
        key = "period_evening"
        emoji = "🌆"
    else:
        key = "period_night"
        emoji = "🌙"
    return reply(lang, key), emoji


def build_greeting(
    is_new: bool,
    customer_name: str | None,
    restaurant_display_name: str,
    restaurant_cuisine: list[str],
    timezone: str,
    lang: str | None = None,
) -> str:
    """Structured greeting for service menu opening."""
    period, _ = get_time_period(timezone, lang)
    display = (restaurant_display_name or "our restaurant").strip()

    primary_cuisine = next(
        (c for c in (restaurant_cuisine or []) if c in _CUISINE_KEYS),
        None,
    )
    warmth_key = f"cuisine_{primary_cuisine}" if primary_cuisine else "cuisine_default"
    warmth = reply(lang, warmth_key)

    period_display = period.capitalize() if (lang or "en") == "en" else period
    first = ""
    if customer_name:
        first = customer_name.strip().split()[0]

    if first:
        greet = reply(
            lang, "greet_good_period_named", period=period_display, first=first,
        )
        welcome = reply(
            lang,
            "welcome_new_named" if is_new else "welcome_back_named",
            first=first,
            display=display,
        )
    else:
        greet = reply(lang, "greet_good_period", period=period_display)
        welcome = reply(lang, "welcome_new" if is_new else "welcome_back", display=display)

    return f"{greet}\n{welcome}\n{warmth}"


def build_menu_intro(
    restaurant_display_name: str,
    restaurant_cuisine: list[str],
    customer_name: str | None,
    is_new: bool,
    lang: str | None = None,
) -> str:
    """Warm menu opening message. Cuisine-aware, not generic."""
    display = (restaurant_display_name or "our restaurant").strip()
    primary = next(
        (c for c in (restaurant_cuisine or []) if c in _CUISINE_KEYS),
        None,
    )
    hook_key = f"menu_hook_{primary}" if primary else "menu_hook_default"
    hook = reply(lang, hook_key)

    name_line = ""
    db_name = (customer_name or "").strip()
    if db_name and not is_new:
        first = db_name.split()[0]
        name_line = reply(lang, "menu_intro_named", first=first)

    return (
        f"{reply(lang, 'menu_intro_header', display=display)}\n"
        f"{name_line}"
        f"{hook}\n\n"
        f"{reply(lang, 'menu_intro_cta')}"
    )


async def ensure_restaurant_greeting_context(
    session_state: dict[str, Any],
    restaurant_id: str,
) -> None:
    """Load restaurant display name, cuisine, and timezone once per session."""
    if session_state.get("_greeting_ctx_loaded"):
        return
    from tools.booking_mechanisms import fetch_restaurant_info

    info = await fetch_restaurant_info(restaurant_id) or {}
    name = (info.get("display_name") or info.get("name") or "").strip()

    session_state["_restaurant_display_name"] = name or "our restaurant"
    session_state["_restaurant_timezone"] = (info.get("timezone") or "Asia/Kolkata").strip()
    session_state["_restaurant_cuisine"] = parse_cuisine_tags(info.get("cuisine_type"))

    # Only latch the "loaded" flag when we got a real name. On fetch failure,
    # leave it unset so the next message retries instead of permanently
    # caching the "our restaurant" fallback into this customer's session.
    if name:
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
        lang=session_lang(session_state),
    )
