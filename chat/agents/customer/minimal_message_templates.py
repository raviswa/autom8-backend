"""Generic warm-tone WhatsApp copy for minimal-message LOBs (psl, food_products, retail)."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

_LOB_HOOKS: dict[str, dict[str, str]] = {
    "psl": {
        "icon": "🍕",
        "hook": "Pizza, ice cream & more — browse and order online.",
        "cta_header": "Start Your Order",
        "cta_button": "Browse & Order",
    },
    "food_products": {
        "icon": "🧁",
        "hook": "Fresh bakes & treats — browse and order online.",
        "cta_header": "Start Your Order",
        "cta_button": "Browse & Order",
    },
    "retail": {
        "icon": "🛍️",
        "hook": "Shop our catalog — browse and order online.",
        "cta_header": "Start Shopping",
        "cta_button": "Browse Catalog",
    },
}


def get_time_period(timezone: str) -> tuple[str, str]:
    """Returns (period_name, emoji) based on tenant local time."""
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


def lob_hook(lob_type: str) -> dict[str, str]:
    return _LOB_HOOKS.get(lob_type, _LOB_HOOKS["retail"])


def build_welcome_message(
    *,
    lob_type: str,
    store_name: str,
    customer_name: str | None,
    is_returning: bool,
    can_repeat: bool,
    timezone: str = "Asia/Kolkata",
) -> tuple[str, str, str]:
    """
    Returns (body_text, cta_header, cta_button) for the webcart link message.
    Single outbound message — no follow-up bubbles.
    """
    meta = lob_hook(lob_type)
    period, _ = get_time_period(timezone)
    display = (store_name or "our store").strip()
    greet = f"Good {period.capitalize()} 👋"

    first = ""
    if customer_name:
        first = customer_name.strip().split()[0]

    if is_returning and first:
        welcome_line = f"Welcome back, {first}! *{display}* {meta['icon']}"
    elif first:
        welcome_line = f"Welcome, {first}! *{display}* {meta['icon']}"
    else:
        welcome_line = f"Welcome to *{display}* {meta['icon']}"

    lines = [
        greet,
        welcome_line,
        f"{meta['hook']}",
    ]

    lines.append("")
    lines.append(
        "Tap below to browse, pick items, and pay securely — all on our online menu."
    )
    if can_repeat:
        lines.append("")
        lines.append(
            "Ordered before? Reply *REPEAT* anytime to reorder your last purchase."
        )

    return "\n".join(lines), meta["cta_header"], meta["cta_button"]


def build_repeat_unavailable_message(store_name: str) -> str:
    display = (store_name or "our store").strip()
    return (
        f"We couldn't find a previous order for you at *{display}*. 🙏\n\n"
        "Tap the menu link when we send it, or reply *Hi* to get started."
    )


def build_repeat_confirm_body(
    *,
    order_ref: str,
    token_label: str,
    total: float,
    preview_lines: list[str],
    gateway_label: str,
) -> str:
    order_preview = "\n".join(preview_lines)
    return (
        "Your repeat order is almost ready.\n\n"
        f"Order ref: {order_ref}\n"
        f"Token: {token_label}\n"
        f"Total: INR {total:.0f}\n\n"
        f"{order_preview}\n\n"
        f"Tap Confirm & Pay to complete payment securely via {gateway_label}."
    ).strip()


def build_short_redirect_message(can_repeat: bool) -> str:
    hint = "Reply *REPEAT* to reorder your last purchase." if can_repeat else ""
    base = "Browse and checkout on the menu link we sent. Need a fresh link? Reply *Hi*."
    return f"{base}\n{hint}".strip() if hint else base
