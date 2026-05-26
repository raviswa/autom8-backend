"""Subscription-related DB helpers.

These are additive — they extend db_tools without modifying it,
so existing code continues to work unchanged.
"""

from __future__ import annotations

import logging
from uuid import UUID

from sqlalchemy import select, update

from db.models import Feature, Restaurant, RestaurantSubscription
from tools.db_tools import AsyncSessionLocal, _RESTAURANT_CACHE

logger = logging.getLogger(__name__)


async def get_restaurant_features(restaurant_id: str) -> list[str]:
    """Return the subscribed_features list for a restaurant from the DB."""
    if AsyncSessionLocal is None:
        return Feature.ALL  # dev fallback: all features enabled

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(Restaurant.subscribed_features)
                .where(Restaurant.id == UUID(restaurant_id))
            )
            row = result.scalar_one_or_none()
            return list(row) if row else []
    except Exception as e:
        logger.error(f"[get_restaurant_features] {restaurant_id}: {e}")
        return []


async def set_restaurant_features(
    restaurant_id: str,
    features: list[str],
) -> bool:
    """Update a restaurant's subscribed features.

    Validates that:
    - At least 2 features are selected.
    - All feature strings are valid Feature constants.
    - Also updates the RestaurantSubscription.features mirror column.

    Returns True on success, raises ValueError on bad input.
    """
    invalid = [f for f in features if f not in Feature.ALL]
    if invalid:
        raise ValueError(f"Unknown features: {invalid}. Valid: {Feature.ALL}")
    if len(features) < 2:
        raise ValueError("At least 2 features must be subscribed.")

    if AsyncSessionLocal is None:
        raise RuntimeError("Database not initialised.")

    async with AsyncSessionLocal() as session:
        await session.execute(
            update(Restaurant)
            .where(Restaurant.id == UUID(restaurant_id))
            .values(subscribed_features=features)
        )
        # Mirror to subscription table if it exists
        sub_result = await session.execute(
            select(RestaurantSubscription)
            .where(RestaurantSubscription.restaurant_id == UUID(restaurant_id))
        )
        sub = sub_result.scalar_one_or_none()
        if sub:
            sub.features = features
            session.add(sub)

        await session.commit()

    # Invalidate in-process caches
    _RESTAURANT_CACHE.pop(restaurant_id, None)
    from tools.feature_gate import invalidate
    invalidate(restaurant_id)

    logger.info(f"[set_restaurant_features] {restaurant_id} → {features}")
    return True


async def get_subscription(restaurant_id: str) -> dict | None:
    """Return billing metadata for a restaurant."""
    if AsyncSessionLocal is None:
        return None
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(RestaurantSubscription)
                .where(RestaurantSubscription.restaurant_id == UUID(restaurant_id))
            )
            sub = result.scalar_one_or_none()
            if not sub:
                return None
            return {
                "features":            list(sub.features),
                "billing_cycle":       sub.billing_cycle,
                "base_price":          float(sub.base_price),
                "discount_pct":        float(sub.discount_pct),
                "final_price":         float(sub.final_price),
                "status":              sub.status,
                "trial_ends_at":       sub.trial_ends_at.isoformat() if sub.trial_ends_at else None,
                "renews_at":           sub.renews_at.isoformat() if sub.renews_at else None,
                "last_meta_cost":      float(sub.last_meta_cost or 0),
                "last_razorpay_cost":  float(sub.last_razorpay_cost or 0),
                "last_billed_month":   sub.last_billed_month,
            }
    except Exception as e:
        logger.error(f"[get_subscription] {restaurant_id}: {e}")
        return None
