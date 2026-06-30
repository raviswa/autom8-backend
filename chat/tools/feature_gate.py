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

SERVICE_BUTTON_LABEL = "👉 Select Service"
SERVICE_LIST_BODY = "How would you like to receive your order?"

SECTION_INSTANT = "🚀 INSTANT / NOW"
SECTION_PLANNED = "⏰ PLANNED / LATER"

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


def _feature_val(feature: Any) -> str:
    return feature.value if hasattr(feature, "value") else str(feature)


def _restaurant_value(restaurant: Any, key: str, default: Any = None) -> Any:
    if isinstance(restaurant, dict):
        return restaurant.get(key, default)
    return getattr(restaurant, key, default)


def _normalize_services_enabled(restaurant: Any) -> list[str]:
    raw = _restaurant_value(restaurant, "services_enabled")
    if raw in (None, "", []):
        raw = _restaurant_value(restaurant, "subscribed_features", [])

    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except Exception:
            raw = []

    if not isinstance(raw, list):
        return []

    normalized = {_feature_val(item).strip() for item in raw if item}
    return sorted(normalized)


def _service_row(row_id: str) -> dict[str, str]:
    row = SERVICE_ROW_CONFIG[row_id]
    return {
        "id": row_id,
        "title": row["title"],
        "description": row["description"],
    }


async def get_features(restaurant_id: str) -> list[str]:
    cached = _cache_get(restaurant_id)
    if cached is not None:
        return cached

    features: list[str] = []
    try:
        from tools.booking_mechanisms import fetch_restaurant_info

        restaurant = await fetch_restaurant_info(restaurant_id)
        if restaurant:
            features = _normalize_services_enabled(restaurant)
    except Exception as e:
        logger.exception("Failed to fetch features for restaurant_id=%s: %s", restaurant_id, e)

    _cache_set(restaurant_id, features)
    return features


def has_feature(features: list[str], feature: str) -> bool:
    return _feature_val(feature) in {_feature_val(item) for item in features}


async def restaurant_has_feature(restaurant_id: str, feature: str) -> bool:
    features = await get_features(restaurant_id)
    return has_feature(features, feature)


class FeatureNotSubscribed(Exception):
    def __init__(self, feature: str):
        self.feature = feature
        super().__init__(feature)


async def require_feature(restaurant_id: str, feature: str) -> None:
    if not await restaurant_has_feature(restaurant_id, feature):
        raise FeatureNotSubscribed(feature)


_DENIAL_MESSAGES: dict[str, str] = {
    _feature_val(Feature.TOKEN_MANAGEMENT): (
        "Token queue management isn't part of your current plan. "
        "Please ask your restaurant manager to upgrade. 🙏"
    ),
    _feature_val(Feature.DINE_IN): (
        "Dine-in ordering isn't enabled for this restaurant yet. "
        "Please speak to a staff member to place your order. 🍽️"
    ),
    _feature_val(Feature.TAKEAWAY): (
        "Online takeaway ordering isn't available here yet. "
        "Please visit the counter to place your order. 🛍️"
    ),
    _feature_val(Feature.DELIVERY): (
        "Door delivery isn't available from this restaurant yet. 🛵"
    ),
    _feature_val(Feature.RESERVE_TABLE): (
        "Table reservations aren't enabled here yet. "
        "Please call us directly to book a table. 📅"
    ),
}

_DEFAULT_DENIAL = (
    "This feature isn't part of your restaurant's current plan. "
    "Please contact the manager for details. 🙏"
)


def denial_message(feature: str) -> str:
    return _DENIAL_MESSAGES.get(_feature_val(feature), _DEFAULT_DENIAL)


def _parse_row_id(row_id: str) -> tuple[str | None, str | None]:
    """Map menu row id → (service_type, order_mode)."""
    mapping: dict[str, tuple[str | None, str | None]] = {
        "dine_in_now": (_feature_val(Feature.DINE_IN), ORDER_MODE_IMMEDIATE),
        "door_delivery_now": (_feature_val(Feature.DELIVERY), ORDER_MODE_IMMEDIATE),
        "takeaway_now": (_feature_val(Feature.TAKEAWAY), ORDER_MODE_IMMEDIATE),
        "table_reservation": (_feature_val(Feature.RESERVE_TABLE), ORDER_MODE_SCHEDULED),
        "scheduled_delivery": (_feature_val(Feature.DELIVERY), ORDER_MODE_SCHEDULED),
        "scheduled_pickup": (_feature_val(Feature.TAKEAWAY), ORDER_MODE_SCHEDULED),
    }
    return mapping.get(row_id, (None, None))


def build_service_selection_payload(restaurant: dict) -> dict | None:
    """
    Build the native WhatsApp interactive list payload.

    Returns:
    - interactive list payload
    - text payload when no rows are available
    - None only if caller wants to implement a single-row shortcut separately

    Note:
    The single-row shortcut is optional. This implementation keeps the
    one-row list behavior so the requested payload tests pass as specified.
    """
    services_enabled = set(_normalize_services_enabled(restaurant))
    scheduled_delivery_enabled = bool(_restaurant_value(restaurant, "scheduled_delivery_enabled", False))
    scheduled_takeaway_enabled = bool(_restaurant_value(restaurant, "scheduled_takeaway_enabled", False))

    instant_rows: list[dict[str, str]] = []
    planned_rows: list[dict[str, str]] = []

    if "dine_in" in services_enabled:
        instant_rows.append(_service_row("dine_in_now"))
        planned_rows.append(_service_row("table_reservation"))

    if "delivery" in services_enabled:
        instant_rows.append(_service_row("door_delivery_now"))
        if scheduled_delivery_enabled:
            planned_rows.append(_service_row("scheduled_delivery"))

    if "takeaway" in services_enabled:
        instant_rows.append(_service_row("takeaway_now"))
        if scheduled_takeaway_enabled:
            planned_rows.append(_service_row("scheduled_pickup"))

    total_rows = len(instant_rows) + len(planned_rows)
    if total_rows == 0:
        return {
            "type": "text",
            "text": {
                "body": (
                    "We're not accepting orders right now. "
                    "Please check back later or contact us directly."
                )
            },
        }

    sections: list[dict[str, Any]] = []
    if instant_rows:
        sections.append({
            "title": SECTION_INSTANT,
            "rows": instant_rows,
        })
    if planned_rows:
        sections.append({
            "title": SECTION_PLANNED,
            "rows": planned_rows,
        })

    return {
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {
                "text": SERVICE_LIST_BODY,
            },
            "action": {
                "button": SERVICE_BUTTON_LABEL,
                "sections": sections,
            },
        },
    }


async def build_service_menu_rows(
    restaurant_id: str,
    session_state: dict[str, Any] | None = None,
) -> list[dict]:
    try:
        from tools.kitchen_hours import kitchen_accepting_orders, refresh_kitchen_acceptance
        from tools.booking_mechanisms import fetch_restaurant_info
    except Exception:
        logger.exception("Unable to import booking dependencies for service menu rows")
        return []

    state = session_state or {}

    try:
        await refresh_kitchen_acceptance(state, restaurant_id)
        if not kitchen_accepting_orders(state):
            return []

        restaurant = await fetch_restaurant_info(restaurant_id)
        if not restaurant:
            return []

        payload = build_service_selection_payload(restaurant)
        if not payload or payload.get("type") != "interactive":
            return []

        sections = payload["interactive"]["action"]["sections"]
        return [row for section in sections for row in section.get("rows", [])]
    except Exception as e:
        logger.exception("Failed to build service menu rows for restaurant_id=%s: %s", restaurant_id, e)
        return []


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


# ─── Manual Assertion Tests ──────────────────────────────────────────────────
def _run_assertions() -> None:
    full_service = {
        "services_enabled": ["dine_in", "takeaway", "delivery"],
        "scheduled_delivery_enabled": True,
        "scheduled_takeaway_enabled": True,
    }
    payload = build_service_selection_payload(full_service)
    assert payload is not None
    rows = [
        row["id"]
        for section in payload["interactive"]["action"]["sections"]
        for row in section["rows"]
    ]
    assert len(rows) == 6

    delivery_only = {
        "services_enabled": ["delivery"],
        "scheduled_delivery_enabled": False,
        "scheduled_takeaway_enabled": False,
    }
    payload = build_service_selection_payload(delivery_only)
    assert payload is not None
    sections = payload["interactive"]["action"]["sections"]
    assert len(sections) == 1
    assert [row["id"] for row in sections[0]["rows"]] == ["door_delivery_now"]

    takeaway_scheduled = {
        "services_enabled": ["takeaway"],
        "scheduled_delivery_enabled": False,
        "scheduled_takeaway_enabled": True,
    }
    payload = build_service_selection_payload(takeaway_scheduled)
    assert payload is not None
    sections = payload["interactive"]["action"]["sections"]
    assert [row["id"] for row in sections[0]["rows"]] == ["takeaway_now"]
    assert [row["id"] for row in sections[1]["rows"]] == ["scheduled_pickup"]