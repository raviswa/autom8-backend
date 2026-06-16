"""HTTP client for Munafe Supply B2B API (Node backend)."""

from __future__ import annotations

import logging
import os
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

_BACKEND = (os.getenv("AUTOM8_BACKEND_URL") or "http://localhost:3000").rstrip("/")
_SECRET = (os.getenv("AUTOM8_KDS_SECRET") or "").strip()


def _headers() -> dict[str, str]:
    return {"x-internal-secret": _SECRET, "Content-Type": "application/json"}


async def get_supplier_by_wa(phone_number_id: str) -> dict[str, Any] | None:
    if not _SECRET:
        logger.warning("[supply_api] AUTOM8_KDS_SECRET not set")
        return None
    url = f"{_BACKEND}/api/supply/internal/supplier-by-wa"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params={"phone_number_id": phone_number_id}, headers=_headers()) as resp:
                if resp.status == 404:
                    return None
                if resp.status != 200:
                    logger.error("[supply_api] supplier-by-wa %s", resp.status)
                    return None
                return await resp.json()
    except Exception as e:
        logger.error("[supply_api] supplier-by-wa failed: %s", e)
        return None


async def fetch_b2b_context(phone: str, supplier_id: str) -> dict[str, Any]:
    if not _SECRET:
        return {"is_known_client": False}
    url = f"{_BACKEND}/api/supply/internal/context"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(
                url,
                params={"phone": phone, "supplier_id": supplier_id},
                headers=_headers(),
            ) as resp:
                if resp.status != 200:
                    return {"is_known_client": False}
                return await resp.json()
    except Exception as e:
        logger.error("[supply_api] context failed: %s", e)
        return {"is_known_client": False}


async def log_payment_claim(
    client_id: str,
    claimed_amount: float | None,
    method: str | None,
    reference: str | None,
    raw_message: str,
) -> dict[str, Any] | None:
    url = f"{_BACKEND}/api/supply/internal/payment-claim"
    payload = {
        "client_id": client_id,
        "claimed_amount": claimed_amount,
        "method": method,
        "reference": reference,
        "raw_message": raw_message,
    }
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=_headers()) as resp:
                if resp.status != 200:
                    return None
                return await resp.json()
    except Exception as e:
        logger.error("[supply_api] payment-claim failed: %s", e)
        return None


async def send_supply_whatsapp(
    to_phone: str,
    body: str,
    phone_number_id: str,
    access_token: str,
) -> bool:
    if not phone_number_id or not access_token:
        logger.error("[supply_api] Missing WA credentials for supply message")
        return False
    url = f"https://graph.facebook.com/v22.0/{phone_number_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to_phone,
        "type": "text",
        "text": {"body": body},
    }
    headers = {"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers) as resp:
                if resp.status >= 400:
                    text = await resp.text()
                    logger.error("[supply_api] WA send failed %s: %s", resp.status, text[:200])
                    return False
                return True
    except Exception as e:
        logger.error("[supply_api] WA send error: %s", e)
        return False
