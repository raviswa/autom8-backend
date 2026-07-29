"""Per-restaurant config from DB — canonical source for tenant WhatsApp/Meta settings."""

from __future__ import annotations

import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)

_INTEGRATION_TTL = 300.0
_row_cache: dict[str, tuple[dict[str, Any] | None, float]] = {}
_integration_cache: dict[str, tuple[dict[str, Any] | None, float]] = {}


async def get_restaurant_row(restaurant_id: str) -> dict[str, Any] | None:
    if not restaurant_id:
        return None
    now = time.monotonic()
    cached, ts = _row_cache.get(restaurant_id, (None, 0.0))
    if cached is not None and now - ts < _INTEGRATION_TTL:
        return cached

    from tools.db_tools import get_restaurant_by_id
    row = await get_restaurant_by_id(restaurant_id)
    _row_cache[restaurant_id] = (row, now)
    return row


def invalidate_restaurant_config_cache(restaurant_id: str | None = None) -> None:
    if restaurant_id:
        _row_cache.pop(restaurant_id, None)
        _integration_cache.pop(restaurant_id, None)
    else:
        _row_cache.clear()
        _integration_cache.clear()


async def get_meta_catalog_id(restaurant_id: str | None) -> str | None:
    """Per-restaurant Meta catalog ID. Never env-fallback when restaurant_id is set."""
    if restaurant_id:
        row = await get_restaurant_row(restaurant_id)
        if row and row.get("meta_catalog_id"):
            return str(row["meta_catalog_id"]).strip()

        logger.error(
            "[restaurant_config] meta_catalog_id missing for %s — "
            "refusing env fallback (wrong catalog is a showstopper)",
            restaurant_id,
        )
        return None

    env = (os.getenv("META_CATALOG_ID") or "").strip()
    if env:
        logger.warning(
            "[restaurant_config] using META_CATALOG_ID env (no restaurant_id — dev only)"
        )
        return env
    return None


async def get_manager_phone(restaurant_id: str | None) -> str | None:
    """Canonical manager alert number — DB first, then MANAGER_WHATSAPP_NUMBER env."""
    if restaurant_id:
        row = await get_restaurant_row(restaurant_id)
        if row and row.get("manager_phone"):
            return str(row["manager_phone"]).strip()

    env = (os.getenv("MANAGER_WHATSAPP_NUMBER") or "").strip()
    if env:
        if restaurant_id:
            logger.warning(
                "[restaurant_config] manager_phone missing for %s — env fallback",
                restaurant_id,
            )
        return env
    return None


# Tokens that are clearly placeholders — never valid for Meta Graph API calls.
# Extend this set if new placeholder patterns are discovered.
_PLACEHOLDER_TOKENS: frozenset[str] = frozenset({
    "demo1234", "your_access_token_here", "placeholder", "changeme",
    "test1234", "demotoken", "demo_token", "fake_token",
})


def _is_placeholder_token(token: str | None) -> bool:
    """Return True when a token is a known-bad placeholder rather than a real credential."""
    if not token:
        return True
    t = token.strip().lower()
    return t in _PLACEHOLDER_TOKENS or len(t) < 20  # real Meta tokens are 100-250 chars


async def get_whatsapp_credentials(restaurant_id: str | None) -> dict[str, str] | None:
    """Resolve outbound WhatsApp credentials. DB integration is canonical.

    Placeholder tokens (e.g. 'demo1234') are rejected and logged so the error
    surface is explicit rather than a silent Meta 401 on the first customer message.
    """
    if not restaurant_id:
        return _env_whatsapp_fallback("no restaurant_id")

    now = time.monotonic()
    cached, ts = _integration_cache.get(restaurant_id, (None, 0.0))
    if cached is not None and now - ts < _INTEGRATION_TTL:
        return cached

    from tools.db_tools import get_restaurant_integration

    for provider in ("meta", "botbiz"):
        integration = await get_restaurant_integration(restaurant_id, provider, "whatsapp")
        if integration:
            phone_number_id = integration.get("phone_number_id")
            access_token = integration.get("access_token")
            if phone_number_id and access_token:
                if _is_placeholder_token(access_token):
                    logger.error(
                        "[restaurant_config] ❌ PLACEHOLDER token detected for %s "
                        "(provider=%s phone_number_id=%s token_prefix=%s) — "
                        "update tenant_integrations.access_token with a real Meta token; "
                        "falling through to env fallback",
                        restaurant_id, provider, phone_number_id,
                        str(access_token)[:12],
                    )
                    continue
                creds = {
                    "api_endpoint": (
                        integration.get("api_endpoint")
                        or os.getenv("BOTBIZ_API_ENDPOINT")
                        or "https://graph.facebook.com/v22.0"
                    ).rstrip("/"),
                    "phone_number_id": phone_number_id,
                    "access_token": access_token,
                    "provider": provider,
                }
                _integration_cache[restaurant_id] = (creds, now)
                return creds

    creds = _env_whatsapp_fallback(restaurant_id)
    _integration_cache[restaurant_id] = (creds, now)
    return creds


def _env_whatsapp_fallback(label: str) -> dict[str, str] | None:
    token = (
        (os.getenv("META_GRAPH_API_TOKEN") or "").strip()
        or (os.getenv("BOTBIZ_ACCESS_TOKEN") or "").strip()
    )
    phone_id = (
        (os.getenv("WABA_PHONE_NUMBER_ID") or "").strip()
        or (os.getenv("BOTBIZ_PHONE_NUMBER_ID") or "").strip()
    )
    if token and phone_id:
        logger.warning(
            "[restaurant_config] using global env WhatsApp creds for %s — "
            "add restaurant_integrations row",
            label,
        )
        return {
            "api_endpoint": (
                os.getenv("BOTBIZ_API_ENDPOINT") or "https://graph.facebook.com/v22.0"
            ).rstrip("/"),
            "phone_number_id": phone_id,
            "access_token": token,
            "provider": "env",
        }
    return None
