"""Notify the Node API when a tenant receives its first inbound WhatsApp message.

Keeps referral credit logic in ONE place (Node src/helpers/referrals.js).
Idempotent on the API side (first_message_at only stamps when null).
"""

from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger(__name__)

_AUTOM8_BACKEND_URL = (os.getenv("AUTOM8_BACKEND_URL") or "https://api.autom8.works").rstrip("/")
_KDS_DEV_FALLBACK = "munafe_kds_sync_2026"

# main.py calls this on EVERY inbound message (it has no cheap local signal for
# "already stamped" — services_enabled-style columns aren't ORM-mapped until a
# migration is confirmed live). Skip the network round-trip once we've seen a
# restaurant get a definitive answer, so long-lived tenants don't pay an extra
# HTTP hop to Node on every single customer message forever.
_ALREADY_STAMPED: set[str] = set()


def _internal_secret() -> str:
    secret = (os.getenv("AUTOM8_KDS_SECRET") or "").strip()
    if secret:
        return secret
    env = (os.getenv("NODE_ENV") or os.getenv("RAILWAY_ENVIRONMENT") or "").lower()
    if env == "production":
        logger.error("[referrals] AUTOM8_KDS_SECRET is not set — cannot stamp first_message_at")
        return ""
    logger.warning("[referrals] AUTOM8_KDS_SECRET not set — using dev fallback")
    return _KDS_DEV_FALLBACK


async def notify_first_inbound_message(restaurant_id: str) -> None:
    """Fire-and-forget safe: logs errors, never raises to the webhook path.

    Callers should invoke this via asyncio.create_task (not awaited inline) —
    it must never add latency to the customer-facing reply path.
    """
    if not restaurant_id:
        return

    rid = str(restaurant_id)
    if rid in _ALREADY_STAMPED:
        return

    secret = _internal_secret()
    if not secret:
        return

    url = f"{_AUTOM8_BACKEND_URL}/api/admin/internal/first-message"
    headers = {
        "Authorization": f"Bearer {secret}",
        "x-internal-secret": secret,
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.post(
                url,
                headers=headers,
                json={"restaurant_id": rid},
            )
        if resp.status_code >= 400:
            logger.error(
                "[referrals] first-message notify failed status=%s body=%s",
                resp.status_code,
                (resp.text or "")[:300],
            )
            return

        data = resp.json() if resp.content else {}
        # Any successful response — stamped now or already stamped earlier —
        # means this tenant is resolved for good; stop calling out for it.
        _ALREADY_STAMPED.add(rid)
        if data.get("stamped"):
            logger.info(
                "[referrals] first_message_at stamped for %s credit=%s",
                restaurant_id,
                data.get("creditResult") or data.get("credit_result"),
            )
    except Exception as exc:
        logger.error("[referrals] first-message notify error: %s", exc)
