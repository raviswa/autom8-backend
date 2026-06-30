"""Feature gate — subscription access and customer service menu."""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from db.models import Feature

logger = logging.getLogger(__name__)

ORDER_MODE_IMMEDIATE = "immediate"
ORDER_MODE_SCHEDULED = "scheduled"

_CACHE: dict[str, tuple[list[str], float]] = {}
_TTL = 300

SERVICE_ROW_CONFIG: dict[str, dict[str, str]] = {
    "dine_in_now": {
        "title": "🍽️ Dine-In Now",
        "description": "Order food at your table",
    },
    "door_delivery_now": {
        "title": "🛵 Home Delivery",
        "description": "Fresh food delivered to your door",
    },
    "takeaway_now": {
        "title": "🛍️ Take Away",
        "description": "Skip the line, pick up now",
    },
    "table_reservation": {
        "title": "🗓️ Future Reservation",
        "description": "Book your preferred table in advance",
    },
    "scheduled_delivery": {
        "title": "🕒 Scheduled Delivery",
        "description": "Schedule a delivery up to 7 days ahead",
    },
    "scheduled_pickup": {
        "title": "🚗 Scheduled Take Away",
        "description": "Plan your pick-up time in advance",
    },
}


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
        from tools.booking_mechanisms import fetch_restaurant_info

        info = await fetch_restaurant_info(restaurant_id)
        features = _normalize_services_enabled(info)
    except Exception as e:
        logger.exception("Failed to fetch features for restaurant_id=%s: %s", restaurant_id, e)
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
        super().__init__(feature)
        self.feature = feature


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


def _normalize_services_enabled(restaurant: dict) -> list[str]:
    services_enabled = (
        restaurant.get("services_enabled")
        or restaurant.get("subscribed_features")
        or []
    )
    if isinstance(services_enabled, str):
        import json

        try:
            services_enabled = json.loads(services_enabled)
        except Exception:
            services_enabled = []
    return [str(x) for x in services_enabled]


def _service_row(row_id: str) -> dict[str, str]:
    cfg = SERVICE_ROW_CONFIG[row_id]
    return {
        "id": row_id,
        "title": cfg["title"],
        "description": cfg["description"],
    }


def _parse_row_id(row_id: str) -> tuple[str | None, str | None]:
    mapping: dict[str, tuple[str | None, str | None]] = {
        "dine_in_now": (Feature.DINE_IN, None),
        "door_delivery_now": (Feature.DELIVERY, ORDER_MODE_IMMEDIATE),
        "takeaway_now": (Feature.TAKEAWAY, ORDER_MODE_IMMEDIATE),
        "table_reservation": (Feature.RESERVE_TABLE, None),
        "scheduled_delivery": (Feature.DELIVERY, ORDER_MODE_SCHEDULED),
        "scheduled_pickup": (Feature.TAKEAWAY, ORDER_MODE_SCHEDULED),
        "nothing": (None, None),
    }
    return mapping.get(row_id, (None, None))


def build_service_selection_payload(restaurant: dict) -> dict | None:
    services_enabled = _normalize_services_enabled(restaurant)
    scheduled_delivery_enabled = bool(restaurant.get("scheduled_delivery_enabled"))
    scheduled_takeaway_enabled = bool(restaurant.get("scheduled_takeaway_enabled"))

    rows_sec1 = []
    rows_sec2 = []

    if "dine_in" in services_enabled:
        rows_sec1.append({
            "id": "dine_in_now",
            "title": "🍽️ Dine-In Now",
            "description": "Order food at your table",
        })
        rows_sec2.append({
            "id": "table_reservation",
            "title": "🗓️ Future Reservation",
            "description": "Book your preferred table in advance",
        })

    if "delivery" in services_enabled:
        rows_sec1.append({
            "id": "door_delivery_now",
            "title": "🛵 Home Delivery",
            "description": "Fresh food delivered to your door",
        })
        if scheduled_delivery_enabled:
            rows_sec2.append({
                "id": "scheduled_delivery",
                "title": "🕒 Scheduled Delivery",
                "description": "Schedule a delivery up to 7 days ahead",
            })

    if "takeaway" in services_enabled:
        rows_sec1.append({
            "id": "takeaway_now",
            "title": "🛍️ Take Away",
            "description": "Skip the line, pick up now",
        })
        if scheduled_takeaway_enabled:
            rows_sec2.append({
                "id": "scheduled_pickup",
                "title": "🚗 Scheduled Take Away",
                "description": "Plan your pick-up time in advance",
            })

    total_rows = len(rows_sec1) + len(rows_sec2)

    if total_rows == 0:
        return {
            "type": "text",
            "text": {
                "body": "We're not accepting orders right now. Please check back later or contact us directly.",
            },
        }

    sections = []
    if rows_sec1:
        sections.append({"title": "🚀 INSTANT / NOW", "rows": rows_sec1})
    if rows_sec2:
        sections.append({"title": "⏰ PLANNED / LATER", "rows": rows_sec2})

    return {
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {
                "text": "How would you like to receive your order?",
            },
            "action": {
                "button": "👉 Select Service",
                "sections": sections,
            },
        },
    }


async def build_service_menu_rows(
    restaurant_id: str,
    session_state: dict[str, Any] | None = None,
) -> list[dict]:
    from tools.kitchen_hours import kitchen_accepting_orders, refresh_kitchen_acceptance
    from tools.booking_mechanisms import fetch_restaurant_info

    state = session_state or {}
    await refresh_kitchen_acceptance(state, restaurant_id)

    if not kitchen_accepting_orders(state):
        return []

    info = await fetch_restaurant_info(restaurant_id)
    payload = build_service_selection_payload(info)

    if not payload or payload.get("type") != "interactive":
        return []

    sections = payload["interactive"]["action"]["sections"]
    return [row for section in sections for row in section["rows"]]


def _resolve_choice_from_rows(
    choice_id: str,
    rows: list[dict],
) -> tuple[str | None, str | None]:
    valid_ids = {row.get("id") for row in rows}
    if choice_id not in valid_ids:
        return (None, None)
    return _parse_row_id(choice_id)


async def resolve_service_selection(
    restaurant_id: str,
    choice_id: str,
    session_state: dict[str, Any] | None = None,
) -> tuple[str | None, str | None]:
    rows = await build_service_menu_rows(restaurant_id, session_state=session_state)
    return _resolve_choice_from_rows(choice_id, rows)


async def resolve_service_choice(
    restaurant_id: str,
    choice_id: str,
    session_state: dict[str, Any] | None = None,
) -> str | None:
    feature, _ = await resolve_service_selection(
        restaurant_id,
        choice_id,
        session_state=session_state,
    )
    return feature