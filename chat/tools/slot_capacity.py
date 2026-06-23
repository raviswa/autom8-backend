"""30-minute slot capacity for scheduled takeaway/delivery."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from tools.delivery_slots import (
    IST,
    SLOT_GRANULARITY_MINUTES,
    earliest_valid_slot,
    validate_scheduled_delivery_slot,
    round_up_to_slot,
    next_available_slot,
    _format_slot_label,
)
from tools.db_tools import count_orders_for_slot

IST_ZONE = ZoneInfo("Asia/Kolkata")


def slot_bucket_start(dt: datetime) -> datetime:
    """Align to 30-minute slot boundary (floor)."""
    dt = dt.astimezone(IST_ZONE).replace(second=0, microsecond=0)
    rem = dt.minute % SLOT_GRANULARITY_MINUTES
    if rem:
        dt -= timedelta(minutes=rem)
    return dt


async def slot_occupancy(
    restaurant_id: str,
    slot_at: datetime,
) -> dict[str, Any]:
    bucket = slot_bucket_start(slot_at)
    count = await count_orders_for_slot(restaurant_id, bucket)
    return {"slot_at": bucket, "count": count}


async def validate_scheduled_slot_with_capacity(
    restaurant_id: str,
    requested: datetime,
    max_orders: int,
    *,
    now: datetime | None = None,
) -> tuple[bool, str, str | None]:
    """
    Returns (valid, reason_code, suggestion_label).
    reason_code: past | buffer | window | too_far | full | ok
    """
    valid, reason, suggestion = validate_scheduled_delivery_slot(requested, now=now)
    if not valid:
        return False, reason, suggestion

    occ = await slot_occupancy(restaurant_id, requested)
    if occ["count"] >= max_orders:
        nxt = await find_next_available_slot(restaurant_id, requested, max_orders, now=now)
        label = _format_slot_label(nxt) if nxt else None
        return False, "full", label

    return True, "ok", None


async def find_next_available_slot(
    restaurant_id: str,
    after: datetime,
    max_orders: int,
    *,
    now: datetime | None = None,
    max_scan_hours: int = 48,
) -> datetime | None:
    now = now or datetime.now(tz=IST_ZONE)
    cursor = round_up_to_slot(after + timedelta(minutes=SLOT_GRANULARITY_MINUTES))
    end = cursor + timedelta(hours=max_scan_hours)
    while cursor < end:
        valid, reason, _ = validate_scheduled_delivery_slot(cursor, now=now)
        if valid:
            occ = await slot_occupancy(restaurant_id, cursor)
            if occ["count"] < max_orders:
                return cursor
        cursor += timedelta(minutes=SLOT_GRANULARITY_MINUTES)
    return None


def format_slot_full_message(slot_label: str, next_label: str | None) -> str:
    if next_label:
        return (
            f"Sorry, the *{slot_label}* slot is full.\n\n"
            f"The next available slot is *{next_label}* — shall I book that instead?"
        )
    return (
        f"Sorry, the *{slot_label}* slot is full.\n\n"
        "Please pick another time on the calendar."
    )
