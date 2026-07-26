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


def _phone_variants(phone: str) -> list[str]:
    digits = "".join(c for c in str(phone or "") if c.isdigit())
    if not digits:
        return []
    variants = {digits}
    if len(digits) == 10:
        variants.add(f"91{digits}")
    if len(digits) > 10:
        variants.add(digits[-10:])
    if digits.startswith("91") and len(digits) == 12:
        variants.add(digits[2:])
    return list(variants)


async def has_open_feedback_invite(customer_phone: str, restaurant_id: str) -> bool:
    """True when Node has sent a feedback invite awaiting a reply.

    Cheap PostgREST read (indexed) — use this to skip the sync Node HTTP hop
    on the vast majority of turns where no invite is open.
    """
    variants = _phone_variants(customer_phone)
    if not variants or not restaurant_id:
        return False

    base = os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
    key = os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
    if not (base and key):
        # Can't probe — fall through to Node hop rather than drop a reply.
        return True

    try:
        # PostgREST `in.(a,b)` — one round-trip for all phone variants.
        in_list = ",".join(variants)
        resp = await get_http().get(
            f"{base}/rest/v1/feedback_pending",
            params={
                "select": "id,feedback_sent_at",
                "restaurant_id": f"eq.{restaurant_id}",
                "customer_phone": f"in.({in_list})",
                "feedback_sent": "eq.true",
                "manager_notified": "eq.false",
                "order": "freed_at.desc",
                "limit": "1",
            },
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
            },
            timeout=aiohttp.ClientTimeout(total=2),
        )
        if resp.status != 200:
            return False
        rows = await resp.json()
        if not rows:
            return False
        from tools.feedback_intent import is_db_feedback_invite_active
        return is_db_feedback_invite_active(rows[0].get("feedback_sent_at"))
    except Exception as e:
        logger.debug(f"[feedback-bridge] has_open_feedback_invite failed: {e}")
        # Fail open → still try Node hop so real feedback replies are not dropped.
        return True


async def try_handle_feedback_via_api(
    customer_phone: str,
    message_obj: dict[str, Any],
    restaurant_id: str,
    *,
    already_checked: bool = False,
) -> dict[str, bool]:
    """
    Delegate to Node handleFeedbackReply. Returns consumed/completed flags.

    already_checked=True when Node webhook already ran handleFeedbackReply
    for this message (skip duplicate hop).
    """
    result = {"consumed": False, "completed": False}
    if already_checked:
        return result
    if not KDS_SECRET:
        logger.debug("[feedback-bridge] AUTOM8_KDS_SECRET unset — skip API delegate")
        return result

    phone = "".join(c for c in str(customer_phone) if c.isdigit())
    if not phone or not restaurant_id or not message_obj:
        return result

    # Most turns have no open invite — avoid the 12s Node HTTP wait.
    if not await has_open_feedback_invite(phone, restaurant_id):
        logger.debug("[feedback-bridge] no open invite — skip Node hop")
        return result

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
            return result
        data = await resp.json()
        result["consumed"] = bool(data.get("consumed"))
        result["completed"] = bool(data.get("completed"))
        if result["consumed"]:
            logger.info(
                f"[feedback-bridge] Feedback consumed for {phone} "
                f"(completed={result['completed']})"
            )
        return result
    except Exception as e:
        logger.warning(f"[feedback-bridge] handle-reply failed (non-fatal): {e}")
        return result


async def try_dismiss_feedback_via_api(
    customer_phone: str,
    restaurant_id: str,
) -> bool:
    """Dismiss stale Node feedback invite (Home/Menu reset)."""
    if not KDS_SECRET:
        return False

    phone = "".join(c for c in str(customer_phone) if c.isdigit())
    if not phone or not restaurant_id:
        return False

    try:
        resp = await get_http().post(
            f"{_API_BASE}/api/feedback/dismiss",
            json={
                "customer_phone": phone,
                "restaurant_id": restaurant_id,
            },
            headers={
                "Authorization": f"Bearer {KDS_SECRET}",
                "Content-Type": "application/json",
            },
            timeout=aiohttp.ClientTimeout(total=8),
        )
        return resp.status == 200
    except Exception as e:
        logger.debug(f"[feedback-bridge] dismiss failed (non-fatal): {e}")
        return False
