"""Feature gate — single place that enforces subscription access.

Every agent, tool, and endpoint that is feature-specific must call
`require_feature()` (async) or `has_feature()` (sync on cached data)
before doing any work.

Design goals
------------
* One function to check, one to raise.  No scattered `if` blocks.
* Restaurant features are cached in-process for TTL seconds so the
  gate adds <1 ms to hot paths.
* The customer-facing denial message is friendly and non-technical.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from db.models import Feature

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# In-process cache:  restaurant_id  →  (features: list[str], ts: float)
# ---------------------------------------------------------------------------
_CACHE: dict[str, tuple[list[str], float]] = {}
_TTL = 300  # 5 minutes


def _cache_get(restaurant_id: str) -> list[str] | None:
    entry = _CACHE.get(restaurant_id)
    if entry and time.monotonic() - entry[1] < _TTL:
        return entry[0]
    return None


def _cache_set(restaurant_id: str, features: list[str]) -> None:
    _CACHE[restaurant_id] = (features, time.monotonic())


def invalidate(restaurant_id: str) -> None:
    """Call after updating a restaurant's subscribed_features."""
    _CACHE.pop(restaurant_id, None)


# ---------------------------------------------------------------------------
# Core gate helpers
# ---------------------------------------------------------------------------

async def get_features(restaurant_id: str) -> list[str]:
    """Return the subscribed feature list for a restaurant.

    Hits the cache first; falls back to the DB via db_tools.
    """
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
    """Sync check against an already-loaded feature list."""
    return feature in features


async def restaurant_has_feature(restaurant_id: str, feature: str) -> bool:
    """Async check that fetches features if not cached."""
    features = await get_features(restaurant_id)
    return feature in features


class FeatureNotSubscribed(Exception):
    """Raised when a restaurant tries to use an unsubscribed feature."""
    def __init__(self, feature: str):
        self.feature = feature
        super().__init__(f"Feature '{feature}' is not subscribed.")


async def require_feature(restaurant_id: str, feature: str) -> None:
    """Raise FeatureNotSubscribed if the restaurant hasn't subscribed.

    Usage in any agent or tool::

        await require_feature(restaurant_id, Feature.DELIVERY)
    """
    if not await restaurant_has_feature(restaurant_id, feature):
        raise FeatureNotSubscribed(feature)


# ---------------------------------------------------------------------------
# WhatsApp-friendly denial messages
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Convenience: build the service menu rows for only subscribed features
# ---------------------------------------------------------------------------

_SERVICE_MENU_ROWS = {
    Feature.DINE_IN: {
        "id": "1", "title": "Dine-in Now 🍽️",
        "description": "Order food at your table",
    },
    Feature.TAKEAWAY: {
        "id": "2", "title": "Takeaway Now 🛍️",
        "description": "Pick up your order at the counter",
    },
    Feature.DELIVERY: {
        "id": "3", "title": "Delivery Now 🛵",
        "description": "We deliver to your door",
    },
    Feature.RESERVE_TABLE: {
        "id": "4", "title": "Reserve a Table 📅",
        "description": "Book a table for a future visit",
    },
}

# IDs are reassigned dynamically so the customer always sees 1, 2, 3 …
# regardless of which features are enabled.
_CHOICE_ID_TO_FEATURE = {
    "1": Feature.DINE_IN,
    "2": Feature.TAKEAWAY,
    "3": Feature.DELIVERY,
    "4": Feature.RESERVE_TABLE,
    "5": None,  # "Nothing, thanks" — always present
}


async def build_service_menu_rows(restaurant_id: str) -> list[dict]:
    features = await get_features(restaurant_id)
    rows = []
    counter = 1
    for feature, template in _SERVICE_MENU_ROWS.items():
        # Compare .value if Feature is an Enum
        feature_val = feature.value if hasattr(feature, 'value') else feature
        if feature_val in features:
            row = dict(template)
            row["id"] = str(counter)
            rows.append(row)
            counter += 1
    rows.append({
        "id": str(counter),
        "title": "Nothing, thanks ❌",
        "description": "Exit",
    })
    return rows

async def resolve_service_choice(restaurant_id: str, choice_id: str) -> str | None:
    """Map a customer's numeric choice back to a Feature constant.

    Returns the Feature string (e.g. Feature.DINE_IN) or None if the
    customer chose "Nothing, thanks".

    Raises ValueError if choice_id is out of range.
    """
    features = await get_features(restaurant_id)
    available = [f for f in _SERVICE_MENU_ROWS if (f.value if hasattr(f, 'value') else f) in features]
    idx = int(choice_id) - 1

    # Last option is always "Nothing"
    if idx == len(available):
        return None

    if idx < 0 or idx >= len(available):
        raise ValueError(f"Invalid choice '{choice_id}' for {len(available)} available features.")

    return available[idx]
