"""
Global typed shortcuts — manual fallback when buttons or routing fail.

Tier A: global (any step)     HOM PAY CAT CRT STS REM
Tier B: service menu          DIN TAK DEL STK SDL RSV EXT
Tier C: cart / order          CFM ADD CLR SUM SKP
Tier D: yes / no / dietary    YES NO NEW VEG NVG ANY
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# ── Global shortcuts (handled in booking_agent before flow dispatch) ───────────
_GLOBAL_ACTIONS: frozenset[str] = frozenset({
    "HOM", "HOME", "MNU", "MENU", "MAINMENU",
    "PAY", "PAYMENT", "P",
    "CAT", "CATALOG",
    "CRT", "CART",
    "STS", "STATUS",
    "REM", "REMIND",
})

# ── Service menu → list row id (ask_service / awaiting_service_selection) ────
_SERVICE_SHORTCUTS: dict[str, str] = {
    "DIN": "dine_in",
    "TAK": "takeaway_now",
    "TKW": "takeaway_now",
    "DEL": "delivery_now",
    "STK": "takeaway_schedule",
    "SDL": "delivery_schedule",
    "RSV": "reserve_table",
    "EXT": "nothing",
    "OUT": "nothing",
}

_SERVICE_MENU_STEPS: frozenset[str] = frozenset({
    "ask_service",
    "awaiting_service_selection",
})

# ── Cart / confirm shortcuts → canonical button ids ───────────────────────────
_CART_SHORTCUTS: dict[str, str] = {
    "CFM": "CART:CONFIRM",
    "CONFIRM": "CART:CONFIRM",
    "ADD": "CART:ADD_MORE",
    "CLR": "CART:CLEAR",
    "CLEAR": "CART:CLEAR",
    "SUM": "CART:SHOW_SUMMARY",
    "SKP": "SKIP",
    "SKIP": "SKIP",
    "NVG": "NON_VEG",
    "ANY": "BOTH",
    "NEW": "NEW ORDER",
}

_CART_STEPS: frozenset[str] = frozenset({
    "awaiting_order",
    "awaiting_cart_action",
    "awaiting_category_selection",
    "awaiting_item_qty",
    "awaiting_quantity",
    "awaiting_numbered_order",
    "confirming_order",
    "awaiting_special_notes",
})

# Dine-in large-party context
_LARGE_PARTY_SHORTCUTS: dict[str, str] = {
    "RSV": "RESERVE",
    "PAX": "SMALLER",
}

_LARGE_PARTY_STEPS: frozenset[str] = frozenset({
    "awaiting_large_party_response",
    "awaiting_manager_approval",
})

SHORTCUT_FOOTER_GLOBAL = "Shortcuts: *PAY* · *CAT* · *CRT* · *HOM*"
SHORTCUT_FOOTER_SERVICE = (
    "Type: *DIN* · *TAK* · *DEL* · *STK* · *SDL* · *RSV* · *EXT* (or tap above)"
)
SHORTCUT_FOOTER_CART = "Shortcuts: *CFM* confirm · *ADD* more · *CLR* clear · *CAT* menu"


def _token(message: str) -> str:
    return (message or "").strip().upper()


def is_pay_keyword(message: str) -> bool:
    t = _token(message)
    return t in {"PAY", "PAYMENT", "P"} or (message or "").strip().lower() == "💳 resend link"


def is_reset_shortcut(message: str) -> bool:
    return _token(message) in {"HOM", "HOME", "MNU", "MENU", "MAINMENU", "MAIN MENU"}


def is_remind_shortcut(message: str) -> bool:
    return _token(message) in {"REM", "REMIND"}


def is_global_shortcut_action(token: str) -> bool:
    return token in _GLOBAL_ACTIONS


def is_service_menu_shortcut(message: str, booking_step: str) -> bool:
    return booking_step in _SERVICE_MENU_STEPS and _token(message) in _SERVICE_SHORTCUTS


def expand_shortcut_message(message: str, booking_step: str) -> str:
    """
    Rewrite a typed shortcut to the canonical id the flow handlers already understand.
    Returns the original message when no expansion applies.
    """
    raw = (message or "").strip()
    if not raw:
        return message

    tok = _token(raw)

    if booking_step in _SERVICE_MENU_STEPS and tok in _SERVICE_SHORTCUTS:
        expanded = _SERVICE_SHORTCUTS[tok]
        logger.info(f"[shortcut] {tok} → service row {expanded!r}")
        return expanded

    if booking_step in _LARGE_PARTY_STEPS and tok in _LARGE_PARTY_SHORTCUTS:
        expanded = _LARGE_PARTY_SHORTCUTS[tok]
        logger.info(f"[shortcut] {tok} → {expanded!r} (large party)")
        return expanded

    if booking_step in _CART_STEPS or tok in _CART_SHORTCUTS:
        if tok in _CART_SHORTCUTS:
            expanded = _CART_SHORTCUTS[tok]
            logger.info(f"[shortcut] {tok} → {expanded!r}")
            return expanded

    return message


async def handle_global_shortcut(
    token: str,
    *,
    restaurant_id: str,
    customer_phone: str,
    customer_name: str,
    session_state: dict[str, Any],
) -> dict[str, Any] | None:
    """Execute global shortcuts that need async side effects. None = not handled."""
    from agents.customer.booking_helpers import (
        send_catalog_with_fallback,
        touch_session_activity,
    )
    from tools.cart_tools import get_cart, cart_summary_text, send_cart_summary_buttons

    if token in {"HOM", "HOME", "MNU", "MENU", "MAINMENU"}:
        return None  # handled by is_reset_keyword after we add hom/mnu aliases

    if is_pay_keyword(token):
        return None  # handled by scheduled_payment.try_trigger_scheduled_payment_on_pay

    if token in {"REM", "REMIND"}:
        return None  # handled by existing REMIND block in booking_agent

    if token in {"CAT", "CATALOG"}:
        await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
        touch_session_activity(session_state)
        return {"status": session_state.get("booking_step", "awaiting_order")}

    if token in {"CRT", "CART"}:
        cart = get_cart(session_state)
        if not cart:
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            touch_session_activity(session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}
        summary = cart_summary_text(cart, session_state)
        await send_cart_summary_buttons(customer_phone, session_state)
        touch_session_activity(session_state)
        return {"status": "awaiting_cart_action"}

    if token in {"STS", "STATUS"}:
        from tools.whatsapp_tools import send_whatsapp_message

        lines: list[str] = ["📋 *Your session status*"]
        step = session_state.get("booking_step") or "—"
        lines.append(f"Step: _{step}_")
        token_num = session_state.get("display_token") or session_state.get("token_number")
        if token_num:
            lines.append(f"Token: *{token_num}*")
        svc = session_state.get("service_type") or session_state.get("last_service_type")
        if svc:
            lines.append(f"Service: {str(svc).replace('_', ' ')}")
        summary = session_state.get("order_confirmed_summary")
        if summary:
            lines.append(f"Order: _{summary}_")
        total = session_state.get("order_total")
        if total is not None:
            lines.append(f"Total: ₹{float(total):.0f}")
        sched = session_state.get("scheduled_at_label") or session_state.get("scheduled_at")
        if sched:
            lines.append(f"Scheduled: {sched}")
        if session_state.get("payment_link"):
            lines.append("Payment: link sent — reply *PAY* to resend")
        elif step in (
            "awaiting_prepay",
            "awaiting_scheduled_takeaway_payment",
            "awaiting_scheduled_delivery_payment",
        ):
            lines.append("Payment: pending — reply *PAY*")
        lines.append(f"\n{SHORTCUT_FOOTER_GLOBAL}")
        await send_whatsapp_message(customer_phone, "\n".join(lines), restaurant_id)
        touch_session_activity(session_state)
        return {"status": step}

    return None
