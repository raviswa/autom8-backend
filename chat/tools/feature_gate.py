"""Feature gate — subscription access and customer service menu."""

from __future__ import annotations

import logging
import time
from typing import Any

from db.models import Feature

logger = logging.getLogger(__name__)

ORDER_MODE_IMMEDIATE = "immediate"
ORDER_MODE_SCHEDULED = "scheduled"

_CACHE: dict[str, tuple[list[str], float]] = {}
_TTL = 300


def _cache_get(restaurant_id: str) -> list[str] | None:
    entry = _CACHE.get(restaurant_id)
    if entry and time.monotonic() - entry[1] < _TTL:
        return entry[0]
    return None


def _cache_set(restaurant_id: str, features: list[str]) -> None:
    _CACHE[restaurant_id] = (features, time.monotonic())


def invalidate(restaurant_id: str) -> None:
    _CACHE.pop(restaurant_id, None)


async def get_features(restaurant_id: str) -> list[str]:
    cached = _cache_get(restaurant_id)
    if cached is not None:
        return cached
    try:
        from tools.db_tools import get_restaurant_features
        features = await get_restaurant_features(restaurant_id)
    except Exception as e:
        logger.warning(f"[feature_gate] DB lookup failed for {restaurant_id}: {e}")
        features = []
    _cache_set(restaurant_id, features)
    return features


def has_feature(features: list[str], feature: str) -> bool:
    return feature in features


async def restaurant_has_feature(restaurant_id: str, feature: str) -> bool:
    features = await get_features(restaurant_id)
    return feature in features


class FeatureNotSubscribed(Exception):
    def __init__(self, feature: str):
        self.feature = feature
        super().__init__(f"Feature '{feature}' is not subscribed.")


async def require_feature(restaurant_id: str, feature: str) -> None:
    if not await restaurant_has_feature(restaurant_id, feature):
        raise FeatureNotSubscribed(feature)


_DENIAL_MESSAGES: dict[str, str] = {
    Feature.TOKEN_MANAGEMENT: (
        "Token queue management isn't part of your current plan. "
        "Please ask your restaurant manager to upgrade. 🙏"
    ),
    Feature.DINE_IN: (
        "Dine-in ordering isn't enabled for this restaurant yet. "
        "Please speak to a staff member to place your order. 🍽️"
    ),
    Feature.TAKEAWAY: (
        "Online takeaway ordering isn't available here yet. "
        "Please visit the counter to place your order. 🛍️"
    ),
    Feature.DELIVERY: (
        "Door delivery isn't available from this restaurant yet. 🛵"
    ),
    Feature.RESERVE_TABLE: (
        "Table reservations aren't enabled here yet. "
        "Please call us directly to book a table. 📅"
    ),
}

_DEFAULT_DENIAL = (
    "This feature isn't part of your restaurant's current plan. "
    "Please contact the manager for details. 🙏"
)


def denial_message(feature: str) -> str:
    return _DENIAL_MESSAGES.get(feature, _DEFAULT_DENIAL)


def _feature_val(feature) -> str:
    return feature.value if hasattr(feature, "value") else feature


def _parse_row_id(row_id: str) -> tuple[str | None, str | None]:
    """Map menu row id → (service_type, order_mode)."""
    mapping: dict[str, tuple[str | None, str | None]] = {
        "dine_in": (Feature.DINE_IN, None),
        "takeaway_now": (Feature.TAKEAWAY, ORDER_MODE_IMMEDIATE),
        "takeaway_schedule": (Feature.TAKEAWAY, ORDER_MODE_SCHEDULED),
        "delivery_now": (Feature.DELIVERY, ORDER_MODE_IMMEDIATE),
        "delivery_schedule": (Feature.DELIVERY, ORDER_MODE_SCHEDULED),
        "reserve_table": (Feature.RESERVE_TABLE, None),
        "nothing": (None, None),
    }
    return mapping.get(row_id, (None, None))


async def build_service_menu_rows(
    restaurant_id: str,
    session_state: dict[str, Any] | None = None,
) -> list[dict]:
    """Build WhatsApp list rows when kitchen is accepting orders."""
    from tools.kitchen_hours import kitchen_accepting_orders, refresh_kitchen_acceptance

    state = session_state or {}
    await refresh_kitchen_acceptance(state, restaurant_id)

    if not kitchen_accepting_orders(state):
        return [{
            "id": "nothing",
            "title": "Nothing, thanks ❌",
            "description": "Exit",
        }]

    features = await get_features(restaurant_id)
    feature_set = set(features)

    sched_delivery = state.get("scheduled_delivery_enabled")
    sched_takeaway = state.get("scheduled_takeaway_enabled")
    if sched_delivery is None or sched_takeaway is None:
        from tools.booking_mechanisms import fetch_restaurant_info
        info = await fetch_restaurant_info(restaurant_id)
        if sched_delivery is None:
            sched_delivery = bool(info.get("scheduled_delivery_enabled"))
        if sched_takeaway is None:
            sched_takeaway = bool(info.get("scheduled_takeaway_enabled"))

    rows: list[dict] = []

    if _feature_val(Feature.DINE_IN) in feature_set:
        rows.append({
            "id": "dine_in",
            "title": "Dine-in Now 🍽️",
            "description": "Order food at your table",
        })

    if _feature_val(Feature.TAKEAWAY) in feature_set:
        rows.append({
            "id": "takeaway_now",
            "title": "Take-away now 🛍️",
            "description": "Pick up as soon as it's ready",
        })

    if _feature_val(Feature.DELIVERY) in feature_set:
        rows.append({
            "id": "delivery_now",
            "title": "Deliver Now 🛵",
            "description": "We deliver to your door ASAP",
        })

    if _feature_val(Feature.TAKEAWAY) in feature_set and sched_takeaway:
        rows.append({
            "id": "takeaway_schedule",
            "title": "Scheduled take-away 📅",
            "description": "Choose pickup date & time on the calendar",
        })

    if _feature_val(Feature.DELIVERY) in feature_set and sched_delivery:
        rows.append({
            "id": "delivery_schedule",
            "title": "Schedule Delivery 📅",
            "description": "Scheduled door delivery — pick date & time",
        })

    if _feature_val(Feature.RESERVE_TABLE) in feature_set:
        rows.append({
            "id": "reserve_table",
            "title": "Reserve a Table 📅",
            "description": "Book a table for a future visit",
        })

    rows.append({
        "id": "nothing",
        "title": "Nothing, thanks ❌",
        "description": "Exit",
    })
    return rows


def _resolve_choice_from_rows(
    choice_id: str,
    rows: list[dict],
) -> tuple[str | None, str | None]:
    raw = (choice_id or "").strip()

    for row in rows:
        if row["id"] == raw:
            return _parse_row_id(row["id"])

    if raw.isdigit():
        idx = int(raw) - 1
        if 0 <= idx < len(rows):
            return _parse_row_id(rows[idx]["id"])

    raise ValueError(f"Invalid choice '{choice_id}' for {len(rows)} menu options.")


async def resolve_service_selection(
    restaurant_id: str,
    choice_id: str,
    session_state: dict[str, Any] | None = None,
) -> tuple[str | None, str | None]:
    """Returns (service_type, order_mode). order_mode is immediate|scheduled|None."""
    rows = (session_state or {}).get("_service_menu_rows")
    if not rows:
        rows = await build_service_menu_rows(restaurant_id, session_state)
    return _resolve_choice_from_rows(choice_id, rows)


async def resolve_service_choice(
    restaurant_id: str,
    choice_id: str,
    session_state: dict[str, Any] | None = None,
) -> str | None:
    """Backward-compatible wrapper — returns service_type only."""
    service_type, _mode = await resolve_service_selection(
        restaurant_id, choice_id, session_state,
    )
    return service_type
