"""
tools/booking_mechanisms.py
─────────────────────────────────────────────────────────────────────────────
Unified booking mechanism with primary (WhatsApp Catalog) and fallback (Cart).

MERGED: original catalog/cart strategy + backend helpers extracted from
        agents/customer/booking_agent.py.

Strategy
────────
  PRIMARY  : send_whatsapp_catalog_message()
             Customer browses items with images/prices, native basket, sends order.

  FALLBACK : send_category_list() → send_item_list() → send_quantity_buttons()
             Interactive list/buttons when catalog is unavailable.

  BRIDGE   : bridge_catalog_order_to_cart() converts catalog 'order' messages
             into cart state (session_state["cart"]) for unified downstream
             processing.

Backend helpers (added)
───────────────────────
  • Shared aiohttp HTTP client (get_http)
  • Receipt helpers            (fetch_restaurant_info, receipt_qr_url,
                                upload_and_send_receipt)
  • Advance-payment helpers    (store_advance_on_booking, find_pending_reservation,
                                mark_advance_applied)   ← defined, not yet wired
  • Large-party helpers        (check_large_party_seating, format_combo_message)
  • Portal-sync helpers        (sync_token_to_portal, sync_token_to_portal_large_party,
                                lookup_table_assignment)
  • KDS notification           (notify_kds)

Configuration
─────────────
  BOOKING_MECHANISM_CONFIG = {
      "primary":          "catalog",
      "fallback":         "cart",
      "timeout_seconds":  30,
      "log_mechanism":    True,
  }
"""

from __future__ import annotations

import asyncio
import logging
import os as _os
from typing import Any, Literal

import aiohttp

from tools.catalog_tools import send_whatsapp_catalog_message, parse_whatsapp_order
from tools.cart_tools import send_category_list, plain_text_menu
from tools.whatsapp_tools import send_whatsapp_message
from tools.db_tools import get_available_tables

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# BOOKING MECHANISM CONFIG
# ─────────────────────────────────────────────

BOOKING_MECHANISM_CONFIG: dict[str, Any] = {
    "primary":         "catalog",   # WhatsApp Catalog (native shopping)
    "fallback":        "cart",      # Interactive cart (fallback)
    "timeout_seconds": 30,          # Fallback after timeout (future use)
    "log_mechanism":   True,        # Track mechanism usage
}

MechanismType = Literal["catalog", "cart", "cart_text", "none"]


# ─────────────────────────────────────────────
# PUBLIC CONSTANTS  (imported by flow modules)
# ─────────────────────────────────────────────

_AUTOM8_BACKEND_URL    = _os.getenv("AUTOM8_BACKEND_URL", "https://api.autom8.works").rstrip("/")
PORTAL_API_URL         = f"{_AUTOM8_BACKEND_URL}/api/tokens"
AUTOM8_KDS_URL         = f"{_AUTOM8_BACKEND_URL}/api/kds/notify"
KDS_SECRET             = _os.getenv("AUTOM8_KDS_SECRET", "")
_RECEIPT_REDIRECT_BASE = f"{_AUTOM8_BACKEND_URL}/r"


# ─────────────────────────────────────────────
# RECEIPT-GENERATOR  (optional import)
# ─────────────────────────────────────────────

try:
    from generate_receipt import generate_receipt as _generate_receipt
    from generate_receipt import ReceiptData as _ReceiptData
    from generate_receipt import LineItem as _LineItem
    RECEIPT_AVAILABLE = True
    print("[receipt] ✅ generate_receipt loaded", flush=True)
except ImportError as _e:
    RECEIPT_AVAILABLE = False
    _generate_receipt = _ReceiptData = _LineItem = None
    print(f"[receipt] ⚠️  generate_receipt not available: {_e}", flush=True)


# ─────────────────────────────────────────────
# SHARED HTTP CLIENT
# ─────────────────────────────────────────────

_http_client: aiohttp.ClientSession | None = None


def get_http() -> aiohttp.ClientSession:
    """Return the module-level shared aiohttp session (creates one if needed)."""
    global _http_client
    if _http_client is None or _http_client.closed:
        _http_client = aiohttp.ClientSession(
            connector=aiohttp.TCPConnector(limit=20),
            timeout=aiohttp.ClientTimeout(total=5),
        )
    return _http_client


# ─────────────────────────────────────────────
# RECEIPT HELPERS
# ─────────────────────────────────────────────

def receipt_qr_url(token_number: str) -> str:
    """Build the stable redirect URL embedded in the receipt QR code."""
    clean = token_number.lstrip("#").replace(" ", "-").replace("/", "-")
    return f"{_RECEIPT_REDIRECT_BASE}/{clean}"


async def fetch_restaurant_info(restaurant_id: str) -> dict:
    """
    Best-effort fetch of restaurant metadata for receipt generation.
    Returns an empty dict on any failure — receipt degrades gracefully.
    """
    try:
        base = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
        key  = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
        if not (base and key):
            return {}
        resp = await get_http().get(
            f"{base}/rest/v1/restaurants",
            params={
                "select": "name,whatsapp_number,address,phone,gstin,website",
                "id":     f"eq.{restaurant_id}",
                "limit":  "1",
            },
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=aiohttp.ClientTimeout(total=3),
        )
        if resp.status == 200:
            rows = await resp.json()
            return rows[0] if rows else {}
    except Exception as e:
        logger.debug(f"[receipt] restaurant info fetch failed (non-fatal): {e}")
    return {}


async def upload_and_send_receipt(
    receipt_path,
    customer_phone: str,
    restaurant_id: str,
    token_number: str,
) -> None:
    """Upload receipt PNG to Supabase Storage and send a 48-h signed URL to the customer."""
    try:
        import httpx as _httpx_r
        _sb_base = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
        _sb_key  = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
        if not (_sb_base and _sb_key):
            logger.warning("[receipt-upload] Supabase env vars not set — skipping")
            return

        _bucket   = "Receipts"
        _filename = receipt_path.name

        with open(receipt_path, "rb") as _f:
            _img_bytes = _f.read()

        async with _httpx_r.AsyncClient(timeout=15) as _rc:
            # Step 1: upload
            _up = await _rc.post(
                f"{_sb_base}/storage/v1/object/{_bucket}/{_filename}",
                content=_img_bytes,
                headers={
                    "apikey":        _sb_key,
                    "Authorization": f"Bearer {_sb_key}",
                    "Content-Type":  "image/png",
                    "x-upsert":      "true",
                },
            )
            if _up.status_code not in (200, 201):
                logger.warning(
                    f"[receipt-upload] Upload failed {_up.status_code}: {_up.text[:200]}"
                )
                return
            logger.info(f"[receipt-upload] ✅ Uploaded: {_filename}")

            # Step 2: 48-hour signed URL
            _sign = await _rc.post(
                f"{_sb_base}/storage/v1/object/sign/{_bucket}/{_filename}",
                json={"expiresIn": 172800},
                headers={
                    "apikey":        _sb_key,
                    "Authorization": f"Bearer {_sb_key}",
                    "Content-Type":  "application/json",
                },
            )
            if _sign.status_code != 200:
                logger.warning(
                    f"[receipt-upload] Signed URL failed {_sign.status_code}: {_sign.text[:200]}"
                )
                return
            logger.info("[receipt-upload] Signed URL generated (48 h)")

            # Step 3: send redirect URL to customer
            redirect_url = receipt_qr_url(token_number)
            await send_whatsapp_message(
                customer_phone,
                f"🧾 *Your Receipt — Token {token_number}*\n\n"
                f"{redirect_url}\n\n"
                f"⏰ _This link expires in 48 hours. Please save a copy if needed._",
                restaurant_id,
            )
    except Exception as e:
        logger.warning(f"[receipt-upload] Failed (non-fatal): {e}")


# ─────────────────────────────────────────────
# ADVANCE PAYMENT HELPERS
# NOTE: defined, not yet wired into dine_in_flow — future use for
#       auto-detecting customers with active reservation advances.
# ─────────────────────────────────────────────

async def store_advance_on_booking(booking_id: str, advance_amount: float) -> None:
    try:
        base = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
        key  = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
        if not (base and key):
            return
        resp = await get_http().patch(
            f"{base}/rest/v1/bookings",
            params={"id": f"eq.{booking_id}"},
            json={"advance_paid": advance_amount},
            headers={
                "apikey": key, "Authorization": f"Bearer {key}",
                "Content-Type": "application/json", "Prefer": "return=minimal",
            },
            timeout=aiohttp.ClientTimeout(total=3),
        )
        if resp.status in (200, 204):
            logger.info(f"[advance] ✅ Stored advance ₹{advance_amount} on booking {booking_id}")
        else:
            logger.warning(f"[advance] Store failed {resp.status}: {await resp.text()}")
    except Exception as e:
        logger.warning(f"[advance] store_advance_on_booking failed (non-fatal): {e}")


async def find_pending_reservation(customer_id: str, restaurant_id: str) -> dict | None:
    try:
        base = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
        key  = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
        if not (base and key):
            return None
        resp = await get_http().get(
            f"{base}/rest/v1/bookings",
            params={
                "select":          "id,token_number,advance_paid,booking_datetime",
                "customer_id":     f"eq.{customer_id}",
                "restaurant_id":   f"eq.{restaurant_id}",
                "service_type":    "eq.reserve_table",
                "status":          "eq.confirmed",
                "advance_applied": "eq.false",
                "advance_paid":    "gt.0",
                "order":           "created_at.desc",
                "limit":           "1",
            },
            headers={"apikey": key, "Authorization": f"Bearer {key}"},
            timeout=aiohttp.ClientTimeout(total=3),
        )
        if resp.status == 200:
            rows = await resp.json()
            if rows:
                logger.info(
                    f"[advance] Found pending reservation {rows[0]['id']} "
                    f"— advance ₹{rows[0]['advance_paid']}"
                )
            return rows[0] if rows else None
    except Exception as e:
        logger.debug(f"[advance] find_pending_reservation failed (non-fatal): {e}")
    return None


async def mark_advance_applied(reservation_booking_id: str) -> None:
    try:
        base = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
        key  = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
        if not (base and key):
            return
        resp = await get_http().patch(
            f"{base}/rest/v1/bookings",
            params={"id": f"eq.{reservation_booking_id}"},
            json={"advance_applied": True, "status": "completed"},
            headers={
                "apikey": key, "Authorization": f"Bearer {key}",
                "Content-Type": "application/json", "Prefer": "return=minimal",
            },
            timeout=aiohttp.ClientTimeout(total=3),
        )
        if resp.status in (200, 204):
            logger.info(f"[advance] ✅ Applied + reservation {reservation_booking_id} completed")
        else:
            logger.warning(f"[advance] Mark applied failed {resp.status}: {await resp.text()}")
    except Exception as e:
        logger.warning(f"[advance] mark_advance_applied failed (non-fatal): {e}")


# ─────────────────────────────────────────────
# LARGE PARTY HELPERS
# ─────────────────────────────────────────────

async def check_large_party_seating(party_size: int, restaurant_id: str) -> dict:
    try:
        tables = await get_available_tables(restaurant_id)
    except Exception as e:
        logger.warning(f"[large-party] get_available_tables failed (non-fatal): {e}")
        return {"can_seat": True, "total_available": 99, "combination": [], "shortfall": 0}

    total_available = sum(t["capacity"] for t in tables)
    if total_available < party_size:
        return {
            "can_seat": False, "total_available": total_available,
            "combination": [], "shortfall": party_size - total_available,
        }

    combo: list = []
    remaining = party_size
    for t in tables:
        if remaining <= 0:
            break
        seats_used = min(t["capacity"], remaining)
        combo.append((t["table_number"], t["capacity"], seats_used))
        remaining -= seats_used

    return {
        "can_seat": remaining <= 0, "total_available": total_available,
        "combination": combo, "shortfall": max(0, remaining),
    }


def format_combo_message(combo: list, party_size: int) -> str:
    lines = "\n".join(f"• Table {t[0]} — {t[2]} of {t[1]} seats" for t in combo)
    return (
        f"We can seat your party of *{party_size}* across multiple tables:\n\n"
        f"{lines}\n\n"
        f"Would you like to confirm this arrangement?\n\n"
        f"Or tap *Reserve* to book for a future date, or *Change* to enter a different party size."
    )


# ─────────────────────────────────────────────
# PORTAL SYNC
# ─────────────────────────────────────────────

async def sync_token_to_portal(
    customer_name: str, customer_phone: str, token_type: str, pax: int,
    restaurant_id: str,
) -> str | None:
    try:
        resp = await get_http().post(
            PORTAL_API_URL,
            json={
                "restaurant_id": restaurant_id,
                "name": customer_name, "phone": customer_phone,
                "type": token_type, "pax": pax,
                "secret": KDS_SECRET,
            },
            timeout=aiohttp.ClientTimeout(total=5),
        )
        if resp.status == 201:
            data = await resp.json()
            token_id = data.get("token", {}).get("id")
            logger.info(f"[portal-sync] Token created: {token_id}")
            return token_id
        logger.warning(f"[portal-sync] Non-201 {resp.status}: {await resp.text()}")
        return None
    except Exception as e:
        logger.warning(f"[portal-sync] Failed (non-fatal): {e}")
        return None


async def sync_token_to_portal_large_party(
    customer_name: str, customer_phone: str, pax: int, combo: list,
    restaurant_id: str,
) -> str | None:
    try:
        resp = await get_http().post(
            PORTAL_API_URL,
            params={"notify": "false"},
            json={
                "restaurant_id": restaurant_id,
                "name": customer_name, "phone": customer_phone,
                "type": "large_party", "pax": pax,
                "meta": {"combo": combo},
                "secret": KDS_SECRET,
            },
            timeout=aiohttp.ClientTimeout(total=5),
        )
        if resp.status == 201:
            data = await resp.json()
            token_id = data.get("token", {}).get("id")
            logger.info(f"[portal-sync-large] Token created: {token_id}")
            return token_id
        logger.warning(f"[portal-sync-large] Non-201 {resp.status}: {await resp.text()}")
        return None
    except Exception as e:
        logger.warning(f"[portal-sync-large] Failed (non-fatal): {e}")
        return None


async def lookup_table_assignment(customer_phone: str, restaurant_id: str) -> str | None:
    try:
        resp = await get_http().get(
            f"{PORTAL_API_URL}/lookup",
            params={"phone": customer_phone, "restaurant_id": restaurant_id},
            headers={"Authorization": f"Bearer {KDS_SECRET}"},
            timeout=aiohttp.ClientTimeout(total=3),
        )
        if resp.status == 200:
            data = await resp.json()
            tokens = data.get("tokens", []) if isinstance(data, dict) else data
            for token_record in tokens:
                if token_record.get("status") != "seated":
                    continue
                tbl = token_record.get("table_number")
                if tbl:
                    logger.info(f"[table-check] Found table {tbl} for {customer_phone}")
                    return str(tbl)
                combo = (token_record.get("meta") or {}).get("combo") or []
                if combo:
                    logger.info(
                        f"[table-check] Found combo tables "
                        f"{[row[0] for row in combo]} for {customer_phone}"
                    )
                    return str(combo[0][0])
    except Exception as e:
        logger.warning(f"[table-check] Portal lookup failed (non-fatal): {e}")
    return None


# ─────────────────────────────────────────────
# KDS NOTIFICATION
# ─────────────────────────────────────────────

async def notify_kds(
    customer_name: str, customer_phone: str, order_text: str, cart: dict,
    table_number: str | int | None, token_number: str, service_type: str,
    restaurant_id: str,
    special_notes: str | None = None,
) -> None:
    try:
        items = []
        for item_id, line in cart.items():
            items.append({
                "retailer_id": item_id, "name": line["title"],
                "qty": line["qty"], "unit_price": line["unit_price"],
            })
        if not items:
            items = [{"retailer_id": "manual", "name": order_text, "qty": 1, "unit_price": 0}]

        payload = {
            "restaurant_id": restaurant_id,
            "customer_name": customer_name, "customer_phone": customer_phone,
            "token_number": token_number,
            "table_number": str(table_number) if table_number else None,
            "service_type": service_type, "items": items,
            "special_notes": special_notes, "secret": KDS_SECRET,
        }
        resp = await get_http().post(
            AUTOM8_KDS_URL, json=payload, timeout=aiohttp.ClientTimeout(total=5)
        )
        if resp.status in (200, 201):
            data = await resp.json()
            logger.info(
                f"[kds-notify] ✅ {data.get('kds_items_created', '?')} item(s) "
                f"for token {token_number} | table {table_number}"
            )
        else:
            logger.warning(f"[kds-notify] Non-2xx {resp.status}: {(await resp.text())[:200]}")
    except Exception as e:
        logger.warning(f"[kds-notify] Failed (non-fatal): {e}")


# ─────────────────────────────────────────────
# PRIMARY: WHATSAPP CATALOG BOOKING
# ─────────────────────────────────────────────

async def send_catalog_booking(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> bool:
    """
    Send WhatsApp Catalog as PRIMARY booking mechanism.
    Returns True if successful, False on failure (triggers fallback).
    """
    try:
        success = await send_whatsapp_catalog_message(customer_phone, restaurant_id)
        if success:
            session_state["booking_mechanism"] = "catalog"
            logger.info(f"[BOOKING] {customer_phone} → PRIMARY: Catalog sent")
            return True
        logger.warning(f"[BOOKING] {customer_phone} → Catalog send failed")
        return False
    except Exception as e:
        logger.error(f"[BOOKING] {customer_phone} → Catalog error: {e}")
        return False


# ─────────────────────────────────────────────
# FALLBACK: INTERACTIVE CART BOOKING
# ─────────────────────────────────────────────

async def send_cart_booking(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> bool:
    """
    Send interactive cart as FALLBACK booking mechanism.
    Returns True if successful, False if both mechanisms fail.
    """
    try:
        success = await send_category_list(customer_phone, session_state)
        if success:
            session_state["booking_mechanism"] = "cart"
            logger.info(f"[BOOKING] {customer_phone} → FALLBACK: Cart (interactive list) sent")
            return True
        logger.warning(f"[BOOKING] {customer_phone} → Cart interactive list failed")
        return False
    except Exception as e:
        logger.error(f"[BOOKING] {customer_phone} → Cart error: {e}")
        return False


async def send_cart_fallback_text(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> bool:
    """Last-resort plain-text menu when both catalog and interactive fail."""
    try:
        menu_text = plain_text_menu()
        if menu_text and menu_text.strip():
            await send_whatsapp_message(customer_phone, menu_text, restaurant_id)
            session_state["booking_mechanism"] = "cart_text"
            session_state["booking_step"] = "awaiting_numbered_order"
            logger.info(f"[BOOKING] {customer_phone} → FALLBACK: Cart (plain text) sent")
            return True
        logger.error(f"[BOOKING] {customer_phone} → plain_text_menu() returned empty")
        return False
    except Exception as e:
        logger.error(f"[BOOKING] {customer_phone} → Plain-text menu error: {e}")
        return False


# ─────────────────────────────────────────────
# UNIFIED BOOKING MENU
# Primary + Fallback + Fix 40 last resort
# Used by flow modules as send_catalog_with_fallback
# ─────────────────────────────────────────────

async def send_unified_booking_menu(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> MechanismType:
    """
    Send booking menu with layered fallback strategy:

      1. Catalog attempt 1  (native WhatsApp Catalog)
      2. Catalog attempt 2  (2-second retry — handles transient Meta API blips)
      3. Interactive cart   (send_category_list)
      4. Plain-text menu    (numbered list)
      5. Last resort        (Fix 40: direct to 🛍️ Shop icon — never silent)

    Returns which mechanism was used: "catalog", "cart", "cart_text", or "none".
    Sets session_state["booking_mechanism"] accordingly.
    """
    logger.info(f"[BOOKING] send_unified_booking_menu called for {customer_phone}")

    # ── Attempt 1: Catalog ───────────────────────────────────────────────────
    if await send_catalog_booking(customer_phone, restaurant_id, session_state):
        if session_state.get("service_type") in ("dine_in", "takeaway", "delivery"):
            session_state["booking_step"] = "awaiting_order"
        return "catalog"

    # ── Attempt 2: Retry catalog after 2 s ───────────────────────────────────
    logger.warning(f"[BOOKING] {customer_phone} → catalog attempt 1 failed, retrying in 2 s")
    await asyncio.sleep(2)
    if await send_catalog_booking(customer_phone, restaurant_id, session_state):
        if session_state.get("service_type") in ("dine_in", "takeaway", "delivery"):
            session_state["booking_step"] = "awaiting_order"
        return "catalog"

    # ── Attempt 3: Interactive cart ───────────────────────────────────────────
    if await send_cart_booking(customer_phone, restaurant_id, session_state):
        return "cart"

    # ── Attempt 4: Plain-text menu ────────────────────────────────────────────
    if await send_cart_fallback_text(customer_phone, restaurant_id, session_state):
        return "cart_text"

    # ── Last resort: Fix 40 — direct to Shop icon, never leave silence ────────
    logger.error(f"[BOOKING] {customer_phone} → ALL mechanisms failed, using Shop-icon prompt")
    try:
        await send_whatsapp_message(
            customer_phone,
            (
                "🍽️ Our menu is ready for you!\n\n"
                "👆 Tap the *🛍️ Shop* icon at the top of this chat to browse "
                "and add items to your basket — then come back here to confirm.\n\n"
                "Or type *MENU* if you'd prefer a text list of today's items."
            ),
            restaurant_id,
        )
        session_state["booking_mechanism"] = "none"
        session_state["booking_step"] = session_state.get("booking_step", "awaiting_order")
    except Exception as e:
        logger.critical(f"[BOOKING] {customer_phone} → even last-resort message failed: {e}")

    return "none"


# Alias used by booking_helpers and flow modules
send_catalog_with_fallback = send_unified_booking_menu


# ─────────────────────────────────────────────
# BRIDGE: CATALOG ORDER → CART STATE
# ─────────────────────────────────────────────

def bridge_catalog_order_to_cart(
    webhook_message: dict[str, Any],
    session_state: dict[str, Any],
) -> bool:
    """
    Parse incoming WhatsApp catalog 'order' message and populate session cart.

    Converts:
      webhook_message["order"]["product_items"] → session_state["cart"]

    Allows downstream booking logic to handle catalog and cart orders
    identically (both result in session_state["cart"] being populated).

    Returns True if successfully parsed and populated, False otherwise.
    """
    parsed_order = parse_whatsapp_order(webhook_message)
    if parsed_order is None:
        logger.debug("Message is not a catalog order")
        return False

    items = parsed_order.get("items", [])
    total = parsed_order.get("total", 0.0)

    if not items:
        logger.warning("Catalog order has no items")
        return False

    cart = {}
    for item_line in items:
        item_id = item_line["id"]
        cart[item_id] = {
            "title":      item_line["title"],
            "qty":        item_line["qty"],
            "unit_price": item_line["unit_price"],
        }

    session_state["cart"] = cart
    session_state["booking_mechanism_order_source"] = "catalog"
    session_state["booking_step"] = "confirming_order"

    logger.info(f"Catalog order bridged to cart: {len(items)} items, total ₹{total:.0f}")
    return True


# ─────────────────────────────────────────────
# DETECTION
# ─────────────────────────────────────────────

def is_catalog_order(webhook_message: dict[str, Any]) -> bool:
    """Check if the incoming message is a WhatsApp catalog order ('order' type)."""
    return webhook_message.get("type") == "order"


# ─────────────────────────────────────────────
# LOGGING & ANALYTICS
# ─────────────────────────────────────────────

def log_booking_mechanism_used(
    customer_phone: str,
    mechanism: MechanismType,
    session_state: dict[str, Any],
) -> None:
    """Log which booking mechanism was used for analytics/debugging."""
    if not BOOKING_MECHANISM_CONFIG.get("log_mechanism"):
        return
    logger.info(
        f"[BOOKING_ANALYTICS] {customer_phone} | "
        f"mechanism={mechanism} | "
        f"service={session_state.get('service_type', 'unknown')} | "
        f"step={session_state.get('booking_step', 'unknown')}"
    )
