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
    """
    Build WhatsApp interactive list message payload based on Rule 1-3.
    Returns:
      - dict (type: list payload or type: text payload)
      - None if Rule 3 triggers (caller proceeds directly)
    """
    services_enabled = restaurant.get("services_enabled") or []
    if isinstance(services_enabled, str):
        import json
        try:
            services_enabled = json.loads(services_enabled)
        except Exception:
            services_enabled = []

    scheduled_delivery_enabled = bool(restaurant.get("scheduled_delivery_enabled"))
    scheduled_takeaway_enabled = bool(restaurant.get("scheduled_takeaway_enabled"))

    rows_sec1 = []
    rows_sec2 = []

    # Section 1: 🚀 INSTANT / NOW
    if "dine_in" in services_enabled:
        rows_sec1.append({
            "id": "dine_in_now",
            "title": "🍽️ Dine-In Now",
            "description": "Order food at your table",
        })
    if "delivery" in services_enabled:
        rows_sec1.append({
            "id": "door_delivery_now",
            "title": "🛵 Home Delivery",
            "description": "Fresh food delivered to your door",
        })
    if "takeaway" in services_enabled:
        rows_sec1.append({
            "id": "takeaway_now",
            "title": "🛍️ Take Away",
            "description": "Skip the line, pick up now",
        })

    # Section 2: ⏰ PLANNED / LATER
    if "dine_in" in services_enabled:
        rows_sec2.append({
            "id": "table_reservation",
            "title": "🗓️ Future Reservation",
            "description": "Book your preferred table in advance",
        })
    if "delivery" in services_enabled and scheduled_delivery_enabled:
        rows_sec2.append({
            "id": "scheduled_delivery",
            "title": "🕒 Scheduled Delivery",
            "description": "Schedule a delivery up to 7 days ahead",
        })
    if "takeaway" in services_enabled and scheduled_takeaway_enabled:
        rows_sec2.append({
            "id": "scheduled_pickup",
            "title": "🚗 Scheduled Take Away",
            "description": "Plan your pick-up time in advance",
        })

    total_rows = len(rows_sec1) + len(rows_sec2)

    # RULE 2: Minimum viable menu guard
    if total_rows == 0:
        return {
            "type": "text",
            "text": {
                "body": "We're not accepting orders right now. Please check back later or contact us directly."
            }
        }

    # RULE 3: Single row shortcut
    if total_rows == 1:
        return None

    sections = []
    if rows_sec1:
        sections.append({
            "title": "🚀 INSTANT / NOW"[:24],
            "rows": rows_sec1
        })
    if rows_sec2:
        sections.append({
            "title": "⏰ PLANNED / LATER"[:24],
            "rows": rows_sec2
        })

    return {
        "type": "interactive",
        "interactive": {
            "type": "list",
            "action": {
                "button": "👉 Select Service",
                "sections": sections
            }
        }
    }


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

    from tools.booking_mechanisms import fetch_restaurant_info
    info = await fetch_restaurant_info(restaurant_id)

    services_enabled = info.get("services_enabled") or []
    if isinstance(services_enabled, str):
        import json
        try:
            services_enabled = json.loads(services_enabled)
        except Exception:
            services_enabled = []

    scheduled_delivery_enabled = bool(info.get("scheduled_delivery_enabled"))
    scheduled_takeaway_enabled = bool(info.get("scheduled_takeaway_enabled"))

    rows = []
    # Section 1: 🚀 INSTANT / NOW
    if "dine_in" in services_enabled:
        rows.append({
            "id": "dine_in_now",
            "title": "🍽️ Dine-In Now",
            "description": "Order food at your table",
        })
    if "delivery" in services_enabled:
        rows.append({
            "id": "door_delivery_now",
            "title": "🛵 Home Delivery",
            "description": "Fresh food delivered to your door",
        })
    if "takeaway" in services_enabled:
        rows.append({
            "id": "takeaway_now",
            "title": "🛍️ Take Away",
            "description": "Skip the line, pick up now",
        })

    # Section 2: ⏰ PLANNED / LATER
    if "dine_in" in services_enabled:
        rows.append({
            "id": "table_reservation",
            "title": "🗓️ Future Reservation",
            "description": "Book your preferred table in advance",
        })
    if "delivery" in services_enabled and scheduled_delivery_enabled:
        rows.append({
            "id": "scheduled_delivery",
            "title": "🕒 Scheduled Delivery",
            "description": "Schedule a delivery slot up to 7 days ahead",
        })
    if "takeaway" in services_enabled and scheduled_takeaway_enabled:
        rows.append({
            "id": "scheduled_pickup",
            "title": "🚗 Scheduled Take Away",
            "description": "Plan your take away time in advance",
        })

    # Cache in session state
    state["scheduled_delivery_enabled"] = scheduled_delivery_enabled
    state["scheduled_takeaway_enabled"] = scheduled_takeaway_enabled
    state["services_enabled"] = services_enabled

    return rows


# ─── Assertion Tests ─────────────────────────────────────────────────────────
def _run_assertions():
    # TEST A
    res_a = build_service_selection_payload({
        "services_enabled": ["dine_in", "takeaway", "delivery"],
        "scheduled_delivery_enabled": True,
        "scheduled_takeaway_enabled": True,
    })
    assert res_a is not None
    assert res_a["type"] == "interactive"
    secs = res_a["interactive"]["action"]["sections"]
    assert len(secs) == 2
    assert secs[0]["title"] == "🚀 INSTANT / NOW"
    assert len(secs[0]["rows"]) == 3
    assert secs[1]["title"] == "⏰ PLANNED / LATER"
    assert len(secs[1]["rows"]) == 3

    # TEST B
    res_b = build_service_selection_payload({
        "services_enabled": ["delivery"],
        "scheduled_delivery_enabled": False,
        "scheduled_takeaway_enabled": False,
    })
    # Since total_rows == 1, Rule 3 triggers, returning None
    assert res_b is None

    # TEST C
    res_c = build_service_selection_payload({
        "services_enabled": ["takeaway"],
        "scheduled_delivery_enabled": False,
        "scheduled_takeaway_enabled": True,
    })
    assert res_c is not None
    assert res_c["type"] == "interactive"
    secs_c = res_c["interactive"]["action"]["sections"]
    assert len(secs_c) == 2
    assert secs_c[0]["title"] == "🚀 INSTANT / NOW"
    assert len(secs_c[0]["rows"]) == 1
    assert secs_c[0]["rows"][0]["id"] == "takeaway_now"
    assert secs_c[1]["title"] == "⏰ PLANNED / LATER"
    assert len(secs_c[1]["rows"]) == 1
    assert secs_c[1]["rows"][0]["id"] == "scheduled_pickup"

_run_assertions()


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
