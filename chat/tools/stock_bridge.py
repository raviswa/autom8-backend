"""Call Node inventory endpoints for REPEAT validate + post-pay deduct."""

from __future__ import annotations

import logging
import os
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)

_AUTOM8_BACKEND_URL = (os.getenv("AUTOM8_BACKEND_URL") or "https://api.autom8.works").rstrip("/")


def _internal_secret() -> str:
    return (os.getenv("AUTOM8_KDS_SECRET") or "autom8-checkout-dev").strip()


async def validate_and_price_cart(
    restaurant_id: str,
    lines: list[dict[str, Any]],
) -> dict[str, Any]:
    """
    Live stock check + reprice via POST /api/internal/validate-cart.
    Returns { ok, lines, total, shortages, error? }.
    """
    url = f"{_AUTOM8_BACKEND_URL}/api/internal/validate-cart"
    payload = {
        "restaurant_id": restaurant_id,
        "lines": [
            {
                "id": line.get("id") or line.get("menu_item_id"),
                "menu_item_id": line.get("menu_item_id") or line.get("id"),
                "qty": int(line.get("qty") or 0),
                "name": line.get("name") or line.get("title"),
            }
            for line in lines
            if int(line.get("qty") or 0) > 0
        ],
    }
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                url,
                json=payload,
                headers={"x-internal-secret": _internal_secret()},
                timeout=aiohttp.ClientTimeout(total=12),
            )
            data = await resp.json(content_type=None)
            if resp.status == 200 and data.get("ok"):
                return {
                    "ok": True,
                    "lines": data.get("lines") or [],
                    "total": float(data.get("total") or 0),
                    "shortages": [],
                }
            return {
                "ok": False,
                "lines": data.get("lines") or [],
                "total": float(data.get("total") or 0),
                "shortages": data.get("shortages") or [],
                "error": data.get("error") or data.get("message"),
            }
    except Exception as exc:
        logger.warning("[stock-bridge] validate-cart failed: %s", exc)
        return {"ok": False, "lines": [], "total": 0, "shortages": [], "error": str(exc)}


async def deduct_stock_for_cart(
    restaurant_id: str,
    lines: list[dict[str, Any]],
    *,
    booking_id: str | None = None,
) -> dict[str, Any]:
    """
    Deduct after payment success via POST /api/internal/deduct-stock.
    Idempotent when booking_id is provided (meta.stock_deducted_at).
    """
    url = f"{_AUTOM8_BACKEND_URL}/api/internal/deduct-stock"
    payload = {
        "restaurant_id": restaurant_id,
        "booking_id": booking_id,
        "lines": [
            {
                "id": line.get("id") or line.get("menu_item_id"),
                "menu_item_id": line.get("menu_item_id") or line.get("id"),
                "qty": int(line.get("qty") or 0),
                "name": line.get("name") or line.get("title"),
            }
            for line in lines
            if int(line.get("qty") or 0) > 0
        ],
    }
    if not payload["lines"]:
        return {"ok": True, "skipped": True, "reason": "no_lines"}
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.post(
                url,
                json=payload,
                headers={"x-internal-secret": _internal_secret()},
                timeout=aiohttp.ClientTimeout(total=15),
            )
            data = await resp.json(content_type=None)
            if resp.status in (200, 201) and data.get("ok"):
                return data
            logger.error(
                "[stock-bridge] deduct-stock failed status=%s data=%s booking=%s",
                resp.status,
                data,
                booking_id,
            )
            return {
                "ok": False,
                "shortages": data.get("shortages") or [],
                "error": data.get("error") or f"HTTP {resp.status}",
            }
    except Exception as exc:
        logger.error("[stock-bridge] deduct-stock exception booking=%s: %s", booking_id, exc)
        return {"ok": False, "shortages": [], "error": str(exc)}
