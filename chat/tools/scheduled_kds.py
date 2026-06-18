"""Defer KDS dispatch until shortly before scheduled delivery/pickup time."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
DEFAULT_KDS_LEAD_MINUTES = 150
MIN_KDS_LEAD_MINUTES = 30
MAX_KDS_LEAD_MINUTES = 480


def clamp_kds_lead_minutes(value: Any) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return DEFAULT_KDS_LEAD_MINUTES
    return max(MIN_KDS_LEAD_MINUTES, min(MAX_KDS_LEAD_MINUTES, n))


def resolve_kds_lead_minutes(
    *,
    session_state: dict[str, Any] | None = None,
    restaurant_info: dict[str, Any] | None = None,
) -> int:
    for src in (session_state or {}, restaurant_info or {}):
        if src.get("scheduled_kds_lead_minutes") is not None:
            return clamp_kds_lead_minutes(src["scheduled_kds_lead_minutes"])
    return DEFAULT_KDS_LEAD_MINUTES


def parse_scheduled_at(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=IST)
    return dt


def compute_kds_release_at(scheduled_at: datetime, lead_minutes: int) -> datetime:
    return scheduled_at - timedelta(minutes=lead_minutes)


def kds_should_dispatch_now(
    scheduled_at: datetime,
    lead_minutes: int,
    *,
    now: datetime | None = None,
) -> bool:
    now = now or datetime.now(tz=scheduled_at.tzinfo or IST)
    if now.tzinfo is None:
        now = now.replace(tzinfo=IST)
    return now >= compute_kds_release_at(scheduled_at, lead_minutes)


def is_deferred_scheduled_order(
    scheduled_at_raw: Any,
    *,
    session_state: dict[str, Any] | None = None,
    restaurant_info: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> tuple[bool, datetime | None, datetime | None]:
    """
    Returns (should_defer, scheduled_at, kds_release_at).
    Immediate dispatch when within the lead window or unparseable schedule.
    """
    scheduled_at = parse_scheduled_at(scheduled_at_raw)
    if scheduled_at is None:
        return False, None, None
    lead = resolve_kds_lead_minutes(
        session_state=session_state,
        restaurant_info=restaurant_info,
    )
    release_at = compute_kds_release_at(scheduled_at, lead)
    if kds_should_dispatch_now(scheduled_at, lead, now=now):
        return False, scheduled_at, release_at
    return True, scheduled_at, release_at


def format_kds_defer_customer_note(scheduled_at: datetime, release_at: datetime) -> str:
    sched_label = scheduled_at.astimezone(IST).strftime("%a %d %b, %I:%M %p")
    release_label = release_at.astimezone(IST).strftime("%I:%M %p")
    return (
        f"Your slot is *{sched_label}*.\n"
        f"The kitchen will start preparing around *{release_label}* "
        f"so your food is fresh for delivery."
    )
