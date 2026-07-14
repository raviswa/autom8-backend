"""Defer KDS dispatch until shortly before scheduled delivery/pickup time."""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
DEFAULT_KDS_LEAD_MINUTES = 150  # 2.5 h — within the 120–180 min kitchen prep window
MIN_KDS_LEAD_MINUTES = 120
MAX_KDS_LEAD_MINUTES = 180

ORDER_MODE_IMMEDIATE = "immediate"
ORDER_MODE_SCHEDULED = "scheduled"


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


def is_scheduled_order_mode(
    session_state: dict[str, Any] | None = None,
    *,
    order_mode: str | None = None,
    service_type: str | None = None,
) -> bool:
    """
    True for future-slot takeaway/delivery — never for dine-in or explicit immediate.

    Prefer an explicit order_mode when present. When mode is missing, treat any
    future kitchen_start_at / scheduled_at as scheduled so payment fulfill cannot
    fail-open into live KDS.
    """
    if (service_type or (session_state or {}).get("service_type")) == "dine_in":
        return False

    state = session_state or {}
    mode = (
        order_mode
        or state.get("order_mode")
        or ""
    ).strip().lower()

    if mode == ORDER_MODE_IMMEDIATE:
        return False
    if mode == ORDER_MODE_SCHEDULED:
        return True

    # Missing mode: infer from schedule timestamps (fail closed for future slots).
    for key in ("kitchen_start_at", "scheduled_at", "scheduled_slot_at"):
        dt = parse_scheduled_at(state.get(key))
        if dt is None:
            continue
        now = datetime.now(tz=dt.tzinfo or IST)
        if dt > now + timedelta(minutes=5):
            return True
    return False


def is_deferred_scheduled_order(
    scheduled_at_raw: Any,
    *,
    session_state: dict[str, Any] | None = None,
    restaurant_info: dict[str, Any] | None = None,
    service_type: str | None = None,
    now: datetime | None = None,
) -> tuple[bool, datetime | None, datetime | None]:
    """
    Returns (should_defer, scheduled_at, kds_release_at).

    Prefer cook-based kitchen_start_at when present (takeaway ≈ slot − cook − pack − buffer;
    delivery also subtracts transit). Fall back to fixed lead minutes only when
    kitchen_start_at is missing.
    """
    state = dict(session_state or {})
    if scheduled_at_raw is not None and not state.get("scheduled_at"):
        state["scheduled_at"] = scheduled_at_raw

    if not is_scheduled_order_mode(
        state,
        service_type=service_type,
    ):
        return False, None, None

    # Cook-based start is the source of truth when known.
    kitchen_start = parse_scheduled_at(state.get("kitchen_start_at"))
    scheduled_at = parse_scheduled_at(
        scheduled_at_raw if scheduled_at_raw is not None else state.get("scheduled_at")
    ) or parse_scheduled_at(state.get("scheduled_slot_at"))

    now = now or datetime.now(tz=IST)
    if now.tzinfo is None:
        now = now.replace(tzinfo=IST)

    if kitchen_start is not None:
        if kitchen_start > now.astimezone(kitchen_start.tzinfo):
            return True, scheduled_at or kitchen_start, kitchen_start
        return False, scheduled_at or kitchen_start, kitchen_start

    if scheduled_at is None:
        return False, None, None

    lead = resolve_kds_lead_minutes(
        session_state=state,
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


def is_booking_on_kds_future_tab(
    *,
    kitchen_start_at: Any = None,
    scheduled_slot_at: Any = None,
    booking_datetime: Any = None,
    kds_sent_at: Any = None,
    service_type: str | None = None,
    schedule_meta: Any = None,
    now: datetime | None = None,
) -> bool:
    """
  True when a paid booking legitimately has no live kds_items yet.

  Scheduled takeaway/delivery appear on the KDS *Future* tab until kitchen_start_at.
  The reconcile job must not treat these as missing tickets.
    """
    if kds_sent_at:
        return False

    st = (service_type or "").replace("-", "_").lower()
    if st not in ("takeaway", "delivery"):
        return False

    import json

    from tools.kitchen_scheduler import parse_slot_datetime

    now = now or datetime.now(IST)

    ks = parse_slot_datetime(kitchen_start_at)
    if ks and ks > now.astimezone(ks.tzinfo):
        return True

    meta: dict[str, Any] = {}
    if isinstance(schedule_meta, dict):
        meta = schedule_meta
    elif isinstance(schedule_meta, str) and schedule_meta.strip():
        try:
            meta = json.loads(schedule_meta)
        except Exception:
            meta = {}

    slot_raw = scheduled_slot_at or booking_datetime or meta.get("scheduled_at")
    slot = parse_slot_datetime(slot_raw)
    if slot and slot > now.astimezone(slot.tzinfo) + timedelta(hours=1):
        return True

    hints = {
        "order_mode": meta.get("order_mode") or ORDER_MODE_SCHEDULED,
        "scheduled_at": slot_raw,
        "kitchen_start_at": kitchen_start_at,
        "service_type": st,
    }
    defer, _, _ = is_deferred_scheduled_order(
        slot_raw,
        session_state=hints,
        service_type=st,
        now=now,
    )
    return defer
