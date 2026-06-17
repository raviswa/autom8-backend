"""
Bridge to Node.js feedback flow — feedback invites are sent and stored by the
Node API (feedback_pending). When Meta webhooks hit the Python chat service
directly, rating replies must be delegated to Node before booking routing.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import aiohttp

from tools.booking_mechanisms import KDS_SECRET, get_http

logger = logging.getLogger(__name__)

_API_BASE = os.getenv("AUTOM8_API_URL", "https://api.autom8.works").rstrip("/")


async def has_open_feedback_invite(customer_phone: str, restaurant_id: str) -> bool:
    """True when Node has sent a feedback invite awaiting a reply."""
    phone = "".join(c for c in str(customer_phone) if c.isdigit())
    if not phone or not restaurant_id:
        return False

    base = os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
    key = os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
    if not (base and key):
        return False

    try:
        resp = await get_http().get(
            f"{base}/rest/v1/feedback_pending",
            params={
                "select": "id",
                "restaurant_id": f"eq.{restaurant_id}",
                "customer_phone": f"eq.{phone}",
                "feedback_sent": "eq.true",
                "manager_notified": "eq.false",
                "order": "freed_at.desc",
                "limit": "1",
            },
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
            },
            timeout=aiohttp.ClientTimeout(total=5),
        )
        if resp.status != 200:
            return False
        rows = await resp.json()
        return bool(rows)
    except Exception as e:
        logger.debug(f"[feedback-bridge] has_open_feedback_invite failed: {e}")
        return False


async def try_handle_feedback_via_api(
    customer_phone: str,
    message_obj: dict[str, Any],
    restaurant_id: str,
) -> bool:
    """
    Delegate to Node handleFeedbackReply. Returns True if the message was
    consumed as part of the feedback flow (no booking routing needed).
    """
    if not KDS_SECRET:
        logger.debug("[feedback-bridge] AUTOM8_KDS_SECRET unset — skip API delegate")
        return False

    phone = "".join(c for c in str(customer_phone) if c.isdigit())
    if not phone or not restaurant_id or not message_obj:
        return False

    try:
        resp = await get_http().post(
            f"{_API_BASE}/api/feedback/handle-reply",
            json={
                "customer_phone": phone,
                "restaurant_id": restaurant_id,
                "message": message_obj,
            },
            headers={
                "Authorization": f"Bearer {KDS_SECRET}",
                "Content-Type": "application/json",
            },
            timeout=aiohttp.ClientTimeout(total=12),
        )
        if resp.status != 200:
            logger.warning(
                f"[feedback-bridge] handle-reply HTTP {resp.status}: "
                f"{(await resp.text())[:200]}"
            )
            return False
        data = await resp.json()
        consumed = bool(data.get("consumed"))
        if consumed:
            logger.info(f"[feedback-bridge] Feedback consumed for {phone}")
        return consumed
    except Exception as e:
        logger.warning(f"[feedback-bridge] handle-reply failed (non-fatal): {e}")
        return False
