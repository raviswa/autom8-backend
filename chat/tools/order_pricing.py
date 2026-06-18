"""
Order pricing — parcel charges, delivery fee, GST (takeaway / delivery).
Parcel is per cart line quantity (qty × rate per item), added before GST.
Delivery charge supports distance tiers configured by the owner.
"""

from __future__ import annotations

import math
import re
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from tools.cart_tools import cart_total

DEFAULT_GST_RATE = 5.0
DEFAULT_DELIVERY_CHARGE = 40.0

_IST = ZoneInfo("Asia/Kolkata")

DEFAULT_DELIVERY_TIERS = [
    {"max_km": 3, "charge": 20},
    {"max_km": 6, "charge": 30},
    {"max_km": None, "charge": 40},
]


def parcel_charge_total(cart: dict[str, Any], rate_per_item: float) -> float:
    """Sum of qty × parcel rate for each cart line."""
    if not cart or not rate_per_item or rate_per_item <= 0:
        return 0.0
    return round(sum(line["qty"] * rate_per_item for line in cart.values()), 2)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometres."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a)), 2)


def delivery_charge_from_tiers(
    distance_km: float | None,
    tiers: list[dict[str, Any]] | None,
    *,
    default_charge: float = DEFAULT_DELIVERY_CHARGE,
) -> float:
    """
    Pick charge from owner-configured distance tiers.
    If distance is unknown, use the default flat charge.
    """
    if not tiers:
        return round(default_charge, 2)

    if distance_km is None:
        return round(default_charge, 2)

    finite = sorted(
        [t for t in tiers if t.get("max_km") is not None],
        key=lambda t: float(t["max_km"]),
    )
    for tier in finite:
        if distance_km <= float(tier["max_km"]):
            return round(float(tier.get("charge", default_charge)), 2)

    for tier in tiers:
        if tier.get("max_km") is None:
            return round(float(tier.get("charge", default_charge)), 2)

    if finite:
        return round(float(finite[-1].get("charge", default_charge)), 2)
    return round(default_charge, 2)


def resolve_delivery_charge(
    session_state: dict[str, Any] | None,
) -> float:
    """Compute delivery fee from session (uses pre-computed distance when set)."""
    state = session_state or {}
    default = float(state.get("delivery_charge_default") or DEFAULT_DELIVERY_CHARGE)
    tiers = state.get("delivery_charge_tiers") or DEFAULT_DELIVERY_TIERS

    distance = state.get("delivery_distance_km")
    if distance is None:
        d_lat = state.get("delivery_lat")
        d_lng = state.get("delivery_lng")
        r_lat = state.get("pickup_latitude")
        r_lng = state.get("pickup_longitude")
        try:
            if all(v is not None for v in (d_lat, d_lng, r_lat, r_lng)):
                distance = haversine_km(float(r_lat), float(r_lng), float(d_lat), float(d_lng))
                state["delivery_distance_km"] = distance
                state.setdefault("delivery_distance_method", "straight")
        except (TypeError, ValueError):
            distance = None

    return delivery_charge_from_tiers(distance, tiers, default_charge=default)


def min_order_amount(service_type: str, session_state: dict[str, Any] | None) -> float:
    state = session_state or {}
    st = (service_type or "").replace("-", "_").lower()
    if st == "delivery":
        return float(state.get("min_delivery_order_amount") or 0)
    if st == "takeaway":
        return float(state.get("min_takeaway_order_amount") or 0)
    return 0.0


def check_min_order(
    cart: dict[str, Any],
    service_type: str,
    session_state: dict[str, Any] | None,
) -> tuple[bool, float, float]:
    """Returns (ok, items_subtotal, minimum_required)."""
    subtotal = round(cart_total(cart) if cart else 0.0, 2)
    minimum = min_order_amount(service_type, session_state)
    if minimum <= 0:
        return True, subtotal, 0.0
    return subtotal >= minimum, subtotal, minimum


_MAPS_URL_RE = re.compile(r"google\.com/maps|maps\.app\.goo\.gl|goo\.gl/maps", re.I)


def _is_maps_url(text: str) -> bool:
    return bool(text and _MAPS_URL_RE.search(text))


def _short_maps_link(lat: float, lng: float) -> str:
    return f"https://maps.google.com/?q={lat},{lng}"


def format_pickup_location_block(session_state: dict[str, Any] | None) -> str:
    """Pickup maps link for cloud kitchen takeaway confirmations."""
    state = session_state or {}
    if (state.get("restaurant_type") or "").lower() != "cloud_kitchen":
        return ""

    addr = (state.get("pickup_address") or "").strip()
    lat = state.get("pickup_latitude")
    lng = state.get("pickup_longitude")

    try:
        if lat is not None and lng is not None:
            return f"📍 Pickup: {_short_maps_link(float(lat), float(lng))}"
    except (TypeError, ValueError):
        pass

    if addr and not _is_maps_url(addr):
        return f"📍 Pickup: {addr}"

    return ""


def parse_scheduled_delivery_time(text: str, *, now: datetime | None = None) -> datetime | None:
    """
    Parse simple customer time strings: 1pm, 1:00 PM, 1.00PM, 13:00, 1:30 pm.
    Returns datetime today; if time already passed, uses tomorrow.
    None means deliver now (NOW / ASAP).
    """
    raw = (text or "").strip()
    if not raw:
        return None
    if raw.lower() in ("now", "asap", "immediate", "immediately"):
        return None

    normalized = re.sub(
        r"(\d{1,2})\.(\d{2})\s*(am|pm)?",
        lambda m: f"{int(m.group(1))}:{m.group(2)}"
        + (f" {m.group(3).upper()}" if m.group(3) else ""),
        raw,
        flags=re.IGNORECASE,
    )
    raw = normalized.strip().lower()
    raw = re.sub(r"(\d)(am|pm)\b", r"\1 \2", raw)
    raw = re.sub(r"(\d)\.(\d)(?!\d)", r"\1:\2", raw)
    compact = re.sub(r"\s+", "", raw)
    hour: int | None = None
    minute = 0

    m = re.match(r"^(\d{1,2}):(\d{1,2})(am|pm)?$", compact)
    if m:
        hour = int(m.group(1))
        minute = int(m.group(2))
        meridiem = m.group(3)
    else:
        m = re.match(r"^(\d{1,2})(?::(\d{2}))?(am|pm)$", compact)
        if m:
            hour = int(m.group(1))
            minute = int(m.group(2) or 0)
            meridiem = m.group(3)
        else:
            m = re.match(r"^(\d{1,2}):(\d{2})$", compact)
            if m:
                hour = int(m.group(1))
                minute = int(m.group(2))
                meridiem = None
            else:
                return None

    if hour is None:
        return None

    if meridiem == "pm" and hour < 12:
        hour += 12
    elif meridiem == "am" and hour == 12:
        hour = 0

    base = now or datetime.now(_IST)
    if base.tzinfo is None:
        base = base.replace(tzinfo=_IST)
    candidate = base.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= base:
        candidate += timedelta(days=1)
    return candidate


def format_scheduled_note(scheduled_at: str | None) -> str:
    if not scheduled_at:
        return ""
    try:
        dt = datetime.fromisoformat(scheduled_at.replace("Z", "+00:00"))
        label = dt.strftime("%-I:%M %p").replace("AM", "AM").replace("PM", "PM")
        # Windows strftime lacks %-I — fallback
        if "%" in label:
            h = dt.hour % 12 or 12
            label = f"{h}:{dt.minute:02d} {'PM' if dt.hour >= 12 else 'AM'}"
        return f"🕐 Scheduled door delivery: {label}"
    except (ValueError, TypeError):
        return f"🕐 Scheduled door delivery: {scheduled_at}"


def compute_order_totals(
    cart: dict[str, Any],
    service_type: str,
    *,
    parcel_per_item: float = 0,
    delivery_charge: float = DEFAULT_DELIVERY_CHARGE,
    gst_rate: float = DEFAULT_GST_RATE,
) -> dict[str, float]:
    """
    Items + parcel (+ delivery for delivery) → GST on combined pre-tax total → grand total.
    Dine-in: no parcel charge.
    """
    items_subtotal = round(cart_total(cart) if cart else 0.0, 2)
    st = (service_type or "").replace("-", "_").lower()

    parcel = 0.0
    if st in ("takeaway", "delivery"):
        parcel = parcel_charge_total(cart, parcel_per_item)

    deli = round(delivery_charge, 2) if st == "delivery" else 0.0
    pre_gst = round(items_subtotal + parcel + deli, 2)
    gst_amount = round(pre_gst * gst_rate / 100, 2)
    grand_total = round(pre_gst + gst_amount, 2)

    return {
        "items_subtotal": items_subtotal,
        "parcel_charge": parcel,
        "delivery_charge": deli,
        "pre_gst_total": pre_gst,
        "gst_amount": gst_amount,
        "gst_rate": gst_rate,
        "grand_total": grand_total,
    }


def format_order_total_lines(
    totals: dict[str, float],
    *,
    compact: bool = False,
    session_state: dict[str, Any] | None = None,
) -> str:
    """Human-readable price breakdown for WhatsApp messages."""
    from tools.delivery_distance import format_delivery_line

    lines = [f"Items: ₹{totals['items_subtotal']:.0f}"]
    if totals.get("parcel_charge", 0) > 0:
        lines.append(f"Parcel/packaging: ₹{totals['parcel_charge']:.0f}")
    deli_line = format_delivery_line(totals, session_state)
    if deli_line:
        lines.append(deli_line)
    elif totals.get("delivery_charge", 0) > 0:
        lines.append(f"Delivery: ₹{totals['delivery_charge']:.0f}")
    if not compact:
        lines.append(f"GST ({totals.get('gst_rate', DEFAULT_GST_RATE):.0f}%): ₹{totals['gst_amount']:.0f}")
    incl_parts = []
    if totals.get("parcel_charge", 0) > 0:
        incl_parts.append(f"₹{totals['parcel_charge']:.0f} packaging")
    if totals.get("delivery_charge", 0) > 0:
        incl_parts.append(f"₹{totals['delivery_charge']:.0f} delivery")
    suffix = f" (incl. {' + '.join(incl_parts)})" if incl_parts else ""
    lines.append(f"*Total: ₹{totals['grand_total']:.0f}*{suffix}")
    return "\n".join(lines)
