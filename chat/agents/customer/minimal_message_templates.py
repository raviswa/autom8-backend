"""Generic warm-tone WhatsApp copy for minimal-message LOBs (psl, food_products, retail)."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from locales.customer import reply, session_lang

_LOB_META: dict[str, dict[str, str]] = {
    "psl": {
        "icon": "🍕",
        "hook_key": "lob_psl_hook",
        "header_key": "lob_cta_header_order",
        "button_key": "lob_cta_button_order",
    },
    "food_products": {
        "icon": "🧁",
        "hook_key": "lob_food_products_hook",
        "header_key": "lob_cta_header_order",
        "button_key": "lob_cta_button_order",
    },
    "retail": {
        "icon": "🛍️",
        "hook_key": "lob_retail_hook",
        "header_key": "lob_cta_header_shop",
        "button_key": "lob_cta_button_shop",
    },
}


def get_time_period(timezone: str, lang: str | None = None) -> tuple[str, str]:
    """Returns (localized period_name, emoji) based on tenant local time."""
    try:
        tz = ZoneInfo(timezone or "Asia/Kolkata")
    except Exception:
        tz = ZoneInfo("Asia/Kolkata")
    hour = datetime.now(tz).hour
    if 5 <= hour < 12:
        key, emoji = "period_morning", "🌅"
    elif 12 <= hour < 17:
        key, emoji = "period_afternoon", "☀️"
    elif 17 <= hour < 21:
        key, emoji = "period_evening", "🌆"
    else:
        key, emoji = "period_night", "🌙"
    period = reply(lang, key)
    if (lang or "en") == "en":
        # Match historic English capitalization in "Good Morning"
        period = {"period_morning": "morning", "period_afternoon": "afternoon",
                  "period_evening": "evening", "period_night": "night"}[key]
    return period, emoji


def lob_hook(lob_type: str, lang: str | None = None) -> dict[str, str]:
    meta = _LOB_META.get(lob_type, _LOB_META["retail"])
    return {
        "icon": meta["icon"],
        "hook": reply(lang, meta["hook_key"]),
        "cta_header": reply(lang, meta["header_key"]),
        "cta_button": reply(lang, meta["button_key"]),
    }


def build_welcome_message(
    *,
    lob_type: str,
    store_name: str,
    customer_name: str | None,
    is_returning: bool,
    can_repeat: bool,
    timezone: str = "Asia/Kolkata",
    lang: str | None = None,
) -> tuple[str, str, str]:
    """
    Returns (body_text, cta_header, cta_button) for the webcart link message.
    Single outbound message — no follow-up bubbles.
    """
    meta = lob_hook(lob_type, lang)
    period, _ = get_time_period(timezone, lang)
    display = (store_name or "our store").strip()
    period_display = period.capitalize() if (lang or "en") == "en" else period

    first = ""
    if customer_name:
        first = customer_name.strip().split()[0]

    if first:
        greet = reply(
            lang, "greet_good_period_named", period=period_display, first=first,
        )
    else:
        greet = reply(lang, "greet_good_period", period=period_display)

    if is_returning and first:
        welcome_line = reply(
            lang, "welcome_returning_named", first=first, display=display, icon=meta["icon"],
        )
    elif first:
        welcome_line = reply(
            lang, "welcome_named", first=first, display=display, icon=meta["icon"],
        )
    else:
        welcome_line = reply(lang, "welcome_anon", display=display, icon=meta["icon"])

    lines = [
        greet,
        welcome_line,
        f"{meta['hook']}",
        "",
        reply(lang, "welcome_browse_cta"),
    ]
    if can_repeat:
        lines.append("")
        lines.append(reply(lang, "welcome_repeat_hint"))

    return "\n".join(lines), meta["cta_header"], meta["cta_button"]


def build_repeat_unavailable_message(store_name: str, lang: str | None = None) -> str:
    display = (store_name or "our store").strip()
    return reply(lang, "repeat_unavailable", display=display)


def build_repeat_confirm_body(
    *,
    order_ref: str,
    token_label: str,
    total: float,
    preview_lines: list[str],
    gateway_label: str,
    lang: str | None = None,
) -> str:
    order_preview = "\n".join(preview_lines)
    return reply(
        lang,
        "repeat_confirm",
        order_ref=order_ref,
        token_label=token_label,
        total=total,
        order_preview=order_preview,
        gateway_label=gateway_label,
    ).strip()


def build_short_redirect_message(can_repeat: bool, lang: str | None = None) -> str:
    if can_repeat:
        return reply(lang, "short_redirect_repeat")
    return reply(lang, "short_redirect")


def lang_from_session(session_state: dict[str, Any] | None) -> str:
    return session_lang(session_state)
