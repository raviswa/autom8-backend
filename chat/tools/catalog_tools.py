"""
catalog_tools.py
─────────────────────────────────────────────────────────────────────────────
Two responsibilities:
  1. sync_catalog_to_facebook()   — push all menu items from the
     Google Sheet / local data to Facebook Catalog via Graph API.
     Call this on a daily schedule (e.g. cron / APScheduler).

  2. send_whatsapp_catalog_message() — send a WhatsApp interactive
     "multi-product" or "product" message so the customer can browse
     items with photos, prices and an Add-to-basket button entirely
     inside WhatsApp.

Environment variables required (add to your .env):
  META_GRAPH_API_TOKEN   — long-lived System User token with
                           catalog_management + whatsapp_business_messaging
                           (used as fallback if restaurant integration not found)
  META_CATALOG_ID        — 974962481719952
  WABA_PHONE_NUMBER_ID   — 10866188812090069
  META_GRAPH_VERSION     — v20.0  (or latest stable)
  AUTOM8_BACKEND_URL     — https://autom8-backend-production.up.railway.app
  AUTOM8_KDS_SECRET      — munafe_kds_sync_2026
  PORTAL_RESTAURANT_ID   — 46fb9b9e-431a-43c9-9edb-d316b0fef216

FIX: Modified send_whatsapp_catalog_message() to use per-restaurant
WhatsApp credentials (from db_tools.get_restaurant_integration) instead
of only global environment variables. This ensures the catalog message
is sent using the correct WhatsApp Business Account for each restaurant.

FIX LOG
-------
  Fix (menu source):
    - Static MENU_ITEMS list replaced with live fetch from autom8 backend.
    - New /api/internal/menu-items endpoint on server.js serves the data.
    - 60-second in-process cache prevents hammering the API on every message.
    - Stale cache is returned on network failure so the bot never crashes.
    - MENU_ITEMS alias kept so all existing imports work without changes.

  Fix (out-of-stock items):
    - schedule_daily_catalog_sync() previously only registered a cron job at
      05:55 AM. On a fresh deploy or restart the catalog was never pushed,
      so Facebook defaulted every item to "out of stock".
    - Fix: an additional "date" (run-once-immediately) job is now registered
      alongside the daily cron, triggering sync within seconds of app startup.
    - Empty-items guard log level upgraded from WARNING to ERROR so Railway
      surfaces it clearly when the backend fetch is the root cause.

  Fix (dynamic restaurant label in footer):
    - Footer previously hardcoded "Hotel Munafe, Chennai".
    - New _get_restaurant_label() fetches restaurant name from DB via
      get_restaurant_by_id() using the restaurant_id already in scope.
    - Falls back to "Hotel Munafe" if DB lookup fails or restaurant_id is None.
    - Footer now reads: "Prices excl. GST • <restaurant name from DB>"
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

import aiohttp
import httpx

logger = logging.getLogger(__name__)

# ── Config (read from environment) ────────────────────────────────────────────

_TOKEN      = os.getenv("META_GRAPH_API_TOKEN", "")
_CATALOG_ID = os.getenv("META_CATALOG_ID", "974962481719952")
_PHONE_ID   = os.getenv("WABA_PHONE_NUMBER_ID", "10866188812090069")
_API_VER    = os.getenv("META_GRAPH_VERSION", "v20.0")
_BASE_URL   = f"https://graph.facebook.com/{_API_VER}"

# ── Live menu cache config ─────────────────────────────────────────────────────

_AUTOM8_BACKEND_URL   = os.getenv("AUTOM8_BACKEND_URL", "https://api.autom8.works").rstrip("/")
_AUTOM8_KDS_SECRET    = os.getenv("AUTOM8_KDS_SECRET", "")
_PORTAL_RESTAURANT_ID = os.getenv("PORTAL_RESTAURANT_ID", "46fb9b9e-431a-43c9-9edb-d316b0fef216")

_MENU_CACHE: dict[str, dict] = {}  # restaurant_id -> {items, fetched_at}
_MENU_CACHE_TTL = 60  # seconds — refresh every minute so availability changes propagate


def invalidate_menu_cache(restaurant_id: str | None = None) -> None:
    """Drop cached menu so the next fetch loads live data from the API."""
    if restaurant_id:
        _MENU_CACHE.pop(restaurant_id, None)
    else:
        _MENU_CACHE.clear()


# ── Live menu fetch ────────────────────────────────────────────────────────────

async def _fetch_menu_items_from_backend(restaurant_id: str | None = None) -> list[dict]:
    """
    Fetch all menu items from the autom8 backend (restaurant DB).
    Uses a 60-second in-process cache so we don't hammer the API.
    Returns the cached list on network failure so the bot never crashes.

    Items are returned in the same shape as the old static MENU_ITEMS list
    so all callers (cart_tools, booking_agent etc.) work without changes:
      {"id": retailer_id, "title": name, "price": price_paise,
       "category": category, "description": ..., "image_link": ...}
    """
    now = time.monotonic()
    rid = restaurant_id or _PORTAL_RESTAURANT_ID
    bucket = _MENU_CACHE.get(rid, {})
    if bucket.get("items") and (now - bucket.get("fetched_at", 0.0)) < _MENU_CACHE_TTL:
        MENU_ITEMS.clear()
        MENU_ITEMS.extend(bucket["items"])
        return bucket["items"]

    url = f"{_AUTOM8_BACKEND_URL}/api/internal/menu-items"
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.get(
                url,
                headers={"x-internal-secret": _AUTOM8_KDS_SECRET},
                params={"restaurant_id": rid},
                timeout=aiohttp.ClientTimeout(total=5),
            )
            if resp.status == 200:
                data = await resp.json()
                raw_items = data.get("items", [])
                mapped = []
                for item in raw_items:
                    # price in DB is rupees (e.g. 60.0); bot expects paise (e.g. 6000)
                    price_paise = int(float(item.get("price", 0)) * 100)
                    mapped.append({
                        "id":           item.get("retailer_id") or item.get("id", ""),
                        "title":        item.get("name", ""),
                        "price":        price_paise,
                        "category":     (item.get("category") or "General").strip(),
                        "description":  item.get("description", ""),
                        "image_link":   item.get("image_url", ""),
                        "is_available": bool(item.get("is_available", True)),
                    })
                _MENU_CACHE[rid] = {"items": mapped, "fetched_at": now}
                MENU_ITEMS.clear()
                MENU_ITEMS.extend(mapped)
                logger.info(
                    f"[menu-cache] Refreshed — {len(mapped)} items for {rid}"
                )
                return mapped
            else:
                text = await resp.text()
                logger.warning(
                    f"[menu-cache] Backend returned {resp.status}: {text[:200]}"
                    " — using stale cache"
                )
    except Exception as e:
        logger.warning(f"[menu-cache] Fetch failed (non-fatal): {e} — using stale cache")

    return _MENU_CACHE.get(rid, {}).get("items") or []  # stale or empty — never crashes


async def fetch_menu_items(restaurant_id: str | None = None) -> list[dict]:
    """
    Public async entry point. Call this in all async contexts (send_category_list,
    handle_incoming_message, etc.) to keep the cache warm.
    Returns the full menu item list.
    """
    return await _fetch_menu_items_from_backend(restaurant_id)


# Public alias — keeps all existing `from tools.catalog_tools import MENU_ITEMS`
# imports working. This is the same list object that _fetch_menu_items_from_backend()
# mutates in-place via .clear() + .extend(), so importers always see fresh data
# after the next cache refresh without needing to re-import.
MENU_ITEMS: list[dict] = []


def items_for_category(category: str | None = None) -> list[dict]:
    """Return menu items for a category from the current cache."""
    available = [i for i in MENU_ITEMS if i.get("is_available", True)]
    if not category:
        return available
    return [i for i in available if i.get("category", "General") == category]


# ── 1. Facebook Catalog sync ───────────────────────────────────────────────────

async def sync_catalog_to_facebook() -> dict[str, Any]:
    """
    Push / update all MENU_ITEMS to Facebook Catalog via Batch Products API.
    Call daily via APScheduler or cron.

    Returns a summary dict: {"uploaded": N, "errors": [...]}
    """
    if not _TOKEN:
        raise EnvironmentError("META_GRAPH_API_TOKEN is not set in environment.")

    # Ensure cache is warm before syncing
    items = await fetch_menu_items()
    if not items:
        # Upgraded from WARNING to ERROR — surface clearly in Railway logs when
        # the backend fetch is the root cause of items showing as out of stock.
        logger.error(
            "[catalog-sync] MENU_ITEMS is empty — skipping Facebook sync. "
            "Check AUTOM8_BACKEND_URL, AUTOM8_KDS_SECRET, and PORTAL_RESTAURANT_ID."
        )
        return {"uploaded": 0, "errors": ["No items to sync"]}

    batch_url = f"{_BASE_URL}/{_CATALOG_ID}/batch"
    requests_payload = []

    for item in items:
        requests_payload.append({
            "method": "UPDATE",
            "retailer_id": item["id"],
            "data": {
                "name":         item["title"],
                "description":  item["description"],
                "price":        item["price"],          # paise (INR x 100)
                "currency":     "INR",
                "availability": "in stock",
                "image_url":    item["image_link"],
                "brand":        "Hotel Munafe",
                "category":     "FOOD_AND_DRINK",
                "url":          "https://autom8.works/",
            },
        })

    headers = {"Authorization": f"Bearer {_TOKEN}"}
    results: dict[str, Any] = {"uploaded": 0, "errors": []}

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            batch_url,
            headers=headers,
            json={"allow_upsert": True, "requests": requests_payload},
        )
        data = resp.json()

        if resp.status_code == 200:
            results["uploaded"] = len(items)
            logger.info(f"Catalog sync complete: {len(items)} items uploaded.")
        else:
            results["errors"].append(data)
            logger.error(f"Catalog sync failed: {data}")

    return results


# ── 2. WhatsApp interactive catalog message ────────────────────────────────────

async def _get_catalog_credentials(restaurant_id: str | None = None) -> dict[str, str] | None:
    """
    Resolve WhatsApp credentials for catalog messages.

    Priority:
    1. Per-restaurant integration from database (botbiz WhatsApp integration)
    2. Global environment variables (fallback for local demos / single-tenant)

    Returns dict with 'api_endpoint', 'phone_number_id', 'access_token' or None.
    """
    # Try per-restaurant integration first
    if restaurant_id:
        try:
            from tools.db_tools import get_restaurant_integration
            integration = await get_restaurant_integration(
                restaurant_id=restaurant_id,
                provider="botbiz",
                channel="whatsapp",
            )
            if integration:
                api_endpoint    = integration.get("api_endpoint")
                phone_number_id = integration.get("phone_number_id")
                access_token    = integration.get("access_token")
                if phone_number_id and access_token:
                    return {
                        "api_endpoint":    (api_endpoint or "https://graph.facebook.com/v22.0").rstrip("/"),
                        "phone_number_id": phone_number_id,
                        "access_token":    access_token,
                    }
                logger.warning(
                    f"Restaurant {restaurant_id} has WhatsApp integration but "
                    "missing phone_number_id or access_token"
                )
        except Exception as e:
            logger.warning(f"Failed to get restaurant integration for {restaurant_id}: {e}")

    # Fallback to global environment variables
    from config.settings import settings
    if (
        settings.botbiz_phone_number_id != "your_phone_number_id_here"
        and settings.botbiz_access_token != "your_access_token_here"
    ):
        logger.warning(
            f"Using global BotBiz env credentials for catalog message "
            f"(restaurant_id={restaurant_id})"
        )
        return {
            "api_endpoint":    settings.botbiz_api_endpoint.rstrip("/"),
            "phone_number_id": settings.botbiz_phone_number_id,
            "access_token":    settings.botbiz_access_token,
        }

    # Last resort: use module-level env vars (for backward compatibility)
    if _TOKEN and _PHONE_ID and _PHONE_ID != "your_phone_number_id_here":
        logger.warning(
            f"Using module-level env vars for catalog message "
            f"(restaurant_id={restaurant_id})"
        )
        return {
            "api_endpoint":    _BASE_URL,
            "phone_number_id": _PHONE_ID,
            "access_token":    _TOKEN,
        }

    logger.error(
        f"No WhatsApp credentials available for catalog message "
        f"(restaurant_id={restaurant_id})"
    )
    return None


async def _get_restaurant_label(restaurant_id: str | None) -> str:
    """
    Fetch restaurant name from DB for use in the catalog footer.
    Falls back to 'Hotel Munafe' if restaurant_id is None or DB lookup fails.
    """
    if not restaurant_id:
        return "Hotel Munafe"
    try:
        from tools.db_tools import get_restaurant_by_id
        r = await get_restaurant_by_id(restaurant_id)
        if r and r.get("name"):
            return r["name"]
    except Exception as e:
        logger.warning(f"[catalog] Could not fetch restaurant label: {e}")
    return "Hotel Munafe"


async def send_whatsapp_catalog_message(
    customer_phone: str,
    restaurant_id: str | None = None,
) -> bool:
    """
    Send an interactive multi-product WhatsApp catalog message showing all
    available menu items in a single "Today's Menu" section.

    Returns True on success, False on failure.
    """
    # Resolve credentials (per-restaurant or fallback to global)
    credentials = await _get_catalog_credentials(restaurant_id)
    if not credentials:
        logger.error(
            f"Cannot send catalog message: no credentials for restaurant {restaurant_id}"
        )
        return False

    if not credentials.get("access_token"):
        if not _TOKEN:
            raise EnvironmentError(
                "META_GRAPH_API_TOKEN is not set in environment and "
                "no restaurant integration found."
            )
        logger.warning("Using global META_GRAPH_API_TOKEN for catalog access")

    # Fetch restaurant name for footer
    restaurant_label = await _get_restaurant_label(restaurant_id)

    items = await fetch_menu_items(restaurant_id)
    items = [i for i in items if i.get("is_available", True)]

    if not items:
        logger.error(
            f"[catalog] No available menu items for {customer_phone} — "
            "check manager availability toggles and /api/internal/menu-items."
        )
        return False

    product_items   = [{"product_retailer_id": i["id"]} for i in items]
    thumbnail_id    = items[0]["id"]
    access_token    = credentials.get("access_token") or _TOKEN
    phone_number_id = credentials.get("phone_number_id") or _PHONE_ID

    payload = {
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                customer_phone,
        "type":              "interactive",
        "interactive": {
            "type": "product_list",
            "header": {
                "type": "text",
                "text": f"🍽️ {restaurant_label} Menu",
            },
            "body": {
                "text": (
                    "Browse today's items below 👇\n"
                    "Tap any item to see details and add to your basket.\n"
                    "When done, send us your basket to place the order."
                ),
            },
            "footer": {"text": f"Prices excl. GST • {restaurant_label}"},
            "action": {
                "catalog_id": _CATALOG_ID,
                "sections": [
                    {
                        "title": "Today's Menu",
                        "product_items": product_items,
                    }
                ],
            },
        },
    }

    url     = f"{credentials['api_endpoint']}/{phone_number_id}/messages"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type":  "application/json",
    }

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, headers=headers, json=payload)
        data = resp.json()

    if resp.status_code == 200:
        logger.info(
            f"[catalog] Sent to {customer_phone} — {len(items)} items, "
            f"1 section 'Today's Menu' (restaurant={restaurant_id})"
        )
        return True
    else:
        logger.error(
            f"[catalog] Failed for {customer_phone}: "
            f"{resp.status_code} — {data}"
        )
        return False


# ── 3. Parse incoming WhatsApp cart (order from customer) ─────────────────────

def parse_whatsapp_order(webhook_message: dict[str, Any]) -> dict[str, Any] | None:
    """
    Parse an incoming WhatsApp 'order' message (customer sent their basket).

    Returns a normalised order dict or None if the message is not an order.
    """
    if webhook_message.get("type") != "order":
        return None

    order         = webhook_message.get("order", {})
    product_items = order.get("product_items", [])
    item_lookup: dict[str, dict] = {}
    for i in MENU_ITEMS:
        rid = (i.get("id") or "").strip()
        if not rid:
            continue
        item_lookup[rid] = i
        item_lookup[rid.upper()] = i
        item_lookup[rid.lower()] = i

    lines = []
    total = 0.0

    for pi in product_items:
        rid      = (pi.get("product_retailer_id") or "").strip()
        qty      = int(pi.get("quantity", 1))
        price    = float(pi.get("item_price", 0))
        subtotal = price * qty
        total   += subtotal
        matched  = item_lookup.get(rid) or item_lookup.get(rid.upper())
        title    = (matched or {}).get("title") or rid
        lines.append({
            "id":         rid,
            "title":      title,
            "qty":        qty,
            "unit_price": price,
            "subtotal":   subtotal,
        })

    order_text = "\n".join(
        f"{l['qty']}x {l['title']} (Rs.{l['unit_price']:.0f}) = Rs.{l['subtotal']:.0f}"
        for l in lines
    )
    order_text += f"\n────────────────────\nTotal: Rs.{total:.0f}"

    return {"items": lines, "total": total, "order_text": order_text}


# ── 4. Daily sync scheduler (call once at app startup) ────────────────────────

def schedule_daily_catalog_sync() -> None:
    """
    Register a daily catalog sync job using APScheduler.
    Call this once from your app startup (e.g. main.py or app.py).

    FIX (out-of-stock items): In addition to the 05:55 AM daily cron, a
    run-once "date" job is now registered to fire immediately on startup.
    Previously the catalog was never pushed on a fresh deploy or restart,
    causing Facebook to default every item to "out of stock" until 05:55 AM
    the following morning.

    Requires:  pip install apscheduler
    """
    try:
        from apscheduler.schedulers.asyncio import AsyncIOScheduler
    except ImportError:
        logger.warning(
            "apscheduler not installed — skipping daily catalog sync schedule."
        )
        return

    scheduler = AsyncIOScheduler()

    # Run every day at 5:55 AM IST so catalog is fresh before service opens
    scheduler.add_job(
        sync_catalog_to_facebook,
        trigger="cron",
        hour=5,
        minute=55,
        id="daily_catalog_sync",
        replace_existing=True,
    )

    # FIX: Also run once immediately on startup so the catalog is populated
    # straight after every deploy / restart, not just at 05:55 AM.
    scheduler.add_job(
        sync_catalog_to_facebook,
        trigger="date",          # run-once trigger fires as soon as scheduler starts
        id="startup_catalog_sync",
        replace_existing=True,
    )

    scheduler.start()
    logger.info(
        "Daily catalog sync scheduled at 05:55 AM. "
        "Startup sync triggered immediately."
    )
