"""FastAPI middleware helpers for feature gating at the webhook/route level.

These are thin wrappers used in main.py to guard the token management
endpoint and any future HTTP endpoints that map to specific features.
"""

from __future__ import annotations

import logging
from typing import Callable, Awaitable

from fastapi import Request, HTTPException

from tools.feature_gate import require_feature, FeatureNotSubscribed

logger = logging.getLogger(__name__)


def feature_required(feature: str):
    """FastAPI dependency that checks the restaurant's subscription.

    Usage::

        @app.post("/webhook/token")
        async def token_endpoint(
            request: Request,
            _: None = Depends(feature_required(Feature.TOKEN_MANAGEMENT)),
        ):
            ...

    The restaurant_id must already be resolved on request.state by earlier
    middleware (e.g. the restaurant lookup in _process_meta_payload).
    If not present, the check is skipped (dev / test mode).
    """
    async def _dep(request: Request):
        restaurant_id = getattr(request.state, "restaurant_id", None)
        if not restaurant_id:
            return  # can't check without an id — let the handler deal with it
        try:
            await require_feature(restaurant_id, feature)
        except FeatureNotSubscribed as e:
            raise HTTPException(status_code=403, detail=str(e))
    return _dep
