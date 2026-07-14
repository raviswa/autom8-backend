"""
Kitchen start time calculation for scheduled takeaway/delivery.

effective_cook_time(qty) = prep_time_fixed + CEIL(qty / batch_size) * time_per_batch
Order cook time = MAX per station (parallel), SUM within same station (sequential).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")

TAKEAWAY_ROUNDING_MINUTES = 30
DELIVERY_ROUNDING_MINUTES = 15

KITCHEN_STATIONS = frozenset({
    "tawa", "steamer", "kadai", "beverages", "assembly", "cold",
})

MENU_DEFAULTS: dict[str, Any] = {
    "prep_time_fixed": 5,
    "batch_size": 1,
    "time_per_batch": 10,
    "kitchen_station": "assembly",
    "packing_time": 1.0,
    "holds_well": False,
}


def _menu_line(item: dict[str, Any] | None) -> dict[str, Any]:
    src = item or {}
    station = str(src.get("kitchen_station") or MENU_DEFAULTS["kitchen_station"]).lower()
    if station not in KITCHEN_STATIONS:
        station = MENU_DEFAULTS["kitchen_station"]
    return {
        "prep_time_fixed": int(src.get("prep_time_fixed", MENU_DEFAULTS["prep_time_fixed"])),
        "batch_size": max(1, int(src.get("batch_size", MENU_DEFAULTS["batch_size"]))),
        "time_per_batch": max(1, int(src.get("time_per_batch", MENU_DEFAULTS["time_per_batch"]))),
        "kitchen_station": station,
        "packing_time": float(src.get("packing_time", MENU_DEFAULTS["packing_time"])),
        "holds_well": bool(src.get("holds_well", MENU_DEFAULTS["holds_well"])),
    }


def effective_cook_time(item: dict[str, Any], quantity: int) -> int:
    m = _menu_line(item)
    qty = max(1, int(quantity))
    batches = math.ceil(qty / m["batch_size"])
    return m["prep_time_fixed"] + batches * m["time_per_batch"]


def compute_order_timing(
    cart_lines: list[dict[str, Any]],
    menu_by_retailer_id: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """
    Returns total_cook_minutes, total_packing_minutes, all_hold_well, station_breakdown.
    cart_lines: [{retailer_id|id, qty}, ...]
    """
    station_times: dict[str, int] = {}
    packing_total = 0.0
    all_hold_well = True

    for line in cart_lines:
        rid = str(line.get("retailer_id") or line.get("id") or "").strip()
        if not rid or rid == "manual":
            title = (line.get("title") or line.get("name") or "").strip().lower()
            menu_item = next(
                (v for k, v in menu_by_retailer_id.items() if (v.get("name") or "").lower() == title),
                {},
            )
        else:
            menu_item = menu_by_retailer_id.get(rid) or {}

        m = _menu_line(menu_item)
        qty = max(1, int(line.get("qty") or line.get("quantity") or 1))
        if not m["holds_well"]:
            all_hold_well = False

        cook = effective_cook_time(m, qty)
        station = m["kitchen_station"]
        station_times[station] = station_times.get(station, 0) + cook
        packing_total += m["packing_time"] * qty

    total_cook = max(station_times.values()) if station_times else 0
    return {
        "total_cook_minutes": total_cook,
        "total_packing_minutes": round(packing_total, 2),
        "all_hold_well": all_hold_well,
        "station_breakdown": station_times,
    }


def round_down_to_boundary(dt: datetime, boundary_minutes: int) -> datetime:
    if boundary_minutes <= 1:
        return dt.replace(second=0, microsecond=0)
    dt = dt.astimezone(IST).replace(second=0, microsecond=0)
    rem = dt.minute % boundary_minutes
    if rem == 0:
        return dt
    return dt - timedelta(minutes=rem)


def round_to_nearest_boundary(dt: datetime, boundary_minutes: int) -> datetime:
    """Round IST wall-clock time to the nearest N-minute boundary."""
    if boundary_minutes <= 1:
        return dt.astimezone(IST).replace(second=0, microsecond=0)
    dt = dt.astimezone(IST).replace(second=0, microsecond=0)
    total_min = dt.hour * 60 + dt.minute
    rounded = int(round(total_min / boundary_minutes) * boundary_minutes)
    day_minutes = 24 * 60
    rounded %= day_minutes
    return dt.replace(hour=rounded // 60, minute=rounded % 60)


def parse_slot_datetime(value: Any) -> datetime | None:
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
    return dt.astimezone(IST)


def resolve_transit_minutes(
    service_type: str,
    *,
    explicit_minutes: int | None = None,
    distance_km: float | None = None,
    default_delivery: int = 30,
) -> int:
    """Delivery needs earlier kitchen start; takeaway has no transit leg."""
    st = (service_type or "").replace("-", "_").lower()
    if st != "delivery":
        return 0
    if explicit_minutes is not None:
        try:
            return max(0, int(explicit_minutes))
        except (TypeError, ValueError):
            pass
    if distance_km is not None:
        try:
            return max(10, min(45, int(float(distance_km) * 4)))
        except (TypeError, ValueError):
            pass
    return default_delivery


def compute_kitchen_start_at(
    slot_at: datetime,
    *,
    service_type: str,
    cart_lines: list[dict[str, Any]],
    menu_by_retailer_id: dict[str, dict[str, Any]],
    buffer_minutes: int = 15,
    rounding_minutes: int = TAKEAWAY_ROUNDING_MINUTES,
    delivery_rounding_minutes: int = DELIVERY_ROUNDING_MINUTES,
    transit_minutes: int = 0,
) -> dict[str, Any]:
    """
    Backward from customer slot → kitchen_start_at.

    Takeaway: (cook + packing + buffer), kitchen start rounded to nearest 30 min.
    Delivery: takeaway kitchen start minus transit, rounded to nearest 15 min.
    """
    timing = compute_order_timing(cart_lines, menu_by_retailer_id)
    cook = timing["total_cook_minutes"]
    st = (service_type or "").replace("-", "_").lower()
    packing = timing["total_packing_minutes"] if st in ("takeaway", "delivery") else 0.0

    slot = parse_slot_datetime(slot_at)
    if slot is None:
        raise ValueError("invalid slot_at")

    takeaway_lead = cook + float(packing) + int(buffer_minutes)
    raw_takeaway = slot - timedelta(minutes=takeaway_lead)
    takeaway_start = round_to_nearest_boundary(raw_takeaway, max(1, int(rounding_minutes)))

    if st == "delivery":
        transit = int(transit_minutes)
        raw_delivery = takeaway_start - timedelta(minutes=transit)
        kitchen_start = round_to_nearest_boundary(
            raw_delivery, max(1, int(delivery_rounding_minutes)),
        )
        rounding_used = delivery_rounding_minutes
    else:
        kitchen_start = takeaway_start
        rounding_used = rounding_minutes

    return {
        "kitchen_start_at": kitchen_start,
        "scheduled_slot_at": slot,
        "takeaway_kitchen_start_at": takeaway_start,
        "total_cook_minutes": cook,
        "total_packing_minutes": packing,
        "transit_minutes": transit_minutes if st == "delivery" else 0,
        "takeaway_lead_minutes": takeaway_lead,
        "buffer_minutes": buffer_minutes,
        "rounding_minutes": rounding_used,
        "all_hold_well": timing["all_hold_well"],
        "station_breakdown": timing["station_breakdown"],
    }


def cart_lines_from_snapshot(cart: dict[str, Any]) -> list[dict[str, Any]]:
    lines = []
    for item_id, line in (cart or {}).items():
        if not isinstance(line, dict):
            continue
        lines.append({
            "retailer_id": str(item_id),
            "id": str(item_id),
            "qty": int(line.get("qty") or 1),
            "title": line.get("title") or line.get("name"),
        })
    return lines


def format_ist_label(dt: datetime) -> str:
    dt = dt.astimezone(IST)
    h = dt.hour % 12 or 12
    ampm = "PM" if dt.hour >= 12 else "AM"
    return f"{dt.strftime('%d %b %Y')}, {h}:{dt.minute:02d} {ampm}"
