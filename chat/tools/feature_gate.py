"""Feature gate — subscription access and customer service menu."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from db.models import Feature

logger = logging.getLogger(__name__)

ORDER_MODE_IMMEDIATE = "immediate"
ORDER_MODE_SCHEDULED = "scheduled"

# Must match Node src/helpers/subscriptionAccess.js
GRACE_PERIOD_DAYS = max(1, int(os.getenv("SUBSCRIPTION_GRACE_PERIOD_DAYS", "15") or "15"))
LAPSED_ERROR = "subscription_lapsed"
# Reminder job sets this on unpaid tenants at T+0 / T+15
OVERDUE_STATUS_TENANT = "past_due"

_IST = ZoneInfo("Asia/Kolkata")

_CACHE: dict[str, tuple[list[str], float]] = {}
_TTL = 300
_SUB_CACHE: dict[str, tuple[dict | None, float]] = {}
_SUB_TTL = 60


def _ist_date_key(dt: datetime | None = None) -> str:
    d = dt or datetime.now(_IST)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc).astimezone(_IST)
    else:
        d = d.astimezone(_IST)
    return d.strftime("%Y-%m-%d")


def _to_date_key(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        if len(value) >= 10 and value[4] == "-" and value[7] == "-":
            return value[:10]
        try:
            return _to_date_key(datetime.fromisoformat(value.replace("Z", "+00:00")))
        except Exception:
            return None
    if isinstance(value, datetime):
        return _ist_date_key(value)
    return None


def days_relative_to_anchor(anchor: Any, now: datetime | None = None) -> int | None:
    """Negative = before anchor, 0 = due today, positive = days past (IST calendar)."""
    anchor_key = _to_date_key(anchor)
    today_key = _ist_date_key(now)
    if not anchor_key or not today_key:
        return None
    ay, am, ad = map(int, anchor_key.split("-"))
    ty, tm, td = map(int, today_key.split("-"))
    return (datetime(ty, tm, td) - datetime(ay, am, ad)).days


def get_cycle_anchor(sub: dict | None) -> Any:
    if not sub:
        return None
    if sub.get("status") == "trial":
        return sub.get("trial_ends_at")
    return sub.get("renews_at") or sub.get("trial_ends_at")


def is_subscription_soft_locked(sub: dict | None, now: datetime | None = None) -> bool:
    """Authoritative soft-lock: daysPast(anchor) >= GRACE_PERIOD_DAYS."""
    if not sub:
        return False
    if sub.get("status") == "cancelled":
        return True
    anchor = get_cycle_anchor(sub)
    if not anchor:
        return False
    relative = days_relative_to_anchor(anchor, now)
    if relative is None:
        return False
    return relative >= GRACE_PERIOD_DAYS


def build_lapsed_payload(sub: dict | None = None) -> dict:
    sub = sub or {}
    anchor = get_cycle_anchor(sub)
    grace_ends_at = None
    key = _to_date_key(anchor)
    if key:
        y, m, d = map(int, key.split("-"))
        grace_ends_at = (
            datetime(y, m, d, tzinfo=timezone.utc) + timedelta(days=GRACE_PERIOD_DAYS)
        ).isoformat()
    return {
        "error": LAPSED_ERROR,
        "message": (
            "Subscription expired. Please renew to create new orders or send campaigns. "
            "You can still view history and complete payments."
        ),
        "grace_ends_at": grace_ends_at,
        "renews_at": sub.get("renews_at"),
        "trial_ends_at": sub.get("trial_ends_at"),
        "status": sub.get("status"),
    }


async def fetch_tenant_subscription(restaurant_id: str) -> dict | None:
    cached = _SUB_CACHE.get(restaurant_id)
    if cached and time.monotonic() - cached[1] < _SUB_TTL:
        return cached[0]
    try:
        from tools.db_tools import AsyncSessionLocal
        from sqlalchemy import text

        if AsyncSessionLocal is None:
            return None
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text(
                    "SELECT id, status, trial_ends_at, renews_at "
                    "FROM tenant_subscriptions "
                    "WHERE restaurant_id = :rid LIMIT 1"
                ),
                {"rid": restaurant_id},
            )
            row = result.mappings().first()
            data = dict(row) if row else None
    except Exception as e:
        logger.warning("fetch_tenant_subscription failed restaurant_id=%s: %s", restaurant_id, e)
        data = None
    _SUB_CACHE[restaurant_id] = (data, time.monotonic())
    return data


async def assert_tenant_subscription_allows(
    restaurant_id: str,
    action: str,
) -> tuple[bool, dict | None]:
    """
    Soft-lock write gate for tenants.
    Blocked actions: create_order, send_order_link, send_marketing
    Allowed: reads, payment flows, balance/status checks.
    """
    blocked = {"create_order", "send_order_link", "send_marketing"}
    if action not in blocked:
        return True, None
    sub = await fetch_tenant_subscription(restaurant_id)
    if not is_subscription_soft_locked(sub):
        return True, None
    return False, build_lapsed_payload(sub)


SERVICE_ROW_CONFIG: dict[str, dict[str, str]] = {
    "token_queue": {
        "title": "🎫 Token / Queue",
        "description": "Get a queue token, we'll take it from there",
    },
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

    # Support boolean maps like {"dine_in": true, ...}.
    if isinstance(services_enabled, dict):
        return [str(k) for k, v in services_enabled.items() if bool(v)]

    if isinstance(services_enabled, str):
        try:
            parsed = json.loads(services_enabled)
            if isinstance(parsed, dict):
                return [str(k) for k, v in parsed.items() if bool(v)]
            services_enabled = parsed
        except Exception:
            services_enabled = [x.strip() for x in services_enabled.split(",") if x.strip()]

    if not isinstance(services_enabled, list):
        return []

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
        "token_queue": (Feature.TOKEN_MANAGEMENT, None),
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

    dine_in_on = Feature.DINE_IN in services_enabled

    # Token / Queue is a walk-in handoff for restaurants WITHOUT Dine-In ordering.
    # When Dine-In is opted in, hide Token / Queue — customers should use Dine-In Now.
    if Feature.TOKEN_MANAGEMENT in services_enabled and not dine_in_on:
        rows_sec1.append(_service_row("token_queue"))

    if dine_in_on:
        rows_sec1.append(_service_row("dine_in_now"))
        rows_sec2.append(_service_row("table_reservation"))

    if Feature.DELIVERY in services_enabled:
        rows_sec1.append(_service_row("door_delivery_now"))
        if scheduled_delivery_enabled:
            rows_sec2.append(_service_row("scheduled_delivery"))

    if Feature.TAKEAWAY in services_enabled:
        rows_sec1.append(_service_row("takeaway_now"))
        if scheduled_takeaway_enabled:
            rows_sec2.append(_service_row("scheduled_pickup"))

    total_rows = len(rows_sec1) + len(rows_sec2)

    if total_rows == 0:
        return {
            "type": "text",
            "text": {
                "body": "We're not taking walk-ins right now. Please check back later or contact us directly.",
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
                "text": "How can we help you today?",
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

    info = await fetch_restaurant_info(restaurant_id)
    payload = build_service_selection_payload(info)

    if not payload or payload.get("type") != "interactive":
        return []

    sections = payload["interactive"]["action"]["sections"]
    rows = [row for section in sections for row in section["rows"]]

    # Kitchen closed: still offer Token / Queue (walk-in handoff), hide order flows.
    if not kitchen_accepting_orders(state):
        rows = [r for r in rows if r.get("id") == "token_queue"]

    return rows


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