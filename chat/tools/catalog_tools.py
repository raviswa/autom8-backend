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
  Bug — current_time_slot() used datetime.now() without timezone, returning
        UTC time (or server local time) instead of IST. At 10:15 PM IST the
        function was returning UTC 16:45, which matched "Evening Snacks" or
        fell through to "Morning Tiffin" depending on the gaps in the original
        boundaries.

  Two additional problems in the original function:
    - Slot boundaries had gaps: 11:00 was not covered (fell to default),
      15:00 was not covered, elif 12 <= missed the 11:00-12:00 hour entirely.
    - A second copy of current_time_slot() was appended inside the body of
      schedule_daily_catalog_sync(), making it a nested (unreachable) function
      that never replaced the module-level definition.

  Fix:
    - Single module-level current_time_slot() using ZoneInfo("Asia/Kolkata").
    - Gap-free contiguous slot boundaries: 6-11, 11-15, 15-19, 19-23.
    - Duplicate/nested copy removed entirely.
    - ZoneInfo import moved to top-level imports.

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

  Fix (time-slot standardisation — all flows):
    - send_whatsapp_catalog_message() was filtering items by current_time_slot()
      and using the slot name ("Morning Tiffin", "Lunch" etc.) as the catalog
      section header and WhatsApp message header. With all 28 items currently
      tagged "Morning Tiffin" in the DB, this caused:
        (a) The catalog header to always read "Munafe Menu — Morning Tiffin"
            regardless of time of day or service type.
        (b) items_for_slot() returning 0 results outside morning hours,
            silently failing the catalog send and triggering the fallback loop.
    - Fix: time-slot filtering removed from send_whatsapp_catalog_message().
      ALL items are shown in a single section titled "Today's Menu".
      current_time_slot() and items_for_slot() are no longer called here.
      This standardises the catalog across dine-in, takeaway, and delivery.
    - current_time_slot() and items_for_slot() are kept in the module for
      use by other callers (cart_tools, scheduling logic etc.).

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
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

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

_MENU_CACHE: dict = {"items": [], "fetched_at": 0.0}
_MENU_CACHE_TTL = 60  # seconds — refresh every minute so slot changes propagate

# Mapping from DB time_slot values to the display labels used throughout the bot
_SLOT_DB_TO_LABEL: dict[str, str] = {
    "morning_tiffin": "Morning Tiffin",
    "lunch":          "Lunch",
    "evening_snacks": "Evening Snacks",
    "dinner_tiffin":  "Dinner Tiffin",
}


# ── Live menu fetch ────────────────────────────────────────────────────────────

async def _fetch_menu_items_from_backend() -> list[dict]:
    """
    Fetch all menu items from the autom8 backend (restaurant DB).
    Uses a 60-second in-process cache so we don't hammer the API.
    Returns the cached list on network failure so the bot never crashes.

    Items are returned in the same shape as the old static MENU_ITEMS list
    so all callers (cart_tools, booking_agent etc.) work without changes:
      {"id": retailer_id, "title": name, "price": price_paise,
       "time_slot": slot_label, "description": ..., "image_link": ...}
    """
    now = time.monotonic()
    if _MENU_CACHE["items"] and (now - _MENU_CACHE["fetched_at"]) < _MENU_CACHE_TTL:
        return _MENU_CACHE["items"]

    url = f"{_AUTOM8_BACKEND_URL}/api/internal/menu-items"
    try:
        async with aiohttp.ClientSession() as http:
            resp = await http.get(
                url,
                headers={"x-internal-secret": _AUTOM8_KDS_SECRET},
                params={"restaurant_id": _PORTAL_RESTAURANT_ID},
                timeout=aiohttp.ClientTimeout(total=5),
            )
            if resp.status == 200:
                data = await resp.json()
                raw_items = data.get("items", [])
                mapped = []
                for item in raw_items:
                    slot_db    = item.get("time_slot", "")
                    slot_label = _SLOT_DB_TO_LABEL.get(slot_db, "Morning Tiffin")
                    # price in DB is rupees (e.g. 60.0); bot expects paise (e.g. 6000)
                    price_paise = int(float(item.get("price", 0)) * 100)
                    mapped.append({
                        "id":          item.get("retailer_id") or item.get("id", ""),
                        "title":       item.get("name", ""),
                        "price":       price_paise,
                        "time_slot":   slot_label,
                        "description": item.get("description", ""),
                        "image_link":  item.get("image_url", ""),
                    })
                _MENU_CACHE["items"]      = mapped
                _MENU_CACHE["fetched_at"] = now
                # Keep the module-level MENU_ITEMS alias in sync
                MENU_ITEMS.clear()
                MENU_ITEMS.extend(mapped)
                logger.info(f"[menu-cache] Refreshed — {len(mapped)} items loaded from backend")
                return mapped
            else:
                text = await resp.text()
                logger.warning(
                    f"[menu-cache] Backend returned {resp.status}: {text[:200]}"
                    " — using stale cache"
                )
    except Exception as e:
        logger.warning(f"[menu-cache] Fetch failed (non-fatal): {e} — using stale cache")

    return _MENU_CACHE["items"]  # stale or empty — never crashes the bot


async def fetch_menu_items() -> list[dict]:
    """
    Public async entry point. Call this in all async contexts (send_category_list,
    handle_incoming_message, etc.) to keep the cache warm.
    Returns the full menu item list.
    """
    return await _fetch_menu_items_from_backend()


# Public alias — keeps all existing `from tools.catalog_tools import MENU_ITEMS`
# imports working. This is the same list object that _fetch_menu_items_from_backend()
# mutates in-place via .clear() + .extend(), so importers always see fresh data
# after the next cache refresh without needing to re-import.
MENU_ITEMS: list[dict] = _MENU_CACHE["items"]


# ── Time-slot helpers ──────────────────────────────────────────────────────────

def current_time_slot() -> str:
    """
    Return the active menu slot based on current Indian Standard Time (IST).

    Slot windows (IST) — contiguous, no gaps:
      06:00 - 10:59  ->  Morning Tiffin
      11:00 - 14:59  ->  Lunch
      15:00 - 18:59  ->  Evening Snacks
      19:00 - 22:59  ->  Dinner Tiffin
      23:00 - 05:59  ->  Morning Tiffin  (off-hours default)

    Adjust the hour boundaries below to match your actual kitchen schedule.

    NOTE: Uses ZoneInfo("Asia/Kolkata") — always correct IST regardless of
    where the server is hosted (UTC, US, EU etc.).

    NOTE: send_whatsapp_catalog_message() no longer calls this function.
    It is kept here for use by other callers (cart_tools, scheduling etc.)
    and for when time-slot segregation is restored in the MENU_ITEMS table.
    """
    ist_now = datetime.now(ZoneInfo("Asia/Kolkata"))
    hour    = ist_now.hour  # 0-23 in IST

    if 6 <= hour < 11:
        return "Morning Tiffin"
    elif 11 <= hour < 15:
        return "Lunch"
    elif 15 <= hour < 19:
        return "Evening Snacks"
    elif 19 <= hour < 23:
        return "Dinner Tiffin"
    else:
        # 23:00-05:59 — kitchen closed, default to next morning's slot
        return "Morning Tiffin"


def items_for_slot(slot: str | None = None) -> list[dict]:
    """
    Return menu items for a given time slot from the current cache.
    Synchronous — safe to call anywhere. Cache is populated by the first
    await fetch_menu_items() call (which happens on every incoming message
    via send_category_list).

    NOTE: send_whatsapp_catalog_message() no longer calls this function.
    Kept for cart_tools and any other callers that need slot-filtered lists.
    """
    slot = slot or current_time_slot()
    return [i for i in MENU_ITEMS if i["time_slot"] == slot]


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
    Send an interactive multi-product WhatsApp catalog message showing ALL
    menu items in a single "Today's Menu" section.

    Time-slot standardisation fix:
      Previously this function called current_time_slot() to filter items
      and set section/header labels, producing "Munafe Menu — Morning Tiffin"
      on every flow at every hour (since all 28 items share the Morning Tiffin
      tag). This also caused items_for_slot() to return 0 items outside morning
      hours, silently failing the catalog send.

      Now: ALL items are shown, no time-slot filtering, neutral section title.
      The slot parameter is removed. current_time_slot() / items_for_slot()
      are not called here. Re-introduce slot filtering only when real time-slot
      segregation is restored in the MENU_ITEMS table.

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

    # Warm the cache — ALL items, no slot filter
    items = await fetch_menu_items()

    if not items:
        logger.error(
            f"[catalog] MENU_ITEMS is empty for {customer_phone} — "
            "cannot send catalog. Check backend /api/internal/menu-items."
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
                # Neutral header — no time-slot name, consistent across all flows
                "text": "🍽️ Munafe Menu",
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
                        # Neutral section title — no "Morning Tiffin" / slot name
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
    item_lookup   = {i["id"]: i for i in MENU_ITEMS}

    lines = []
    total = 0.0

    for pi in product_items:
        rid      = pi.get("product_retailer_id", "")
        qty      = int(pi.get("quantity", 1))
        price    = float(pi.get("item_price", 0))
        subtotal = price * qty
        total   += subtotal
        title    = item_lookup.get(rid, {}).get("title", rid)
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

    # Run every day at 5:55 AM IST so catalog is fresh before Morning Tiffin
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
