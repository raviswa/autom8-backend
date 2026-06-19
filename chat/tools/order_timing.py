"""
Order timing notes — owner ready ranges + manager busy-kitchen flag.
Delivery ETAs add Google Maps drive time (traffic-aware when available).
"""

from __future__ import annotations

import re


def _display_range(ready_range: str | None) -> str:
    """Normalize owner input like '20-30' or '20 - 30 mins' for display."""
    if not ready_range:
        return ""
    text = str(ready_range).strip()
    for suffix in ("mins", "min", "minutes", "minute"):
        if text.lower().endswith(suffix):
            text = text[: -len(suffix)].strip()
    return text


def _parse_range_bounds(ready_range: str | None) -> tuple[int, int] | None:
    """Parse '25-35' or '30' into (low, high) minute bounds."""
    display = _display_range(ready_range)
    if not display:
        return None
    compact = display.replace(" ", "")
    m = re.match(r"^(\d+)\s*-\s*(\d+)$", compact)
    if m:
        a, b = int(m.group(1)), int(m.group(2))
        return min(a, b), max(a, b)
    m = re.match(r"^(\d+)$", compact)
    if m:
        v = int(m.group(1))
        return v, v
    return None


def format_ready_time_note(
    service_type: str,
    *,
    ready_range: str | None = None,
    kitchen_busy: bool = False,
    travel_minutes: int | None = None,
    travel_traffic_aware: bool = False,
    distance_km: float | None = None,
    distance_method: str | None = None,
    is_scheduled: bool = False,
) -> str:
    """
    Build optional ETA paragraph for order confirmations.
    Returns empty string when no range is set and kitchen is not busy.
    """
    st = (service_type or "").replace("-", "_").lower()

    if is_scheduled and st == "delivery":
        return ""

    bounds = _parse_range_bounds(ready_range)
    if (
        st == "delivery"
        and bounds
        and travel_minutes
        and travel_minutes > 0
        and distance_method == "road"
    ):
        prep_lo, prep_hi = bounds
        total_lo = prep_lo + travel_minutes
        total_hi = prep_hi + travel_minutes + 5
        travel_desc = f"~{travel_minutes} min drive"
        if travel_traffic_aware:
            travel_desc += " with current traffic"
        dist_bit = f", {distance_km:g} km by road" if distance_km is not None else ""
        if kitchen_busy:
            return (
                f"⏱ Usually delivered in *{total_lo}–{total_hi} mins* "
                f"({travel_desc}{dist_bit} + kitchen time). "
                "Kitchen is busy — allow a little extra. We'll WhatsApp you when it's ready."
            )
        return (
            f"⏱ Usually delivered in *{total_lo}–{total_hi} mins* "
            f"({travel_desc}{dist_bit} + kitchen time). "
            "We'll WhatsApp you when it's ready."
        )

    display = _display_range(ready_range)
    if display:
        if kitchen_busy:
            return (
                f"⏱ Normally it takes {display} mins, but due to high volumes "
                "there could be some delay in preparing your food. "
                "We'll WhatsApp you when it's ready."
            )
        label = "delivered" if st == "delivery" else "ready"
        return (
            f"⏱ Usually {label} in {display} mins. "
            "We'll WhatsApp you when it's ready."
        )

    if kitchen_busy:
        return (
            "⏱ Kitchen is busy — please allow a little extra time preparing your order. "
            "We'll WhatsApp you when it's ready."
        )

    return ""


def ready_range_for_service(session_state: dict, service_type: str) -> str | None:
    st = (service_type or "").replace("-", "_").lower()
    if st == "delivery":
        return session_state.get("delivery_ready_range") or None
    return session_state.get("takeaway_ready_range") or None


def ready_time_note_from_session(session_state: dict, service_type: str) -> str:
    st = (service_type or "").replace("-", "_").lower()
    travel_minutes = None
    travel_traffic_aware = False
    if st == "delivery" and not session_state.get("scheduled_at"):
        raw_travel = session_state.get("delivery_travel_minutes")
        try:
            if raw_travel is not None:
                travel_minutes = int(raw_travel)
        except (TypeError, ValueError):
            travel_minutes = None
        travel_traffic_aware = bool(session_state.get("delivery_travel_traffic_aware"))

    distance_km = None
    try:
        if session_state.get("delivery_distance_km") is not None:
            distance_km = float(session_state["delivery_distance_km"])
    except (TypeError, ValueError):
        distance_km = None

    return format_ready_time_note(
        service_type,
        ready_range=ready_range_for_service(session_state, service_type),
        kitchen_busy=bool(session_state.get("kitchen_busy")),
        travel_minutes=travel_minutes,
        travel_traffic_aware=travel_traffic_aware,
        distance_km=distance_km,
        distance_method=session_state.get("delivery_distance_method"),
        is_scheduled=bool(session_state.get("scheduled_at")),
    )
