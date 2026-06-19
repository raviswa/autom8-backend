"""
Scheduled door delivery — slot rules (IST).

earliest_slot = round_up_to_next_hour(now + MIN_BUFFER_HOURS)

Today: only slots >= earliest_slot within the delivery window.
Future dates: all hourly slots in the window (no buffer).
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from tools.kitchen_hours import _SLOTS

IST = ZoneInfo("Asia/Kolkata")

MIN_BUFFER_HOURS = max(1, int(os.getenv("SCHEDULED_DELIVERY_MIN_BUFFER_HOURS", "3")))
SLOT_GRANULARITY_MINUTES = max(15, int(os.getenv("SCHEDULED_DELIVERY_SLOT_MINUTES", "60")))
MAX_DAYS_AHEAD = max(1, int(os.getenv("SCHEDULED_DELIVERY_MAX_DAYS", "7")))


def delivery_window_hours() -> tuple[int, int]:
    """Union of kitchen service windows — earliest open to latest close."""
    return min(s["start_hour"] for s in _SLOTS), max(s["end_hour"] for s in _SLOTS)


def _ensure_ist(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=IST)
    return dt.astimezone(IST)


def round_up_to_slot(dt: datetime, granularity_minutes: int = SLOT_GRANULARITY_MINUTES) -> datetime:
    """Round datetime UP to the next slot boundary."""
    dt = _ensure_ist(dt).replace(second=0, microsecond=0)
    if granularity_minutes == 60:
        if dt.minute == 0:
            return dt
        return dt.replace(minute=0) + timedelta(hours=1)
    remainder = dt.minute % granularity_minutes
    if remainder == 0:
        return dt
    return dt + timedelta(minutes=granularity_minutes - remainder)


def day_opening(day: date) -> datetime:
    start_hour, _ = delivery_window_hours()
    return datetime.combine(day, datetime.min.time(), tzinfo=IST).replace(hour=start_hour)


def day_closing(day: date) -> datetime:
    _, end_hour = delivery_window_hours()
    if end_hour >= 24:
        return datetime.combine(day + timedelta(days=1), datetime.min.time(), tzinfo=IST)
    return datetime.combine(day, datetime.min.time(), tzinfo=IST).replace(hour=end_hour)


def earliest_valid_slot(now: datetime | None = None) -> datetime:
    now = _ensure_ist(now or datetime.now(IST))
    raw_minimum = now + timedelta(hours=MIN_BUFFER_HOURS)
    return round_up_to_slot(raw_minimum)


def _within_operating_window(slot: datetime) -> bool:
    start_hour, end_hour = delivery_window_hours()
    h = slot.hour
    if h < start_hour:
        return False
    if end_hour >= 24:
        return True
    return h < end_hour


def generate_today_slots(now: datetime | None = None) -> list[datetime]:
    now = _ensure_ist(now or datetime.now(IST))
    earliest = earliest_valid_slot(now)
    closing = day_closing(now.date())
    if earliest >= closing:
        return []
    slots: list[datetime] = []
    cursor = earliest
    while cursor < closing:
        slots.append(cursor)
        cursor += timedelta(minutes=SLOT_GRANULARITY_MINUTES)
    return slots


def generate_future_day_slots(day: date) -> list[datetime]:
    """For any date strictly after today — no buffer."""
    start = day_opening(day)
    end = day_closing(day)
    slots: list[datetime] = []
    cursor = start
    while cursor < end:
        slots.append(cursor)
        cursor += timedelta(minutes=SLOT_GRANULARITY_MINUTES)
    return slots


def next_available_slot(now: datetime | None = None) -> datetime:
    """Earliest bookable slot (today or tomorrow if today is exhausted)."""
    now = _ensure_ist(now or datetime.now(IST))
    today_slots = generate_today_slots(now)
    if today_slots:
        return today_slots[0]
    tomorrow = now.date() + timedelta(days=1)
    future = generate_future_day_slots(tomorrow)
    return future[0] if future else earliest_valid_slot(now)


def latest_bookable_date(now: datetime | None = None) -> date:
    """Last calendar day a slot may be booked (inclusive)."""
    now = _ensure_ist(now or datetime.now(IST))
    return now.date() + timedelta(days=MAX_DAYS_AHEAD)


def calendar_min_date(now: datetime | None = None) -> str:
    """ISO date (YYYY-MM-DD) for WhatsApp Flow DatePicker min-date."""
    now = _ensure_ist(now or datetime.now(IST))
    return earliest_valid_slot(now).date().isoformat()


def calendar_max_date(now: datetime | None = None) -> str:
    """ISO date (YYYY-MM-DD) for WhatsApp Flow DatePicker max-date."""
    return latest_bookable_date(now).isoformat()


def build_flow_calendar_data(now: datetime | None = None) -> dict[str, str]:
    """Initial payload for Meta Flow navigate — binds min/max on DatePicker."""
    return {
        "min_date": calendar_min_date(now),
        "max_date": calendar_max_date(now),
    }


def format_schedule_window_hint(now: datetime | None = None) -> str:
    """User-facing earliest/latest lines for calendar invite messages."""
    now = _ensure_ist(now or datetime.now(IST))
    earliest = next_available_slot(now)
    latest = latest_bookable_date(now)
    return (
        f"\n\n_Earliest: {_format_slot_label(earliest)}_\n"
        f"_Latest: within {MAX_DAYS_AHEAD} days (by {latest.strftime('%d %b %Y')})_"
    )


def _format_slot_label(dt: datetime) -> str:
    dt = _ensure_ist(dt)
    h = dt.hour % 12 or 12
    ampm = "PM" if dt.hour >= 12 else "AM"
    if dt.date() == datetime.now(IST).date():
        return f"today at {h}:{dt.minute:02d} {ampm}"
    return f"{dt.strftime('%d %b %Y')}, {h}:{dt.minute:02d} {ampm}"


def validate_scheduled_delivery_slot(
    requested: datetime,
    now: datetime | None = None,
) -> tuple[bool, str, str | None]:
    """
    Returns (valid, reason_code, suggestion_label).
    reason_code: past | buffer | window | too_far | ok
    """
    now = _ensure_ist(now or datetime.now(IST))
    requested = _ensure_ist(requested)

    if requested.date() < now.date():
        return False, "past", _format_slot_label(next_available_slot(now))

    if requested <= now:
        return False, "past", _format_slot_label(next_available_slot(now))

    max_date = now.date() + timedelta(days=MAX_DAYS_AHEAD)
    if requested.date() > max_date:
        return False, "too_far", _format_slot_label(next_available_slot(now))

    if not _within_operating_window(requested):
        return False, "window", _format_slot_label(next_available_slot(now))

    if requested.date() == now.date():
        earliest = earliest_valid_slot(now)
        if requested < earliest:
            return False, "buffer", _format_slot_label(earliest)

    return True, "ok", None


def format_slot_rejection_message(reason: str, suggestion: str | None) -> str:
    if reason == "buffer":
        base = (
            f"Scheduled deliveries need at least *{MIN_BUFFER_HOURS} hours* notice "
            f"(rounded up to the next hour)."
        )
    elif reason == "window":
        start_hour, end_hour = delivery_window_hours()
        end_label = "midnight" if end_hour >= 24 else f"{end_hour % 12 or 12}:00 {'PM' if end_hour >= 12 else 'AM'}"
        start_label = f"{start_hour % 12 or 12}:00 {'AM' if start_hour < 12 else 'PM'}"
        base = f"Delivery slots are available between *{start_label}* and *{end_label}*."
    elif reason == "too_far":
        base = f"We can only schedule up to *{MAX_DAYS_AHEAD} days* ahead."
    else:
        base = "That time has already passed."

    if suggestion:
        return f"{base}\n\nPlease pick *{suggestion}* or later on the calendar."
    return f"{base}\n\nPlease tap *Select Date & Time* to pick a future slot."
