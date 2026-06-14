"""
kitchen_hours.py
────────────────
Kitchen slot schedule — mirrors src/routes/catalog.js SLOTS / getCurrentSlotIST().
Used to gate takeaway & delivery before the customer invests in location sharing.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

_IST = ZoneInfo("Asia/Kolkata")

# Must stay in sync with catalog.js SLOTS
_SLOTS = [
    {"start_hour": 6,  "end_hour": 11, "db_value": "morning_tiffin", "label": "Morning Tiffin", "open_label": "6:00 AM"},
    {"start_hour": 11, "end_hour": 15, "db_value": "lunch",          "label": "Lunch",          "open_label": "11:00 AM"},
    {"start_hour": 15, "end_hour": 19, "db_value": "snacks",         "label": "Evening Snacks", "open_label": "3:00 PM"},
    {"start_hour": 19, "end_hour": 24, "db_value": "dinner",         "label": "Dinner",         "open_label": "7:00 PM"},
]

_ORDERING_SERVICES = frozenset({"takeaway", "delivery"})


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
    return get_current_slot() is not None


def next_open_label() -> str:
    """Human-readable next opening time (e.g. '6:00 AM')."""
    hour = _now_ist().hour
    for slot in _SLOTS:
        if hour < slot["start_hour"]:
            return slot["open_label"]
    return _SLOTS[0]["open_label"]


def ordering_blocked_for_service(service_type: str | None) -> bool:
    return service_type in _ORDERING_SERVICES and not is_kitchen_open()


def build_closed_notice(*, attempt: int = 1, service_type: str | None = None) -> str:
    """Customer-facing copy when takeaway/delivery menu is unavailable."""
    opens = next_open_label()

    if attempt <= 1:
        lead = (
            f"We're closed for ordering right now. "
            f"We open at *{opens}*."
        )
    elif attempt == 2:
        lead = (
            f"Still closed for now — we open at *{opens}*. "
            f"Sorry about the wait!"
        )
    else:
        lead = (
            f"We're still closed until *{opens}*. "
            f"If you need help urgently, ask a team member at the counter "
            f"or call the restaurant."
        )

    svc_hint = ""
    if service_type == "delivery":
        svc_hint = "\n\nDelivery will be available once the kitchen opens."
    elif service_type == "takeaway":
        svc_hint = "\n\nTakeaway ordering will be available once the kitchen opens."

    reminder = (
        "\n\nWant a reminder when we open? Just reply *REMIND* and we'll ping you."
        if attempt <= 2
        else ""
    )

    dine_in = (
        "\n\nDine-in check-in is still available if you're at the restaurant."
        if attempt <= 2
        else ""
    )

    return f"{lead}{svc_hint}{dine_in}{reminder}"


def build_menu_closed_message(service_type: str | None) -> str:
    """Fallback when catalog send fails because no items are available."""
    opens = next_open_label()
    if service_type == "takeaway":
        svc_line = "Takeaway ordering is paused — the kitchen is closed for this hour."
    elif service_type == "delivery":
        svc_line = "Delivery ordering is paused — the kitchen is closed for this hour."
    else:
        svc_line = "The kitchen menu is closed for this hour."

    return (
        f"{svc_line}\n"
        f"We open at *{opens}*.\n\n"
        f"Reply *REMIND* for a ping when we're back, or *Home* to see other options."
    )
