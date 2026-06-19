"""
kitchen_hours.py
────────────────
Kitchen slot schedule — mirrors src/routes/catalog.js SLOTS / getCurrentSlotIST().
Used to gate takeaway & delivery before the customer invests in location sharing.

Manager override: when the portal toggles Kitchen Open outside service slots,
menu_items.is_available is set true. We detect that via live menu fetch count.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

_IST = ZoneInfo("Asia/Kolkata")

# Must stay in sync with catalog.js SLOTS
_SLOTS = [
    {"start_hour": 6,  "end_hour": 11, "db_value": "morning_tiffin", "label": "Morning Tiffin", "open_label": "6:00 AM"},
    {"start_hour": 11, "end_hour": 15, "db_value": "lunch",          "label": "Lunch",          "open_label": "11:00 AM"},
    {"start_hour": 15, "end_hour": 19, "db_value": "snacks",         "label": "Evening Snacks", "open_label": "3:00 PM"},
    {"start_hour": 19, "end_hour": 24, "db_value": "dinner",         "label": "Dinner",         "open_label": "7:00 PM"},
]

_ORDERING_SERVICES = frozenset({"takeaway", "delivery"})

# Short TTL cache — manager toggle should propagate within a minute
_OVERRIDE_CACHE: dict[str, tuple[bool, float]] = {}
_OVERRIDE_CACHE_TTL = 45


def _now_ist() -> datetime:
    return datetime.now(_IST)


def get_current_slot() -> str | None:
    """Active menu slot db_value, or None when kitchen is between service windows."""
    hour = _now_ist().hour
    for slot in _SLOTS:
        if slot["start_hour"] <= hour < slot["end_hour"]:
            return slot["db_value"]
    return None


def is_kitchen_open() -> bool:
    """True when current IST hour falls inside a configured service slot."""
    return get_current_slot() is not None


def is_slot_open() -> bool:
    """Alias — slot schedule only (ignores manager override)."""
    return is_kitchen_open()


async def _count_available_menu_items(restaurant_id: str) -> int:
    """Live stocked + available items — mirrors Node kitchen-status is_open."""
    try:
        from tools.catalog_tools import invalidate_menu_cache, fetch_menu_items
        invalidate_menu_cache(restaurant_id)
        items = await fetch_menu_items(restaurant_id)
        return len([i for i in items if i.get("is_available", True)])
    except Exception as exc:
        logger.warning(f"[kitchen-hours] menu count failed for {restaurant_id}: {exc}")
        return 0


async def has_manager_kitchen_override(restaurant_id: str | None) -> bool:
    """Manager opened kitchen outside service slots (menu items marked available)."""
    if not restaurant_id or is_kitchen_open():
        return False

    now = time.monotonic()
    cached = _OVERRIDE_CACHE.get(restaurant_id)
    if cached and (now - cached[1]) < _OVERRIDE_CACHE_TTL:
        return cached[0]

    count = await _count_available_menu_items(restaurant_id)
    active = count > 0
    _OVERRIDE_CACHE[restaurant_id] = (active, now)
    if active:
        logger.info(
            f"[kitchen-hours] Manager override active for {restaurant_id} "
            f"({count} available items outside service slot)"
        )
    return active


def invalidate_kitchen_override_cache(restaurant_id: str | None = None) -> None:
    if restaurant_id:
        _OVERRIDE_CACHE.pop(restaurant_id, None)
    else:
        _OVERRIDE_CACHE.clear()


async def refresh_kitchen_acceptance(
    session_state: dict[str, Any] | None,
    restaurant_id: str | None,
) -> bool:
    """
    Cache whether WhatsApp ordering is allowed (slot open OR manager override).
    Sets session_state keys when session_state is provided.
    """
    slot_open = is_kitchen_open()
    override = False
    if not slot_open and restaurant_id:
        override = await has_manager_kitchen_override(restaurant_id)

    accepting = slot_open or override
    if session_state is not None:
        session_state["kitchen_slot_open"] = slot_open
        session_state["kitchen_manual_override"] = override
        session_state["kitchen_accepting_orders"] = accepting
    return accepting


def kitchen_accepting_orders(session_state: dict[str, Any] | None) -> bool:
    """Use cached acceptance flag; falls back to slot schedule only."""
    if session_state is None:
        return is_kitchen_open()
    if "kitchen_accepting_orders" in session_state:
        return bool(session_state["kitchen_accepting_orders"])
    return is_kitchen_open()


def next_open_label() -> str:
    """Human-readable next opening time (e.g. '6:00 AM')."""
    hour = _now_ist().hour
    for slot in _SLOTS:
        if hour < slot["start_hour"]:
            return slot["open_label"]
    return _SLOTS[0]["open_label"]


def next_open_slot_description() -> str:
    """Slot label + time, e.g. 'Morning Tiffin at 6:00 AM'."""
    hour = _now_ist().hour
    for slot in _SLOTS:
        if hour < slot["start_hour"]:
            return f"{slot['label']} at {slot['open_label']}"
    first = _SLOTS[0]
    return f"{first['label']} at {first['open_label']}"


def current_slot_label() -> str | None:
    """Human label for the active slot, or None when closed."""
    hour = _now_ist().hour
    for slot in _SLOTS:
        if slot["start_hour"] <= hour < slot["end_hour"]:
            return slot["label"]
    return None


def ordering_blocked_for_service(
    service_type: str | None,
    session_state: dict[str, Any] | None = None,
) -> bool:
    if kitchen_accepting_orders(session_state):
        return False
    return service_type in _ORDERING_SERVICES


def build_blanket_closed_message() -> str:
    """Single customer message when kitchen is closed (no service menu)."""
    opens = next_open_label()
    return (
        "🌙 *We're closed for ordering right now.*\n\n"
        f"Kitchen service resumes at *{opens}*.\n\n"
        "Reply *REMIND* and we'll message you when we're back.\n"
        "Reply *Home* anytime after we open to start a fresh order."
    )


def build_closed_notice(*, attempt: int = 1, service_type: str | None = None) -> str:
    """Legacy — prefer build_blanket_closed_message for new closed-hours UX."""
    return build_blanket_closed_message()


def build_menu_closed_message(service_type: str | None) -> str:
    """Fallback when catalog send fails because no items are available."""
    return build_blanket_closed_message()
