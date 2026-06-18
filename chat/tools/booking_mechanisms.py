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
_KDS_DEV_FALLBACK      = "munafe_kds_sync_2026"
_RECEIPT_REDIRECT_BASE = f"{_AUTOM8_BACKEND_URL}/r"


def _get_kds_secret() -> str:
    """Match Node internalSecret.js — Bearer + body secret for portal API calls."""
    secret = (_os.getenv("AUTOM8_KDS_SECRET") or "").strip()
    if secret:
        return secret
    env = (_os.getenv("NODE_ENV") or _os.getenv("RAILWAY_ENVIRONMENT") or "").lower()
    if env == "production":
        logger.error("[portal-sync] AUTOM8_KDS_SECRET is not set — portal sync will fail")
        return ""
    logger.warning("[portal-sync] AUTOM8_KDS_SECRET not set — using dev fallback")
    return _KDS_DEV_FALLBACK


KDS_SECRET = _get_kds_secret()


def _portal_auth_headers() -> dict[str, str]:
    secret = _get_kds_secret()
    if not secret:
        return {}
    return {
        "Authorization":     f"Bearer {secret}",
        "x-internal-secret": secret,
    }


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
                "select": "name,whatsapp_number,address,phone,gstin,website,city,state,parcel_charge_per_item,takeaway_ready_range,delivery_ready_range,kitchen_busy,restaurant_type,pickup_address,pickup_latitude,pickup_longitude,delivery_charge_default,delivery_charge_tiers,min_delivery_order_amount,min_takeaway_order_amount,scheduled_delivery_enabled,scheduled_takeaway_enabled,scheduled_kds_lead_minutes,max_delivery_radius_km,payment_mode",
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


async def cache_restaurant_pricing(session_state: dict, restaurant_id: str) -> None:
    """Store parcel rate, delivery tiers, pickup location, and timing in session."""
    info = await fetch_restaurant_info(restaurant_id)
    try:
        session_state["parcel_charge_per_item"] = float(info.get("parcel_charge_per_item") or 0)
    except (TypeError, ValueError):
        session_state["parcel_charge_per_item"] = 0.0
    session_state["takeaway_ready_range"] = (info.get("takeaway_ready_range") or "").strip() or None
    session_state["delivery_ready_range"] = (info.get("delivery_ready_range") or "").strip() or None
    session_state["kitchen_busy"] = bool(info.get("kitchen_busy"))

    session_state["restaurant_type"] = (info.get("restaurant_type") or "restaurant").strip().lower()
    session_state["pickup_address"] = (info.get("pickup_address") or "").strip() or None
    session_state["pickup_latitude"] = info.get("pickup_latitude")
    session_state["pickup_longitude"] = info.get("pickup_longitude")

    try:
        session_state["delivery_charge_default"] = float(info.get("delivery_charge_default") or 30)
    except (TypeError, ValueError):
        session_state["delivery_charge_default"] = 30.0

    tiers = info.get("delivery_charge_tiers")
    session_state["delivery_charge_tiers"] = tiers if isinstance(tiers, list) and tiers else None

    try:
        session_state["min_delivery_order_amount"] = float(info.get("min_delivery_order_amount") or 0)
    except (TypeError, ValueError):
        session_state["min_delivery_order_amount"] = 0.0
    try:
        session_state["min_takeaway_order_amount"] = float(info.get("min_takeaway_order_amount") or 0)
    except (TypeError, ValueError):
        session_state["min_takeaway_order_amount"] = 0.0

    session_state["scheduled_delivery_enabled"] = bool(info.get("scheduled_delivery_enabled"))
    session_state["scheduled_takeaway_enabled"] = bool(info.get("scheduled_takeaway_enabled"))
    session_state["scheduled_kds_lead_minutes"] = info.get("scheduled_kds_lead_minutes")

    try:
        session_state["max_delivery_radius_km"] = float(info.get("max_delivery_radius_km") or 0)
    except (TypeError, ValueError):
        session_state["max_delivery_radius_km"] = 0.0

    session_state["restaurant_city"] = (info.get("city") or "").strip() or None
    session_state["restaurant_state"] = (info.get("state") or "").strip() or None
    session_state["payment_mode"] = (info.get("payment_mode") or "prepay").strip().lower()


async def send_special_dishes_note(customer_phone: str, restaurant_id: str) -> None:
    """
    Friendly WhatsApp note for today's specials — not pushed to Meta catalog.
    """
    from tools.catalog_tools import fetch_menu_items

    await fetch_menu_items(restaurant_id)
    from tools.catalog_tools import MENU_ITEMS

    specials = [
        i for i in MENU_ITEMS
        if i.get("is_special_today") and i.get("is_available", True)
    ]
    if not specials:
        return

    names = ", ".join(i.get("title", "Special") for i in specials[:8])
    extra = f" (+{len(specials) - 8} more)" if len(specials) > 8 else ""
    await send_whatsapp_message(
        customer_phone,
        f"🌟 *Today's specials:* {names}{extra}\n"
        "Ask us to add any of these while you order — we'd love to serve you! 😊",
        restaurant_id,
    )


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

async def _notify_manager_scheduled_delivery(
    restaurant_id: str,
    token_id: str,
    customer_name: str,
    customer_phone: str,
    meta: dict | None = None,
) -> None:
    """Manager WhatsApp when a scheduled delivery order awaits approval (chat service path)."""
    from tools.restaurant_config import get_manager_phone

    manager_phone = await get_manager_phone(restaurant_id)
    if not manager_phone:
        logger.warning(
            f"[scheduled-delivery-alert] No manager phone for restaurant {restaurant_id}"
        )
        return

    meta = meta or {}
    sched_at = meta.get("scheduled_at_label") or meta.get("scheduled_at") or "—"
    addr = str(meta.get("delivery_address") or "—")[:80]
    total = meta.get("total")
    total_label = f"₹{float(total):.0f}" if total is not None else "—"
    order_text = str(meta.get("order_text") or "—")[:120]
    portal_url = (
        f"{_os.getenv('FRONTEND_URL', 'https://app.autom8.works').rstrip('/')}"
        "/dashboard/manager"
    )

    body = (
        f"🛵 *Scheduled Door Delivery* — Token *{token_id}*\n"
        f"👤 {customer_name}\n"
        f"📱 {customer_phone or '—'}\n"
        f"🕐 Delivery at: *{sched_at}*\n"
        f"📍 {addr}\n"
        f"💰 {total_label}\n\n"
        f"Order: {order_text}\n\n"
        f"Approve before the customer pays."
    )
    try:
        from tools.whatsapp_buttons_helper import send_whatsapp_buttons

        ok = await send_whatsapp_buttons(
            to=manager_phone,
            body=body,
            buttons=[
                {"id": f"SCHED_APPROVE_{token_id}", "title": "✅ Approve"},
                {"id": f"SCHED_REJECT_{token_id}", "title": "❌ Reject"},
            ],
            restaurant_id=restaurant_id,
            footer=f"Portal: {portal_url.split('/')[-1]}",
        )
        if not ok:
            await send_whatsapp_message(
                manager_phone,
                f"{body}\n\n⚠️ *Approve in portal:*\n{portal_url}",
                restaurant_id,
            )
        logger.info(f"[scheduled-delivery-alert] ✅ {token_id} → manager")
    except Exception as e:
        logger.warning(f"[scheduled-delivery-alert] failed for {token_id}: {e}")


async def approve_scheduled_delivery_token(restaurant_id: str, token_id: str) -> dict[str, Any]:
    """Manager approved a scheduled delivery via WhatsApp button."""
    secret = _get_kds_secret()
    if not secret:
        return {"ok": False, "error": "not_configured"}
    url = f"{PORTAL_API_URL}/{token_id}/approve-internal"
    try:
        resp = await get_http().post(
            url,
            json={"restaurant_id": restaurant_id, "secret": secret},
            headers=_portal_auth_headers(),
            timeout=aiohttp.ClientTimeout(total=8),
        )
        if resp.status in (200, 201):
            data = await resp.json()
            logger.info(f"[scheduled-delivery] approved {token_id}")
            return {"ok": True, "token": data.get("token")}
        body = (await resp.text())[:300]
        logger.error(f"[scheduled-delivery] approve failed {resp.status}: {body}")
        return {"ok": False, "error": body}
    except Exception as e:
        logger.error(f"[scheduled-delivery] approve error: {e}")
        return {"ok": False, "error": str(e)}


async def reject_scheduled_delivery_token(restaurant_id: str, token_id: str) -> dict[str, Any]:
    """Manager rejected a scheduled delivery via WhatsApp button."""
    secret = _get_kds_secret()
    if not secret:
        return {"ok": False, "error": "not_configured"}
    url = f"{PORTAL_API_URL}/{token_id}/reject-internal"
    try:
        resp = await get_http().post(
            url,
            json={"restaurant_id": restaurant_id, "secret": secret},
            headers=_portal_auth_headers(),
            timeout=aiohttp.ClientTimeout(total=8),
        )
        if resp.status in (200, 201):
            data = await resp.json()
            logger.info(f"[scheduled-delivery] rejected {token_id}")
            return {"ok": True, "token": data.get("token")}
        body = (await resp.text())[:300]
        logger.error(f"[scheduled-delivery] reject failed {resp.status}: {body}")
        return {"ok": False, "error": body}
    except Exception as e:
        logger.error(f"[scheduled-delivery] reject error: {e}")
        return {"ok": False, "error": str(e)}


async def _send_manager_walk_in_alert(
    restaurant_id: str,
    token_id: str,
    customer_name: str,
    pax: int,
    token_type: str,
) -> None:
    """Manager alert when token is created via DB fallback (API path sends its own)."""
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from tools.db_tools import get_restaurant_by_id

    rest = await get_restaurant_by_id(restaurant_id)
    manager_phone = (rest or {}).get("manager_phone")
    if not manager_phone:
        return

    arrival = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%d-%b-%y, %H:%M")
    portal_url = f"{_os.getenv('FRONTEND_URL', 'https://app.autom8.works').rstrip('/')}/dashboard/manager"

    if token_type == "dinein":
        body = (
            f"🪑 *New Walk-in* — Token *{token_id}*\n"
            f"👤 {customer_name}, {pax} {'person' if pax == 1 else 'people'}\n"
            f"🍽️ Dine-in\n🕐 {arrival} IST\n\n"
            f"Open portal to assign table:\n{portal_url}"
        )
    elif token_type == "takeaway":
        body = (
            f"🪑 *New Walk-in* — Token *{token_id}*\n"
            f"👤 {customer_name}\n📦 Takeaway\n🕐 {arrival} IST\n\n{portal_url}"
        )
    elif token_type == "scheduled_delivery":
        body = (
            f"🛵 *Scheduled Door Delivery* — Token *{token_id}*\n"
            f"👤 {customer_name}\n🕐 {arrival} IST\n\n"
            f"⚠️ *Approve in portal before customer pays:*\n{portal_url}"
        )
    else:
        body = (
            f"🟣 *Large Party Request* — Token *{token_id}*\n"
            f"👥 {customer_name} · *{pax} people*\n🕐 {arrival} IST\n\n"
            f"⚠️ *Action required:*\n{portal_url}"
        )

    try:
        await send_whatsapp_message(manager_phone, body, restaurant_id)
    except Exception as e:
        logger.warning(f"[portal-sync] Manager alert failed (non-fatal): {e}")


async def _sync_token_via_api(
    payload: dict,
    customer_phone: str,
    log_label: str,
    max_attempts: int = 3,
    *,
    skip_api_notify: bool = False,
) -> str | None:
    secret = _get_kds_secret()
    if not secret:
        logger.warning(f"[{log_label}] No AUTOM8_KDS_SECRET — skipping API, will use DB fallback")
        return None

    payload = {**payload, "secret": secret}
    headers = _portal_auth_headers()
    url = PORTAL_API_URL
    if skip_api_notify:
        url = f"{PORTAL_API_URL}?notify=false"

    for attempt in range(max_attempts):
        try:
            resp = await get_http().post(
                url,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=8),
            )
            if resp.status == 201:
                data = await resp.json()
                token_id = data.get("token", {}).get("id")
                logger.info(f"[{log_label}] API token created: {token_id}")
                return token_id
            body = await resp.text()
            logger.error(
                f"[{log_label}] Attempt {attempt + 1}/{max_attempts} "
                f"failed {resp.status} for {customer_phone}: {body[:300]}"
            )
        except Exception as e:
            logger.error(
                f"[{log_label}] Attempt {attempt + 1}/{max_attempts} "
                f"error for {customer_phone}: {e}"
            )
        if attempt < max_attempts - 1:
            await asyncio.sleep(0.75 * (attempt + 1))

    return None


async def _rebroadcast_portal_token(restaurant_id: str, token_id: str) -> None:
    """Notify manager portal WebSocket after direct DB token insert."""
    secret = _get_kds_secret()
    if not secret:
        return
    url = f"{_AUTOM8_BACKEND_URL}/api/tokens/rebroadcast"
    try:
        resp = await get_http().post(
            url,
            json={"restaurant_id": restaurant_id, "token_id": token_id},
            headers=_portal_auth_headers(),
            timeout=aiohttp.ClientTimeout(total=5),
        )
        if resp.status == 200:
            logger.info(f"[portal-sync] Rebroadcast TOKEN_NEW for {token_id}")
        else:
            logger.warning(f"[portal-sync] Rebroadcast failed {resp.status}: {(await resp.text())[:200]}")
    except Exception as e:
        logger.warning(f"[portal-sync] Rebroadcast error (non-fatal): {e}")


async def notify_manager_order_alert(
    restaurant_id: str,
    *,
    token_number: str,
    customer_name: str,
    customer_phone: str,
    order_text: str,
    total: float,
    table_number,
    party_size,
    booking_time: str,
    service_type: str = "dine_in",
) -> bool:
    """Send manager order alert via Node API — same WhatsApp path as walk-in tokens."""
    secret = _get_kds_secret()
    if not secret:
        logger.error("[manager-order-alert] AUTOM8_KDS_SECRET not set")
        return False

    url = f"{_AUTOM8_BACKEND_URL}/api/tokens/manager-order-alert"
    payload = {
        "restaurant_id": restaurant_id,
        "token_number": token_number,
        "customer_name": customer_name,
        "customer_phone": customer_phone,
        "order_text": order_text,
        "total": total,
        "table_number": table_number,
        "party_size": party_size,
        "booking_time": booking_time,
        "service_type": service_type,
    }
    try:
        resp = await get_http().post(
            url,
            json=payload,
            headers=_portal_auth_headers(),
            timeout=aiohttp.ClientTimeout(total=8),
        )
        if resp.status in (200, 201):
            logger.info(f"[manager-order-alert] ✅ API sent for {token_number}")
            return True
        body = (await resp.text())[:300]
        logger.error(f"[manager-order-alert] API {resp.status}: {body}")
    except Exception as e:
        logger.warning(f"[manager-order-alert] API error for {token_number}: {e}")
    return False


async def assign_and_notify_captain_takeaway(
    restaurant_id: str,
    *,
    token_number: str,
    customer_name: str,
    customer_phone: str,
    order_text: str,
    total: float,
    booking_time: str,
) -> dict[str, Any] | None:
    """
    Auto-assign least-loaded captain and WhatsApp-notify them.
    Returns {captain_name, display_name, assigned, notified} or None on failure.
    """
    secret = _get_kds_secret()
    if not secret:
        logger.error("[captain-takeaway] AUTOM8_KDS_SECRET not set")
        return None

    url = f"{_AUTOM8_BACKEND_URL}/api/tokens/captain-takeaway-alert"
    payload = {
        "restaurant_id": restaurant_id,
        "token_number": token_number,
        "customer_name": customer_name,
        "customer_phone": customer_phone,
        "order_text": order_text,
        "total": total,
        "booking_time": booking_time,
    }
    try:
        resp = await get_http().post(
            url,
            json=payload,
            headers=_portal_auth_headers(),
            timeout=aiohttp.ClientTimeout(total=8),
        )
        if resp.status in (200, 201):
            data = await resp.json()
            if data.get("assigned"):
                logger.info(
                    f"[captain-takeaway] ✅ {token_number} → {data.get('captain_name')}"
                )
            else:
                logger.warning(
                    f"[captain-takeaway] No captain on duty for {token_number}"
                )
            return data
        body = (await resp.text())[:300]
        logger.error(f"[captain-takeaway] API {resp.status}: {body}")
    except Exception as e:
        logger.warning(f"[captain-takeaway] API error for {token_number}: {e}")
    return None


async def sync_token_to_portal(
    customer_name: str, customer_phone: str, token_type: str, pax: int,
    restaurant_id: str,
    max_attempts: int = 3,
) -> str | None:
    """
    Create a walk_in_tokens row for the manager portal.
    Tries Node API first; falls back to direct Postgres insert.
    """
    from tools.db_tools import create_walk_in_token_direct

    payload = {
        "restaurant_id": restaurant_id,
        "name":          customer_name,
        "phone":         customer_phone,
        "type":          token_type,
        "pax":           pax,
    }

    token_id = await _sync_token_via_api(payload, customer_phone, "portal-sync", max_attempts)
    if token_id:
        return token_id

    logger.warning(f"[portal-sync] API failed — direct DB fallback for {customer_phone}")
    token_id = await create_walk_in_token_direct(
        restaurant_id=restaurant_id,
        name=customer_name,
        phone=customer_phone,
        token_type=token_type,
        pax=pax,
    )
    if token_id:
        await _send_manager_walk_in_alert(
            restaurant_id, token_id, customer_name, pax, token_type,
        )
        await _rebroadcast_portal_token(restaurant_id, token_id)
    return token_id


async def sync_token_to_portal_large_party(
    customer_name: str, customer_phone: str, pax: int, combo: list,
    restaurant_id: str,
    max_attempts: int = 3,
) -> str | None:
    from tools.db_tools import create_walk_in_token_direct

    payload = {
        "restaurant_id": restaurant_id,
        "name":          customer_name,
        "phone":         customer_phone,
        "type":          "large_party",
        "pax":           pax,
        "meta":          {"combo": combo},
    }

    token_id = await _sync_token_via_api(payload, customer_phone, "portal-sync-large", max_attempts)
    if token_id:
        return token_id

    logger.warning(f"[portal-sync-large] API failed — direct DB fallback for {customer_phone}")
    token_id = await create_walk_in_token_direct(
        restaurant_id=restaurant_id,
        name=customer_name,
        phone=customer_phone,
        token_type="large_party",
        pax=pax,
        meta={"combo": combo},
    )
    if token_id:
        await _send_manager_walk_in_alert(
            restaurant_id, token_id, customer_name, pax, "large_party",
        )
    return token_id


async def sync_scheduled_delivery_to_portal(
    customer_name: str,
    customer_phone: str,
    restaurant_id: str,
    meta: dict,
    max_attempts: int = 3,
) -> str | None:
    """Queue a scheduled delivery in the manager portal for approval before payment."""
    from tools.db_tools import create_walk_in_token_direct

    payload = {
        "restaurant_id": restaurant_id,
        "name":          customer_name,
        "phone":         customer_phone,
        "type":          "scheduled_delivery",
        "pax":           1,
        "meta":          meta,
    }

    token_id = await _sync_token_via_api(
        payload, customer_phone, "portal-sync-scheduled", max_attempts,
        skip_api_notify=True,
    )
    if token_id:
        await _notify_manager_scheduled_delivery(
            restaurant_id, token_id, customer_name, customer_phone, meta,
        )
        await _rebroadcast_portal_token(restaurant_id, token_id)
        return token_id

    logger.warning(f"[portal-sync-scheduled] API failed — direct DB fallback for {customer_phone}")
    token_id = await create_walk_in_token_direct(
        restaurant_id=restaurant_id,
        name=customer_name,
        phone=customer_phone,
        token_type="scheduled_delivery",
        pax=1,
        meta=meta,
    )
    if token_id:
        await _notify_manager_scheduled_delivery(
            restaurant_id, token_id, customer_name, customer_phone, meta,
        )
        await _rebroadcast_portal_token(restaurant_id, token_id)
    return token_id


async def lookup_table_assignment(customer_phone: str, restaurant_id: str) -> str | None:
    try:
        resp = await get_http().get(
            f"{PORTAL_API_URL}/lookup",
            params={"phone": customer_phone, "restaurant_id": restaurant_id},
            headers=_portal_auth_headers(),
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
) -> str | None:
    """POST order to Node KDS API. Returns order_id on success, else None."""
    try:
        items = []
        for item_id, line in (cart or {}).items():
            if not isinstance(line, dict):
                continue
            title = (line.get("title") or line.get("name") or str(item_id)).strip()
            if not title:
                continue
            items.append({
                "retailer_id": str(item_id),
                "name": title,
                "qty": int(line.get("qty") or 1),
                "unit_price": float(line.get("unit_price") or 0),
            })
        order_text = (order_text or "").strip()
        if not items and order_text:
            items = [{"retailer_id": "manual", "name": order_text, "qty": 1, "unit_price": 0}]

        if not items:
            logger.error(
                f"[kds-notify] No items to send for token {token_number} "
                f"(cart={len(cart or {})} lines, order_text={order_text!r})"
            )
            return None

        secret = _get_kds_secret()
        if not secret:
            logger.error("[kds-notify] AUTOM8_KDS_SECRET not set — cannot reach KDS API")
            return None

        payload = {
            "restaurant_id": restaurant_id,
            "customer_name": customer_name, "customer_phone": customer_phone,
            "token_number": token_number,
            "table_number": str(table_number) if table_number else None,
            "service_type": service_type, "items": items,
            "special_notes": special_notes, "secret": secret,
        }
        headers = _portal_auth_headers()

        for attempt in range(3):
            try:
                resp = await get_http().post(
                    AUTOM8_KDS_URL,
                    json=payload,
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=8),
                )
                if resp.status in (200, 201):
                    data = await resp.json()
                    kds_count = int(data.get("kds_items_created") or 0)
                    tag = "deduped" if data.get("deduplicated") else "created"
                    if kds_count <= 0:
                        logger.error(
                            f"[kds-notify] attempt {attempt + 1}/3 — API ok but 0 KDS items "
                            f"for token {token_number} | restaurant {restaurant_id} | {data}"
                        )
                        if attempt < 2:
                            await asyncio.sleep(0.75 * (attempt + 1))
                        continue
                    logger.info(
                        f"[kds-notify] ✅ {kds_count} item(s) "
                        f"({tag}) for token {token_number} | table {table_number} | "
                        f"order {data.get('order_id', '?')} | restaurant {restaurant_id}"
                    )
                    return data.get("order_id")
                body = await resp.text()
                logger.error(
                    f"[kds-notify] attempt {attempt + 1}/3 failed {resp.status}: {body[:300]}"
                )
            except Exception as e:
                logger.error(f"[kds-notify] attempt {attempt + 1}/3 error: {e}")
            if attempt < 2:
                await asyncio.sleep(0.75 * (attempt + 1))
    except Exception as e:
        logger.warning(f"[kds-notify] Failed (non-fatal): {e}")
    return None


async def update_kds_order_notes(
    restaurant_id: str,
    order_id: str | None,
    token_number: str,
    special_notes: str,
) -> None:
    """Patch kitchen notes onto an order already on KDS."""
    if not special_notes:
        return
    secret = _get_kds_secret()
    if not secret:
        return
    url = f"{_AUTOM8_BACKEND_URL}/api/kds/order-notes"
    try:
        resp = await get_http().patch(
            url,
            json={
                "restaurant_id": restaurant_id,
                "order_id": order_id,
                "token_number": token_number,
                "special_notes": special_notes,
                "secret": secret,
            },
            headers=_portal_auth_headers(),
            timeout=aiohttp.ClientTimeout(total=5),
        )
        if resp.status == 200:
            logger.info(f"[kds-notify] ✅ notes updated for token {token_number}")
        else:
            logger.warning(
                f"[kds-notify] notes update failed {resp.status}: {(await resp.text())[:200]}"
            )
    except Exception as e:
        logger.warning(f"[kds-notify] notes update error (non-fatal): {e}")


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
        success = await send_category_list(customer_phone, session_state, restaurant_id)
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
        from tools.catalog_tools import fetch_menu_items
        await fetch_menu_items(restaurant_id)
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

    session_state["restaurant_id"] = restaurant_id
    from tools.catalog_tools import invalidate_menu_cache, fetch_menu_items
    invalidate_menu_cache(restaurant_id)
    items = await fetch_menu_items(restaurant_id)
    await cache_restaurant_pricing(session_state, restaurant_id)

    # Dine-in: never send menu until a table is assigned (portal or chat poll).
    if session_state.get("service_type") == "dine_in":
        step = session_state.get("booking_step")
        if step in ("awaiting_table_assignment", "awaiting_party_size", "awaiting_manager_approval"):
            logger.info(f"[BOOKING] Skipping menu for dine-in step={step} (await table)")
            return "none"
        if step == "awaiting_order" and not session_state.get("table_number"):
            logger.info(f"[BOOKING] Skipping menu for dine-in — no table_number yet")
            return "none"

    # ── Attempt 1: Catalog ───────────────────────────────────────────────────
    if await send_catalog_booking(customer_phone, restaurant_id, session_state):
        if session_state.get("service_type") in ("dine_in", "takeaway", "delivery"):
            session_state["booking_step"] = "awaiting_order"
        await send_special_dishes_note(customer_phone, restaurant_id)
        return "catalog"

    # ── Attempt 2: Retry catalog after 2 s ───────────────────────────────────
    logger.warning(f"[BOOKING] {customer_phone} → catalog attempt 1 failed, retrying in 2 s")
    await asyncio.sleep(2)
    if await send_catalog_booking(customer_phone, restaurant_id, session_state):
        if session_state.get("service_type") in ("dine_in", "takeaway", "delivery"):
            session_state["booking_step"] = "awaiting_order"
        await send_special_dishes_note(customer_phone, restaurant_id)
        return "catalog"

    # ── Attempt 3: Interactive cart ───────────────────────────────────────────
    if await send_cart_booking(customer_phone, restaurant_id, session_state):
        await send_special_dishes_note(customer_phone, restaurant_id)
        return "cart"

    # ── Attempt 3b: Menu empty (e.g. kitchen closed / slot gap) ───────────────
    available = [i for i in items if i.get("is_available", True)] if items else []
    if not available:
        logger.error(
            f"[BOOKING] {customer_phone} → no available menu items for {restaurant_id}"
        )
        try:
            from tools.kitchen_hours import build_menu_closed_message
            await send_whatsapp_message(
                customer_phone,
                build_menu_closed_message(session_state.get("service_type")),
                restaurant_id,
            )
        except Exception as e:
            logger.warning(f"[BOOKING] closed-hours message failed: {e}")
        return "none"

    # ── Attempt 4: Plain-text menu ────────────────────────────────────────────
    if await send_cart_fallback_text(customer_phone, restaurant_id, session_state):
        await send_special_dishes_note(customer_phone, restaurant_id)
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
        session_state["booking_step"] = "awaiting_order"
    except Exception as e:
        logger.critical(f"[BOOKING] {customer_phone} → even last-resort message failed: {e}")

    return "none"


def status_after_booking_menu(session_state: dict[str, Any]) -> str:
    """Routing status aligned with booking_step after send_catalog_with_fallback."""
    return session_state.get("booking_step", "awaiting_order")


# Alias used by booking_helpers and flow modules
send_catalog_with_fallback = send_unified_booking_menu


# ─────────────────────────────────────────────
# BRIDGE: CATALOG ORDER → CART STATE
# ─────────────────────────────────────────────

async def bridge_catalog_order_to_cart(
    webhook_message: dict[str, Any],
    session_state: dict[str, Any],
    restaurant_id: str,
) -> bool:
    """
    Parse incoming WhatsApp catalog 'order' message and populate session cart.

    Converts:
      webhook_message["order"]["product_items"] → session_state["cart"]

    Allows downstream booking logic to handle catalog and cart orders
    identically (both result in session_state["cart"] being populated).

    Returns True if successfully parsed and populated, False otherwise.
    """
    from tools.catalog_tools import fetch_menu_items
    from tools.cart_tools import enrich_cart_titles
    from tools.restaurant_config import get_meta_catalog_id

    expected_catalog_id = await get_meta_catalog_id(restaurant_id)
    if not expected_catalog_id:
        logger.error(
            f"[CATALOG] refusing order for {restaurant_id} — meta_catalog_id not in DB"
        )
        return False

    order_payload = webhook_message.get("order") or {}
    order_catalog_id = str(order_payload.get("catalog_id") or "").strip()
    if order_catalog_id and order_catalog_id != expected_catalog_id:
        logger.error(
            f"[CATALOG] catalog_id mismatch for {restaurant_id}: "
            f"order={order_catalog_id} expected={expected_catalog_id}"
        )
        return False

    from tools.catalog_tools import invalidate_menu_cache

    menu_items = await fetch_menu_items(restaurant_id)
    allowed_ids = {
        str(i.get("id") or "").strip()
        for i in menu_items
        if i.get("id")
    }

    parsed_order = parse_whatsapp_order(webhook_message)
    if parsed_order is None:
        logger.debug("Message is not a catalog order")
        return False

    items = parsed_order.get("items", [])
    total = parsed_order.get("total", 0.0)

    if not items:
        logger.warning("Catalog order has no items")
        return False

    # When slot rotation zeros is_available (e.g. dinner ended at 23:00 IST), the
    # internal menu API returns 0 items but Meta's WABA shop still sells them.
    # If catalog_id already matched above, trust the order payload in that case.
    if allowed_ids:
        unknown = [
            item_line["id"]
            for item_line in items
            if item_line["id"] not in allowed_ids
        ]
        if unknown:
            logger.error(
                f"[CATALOG] order contains items not in restaurant menu: {unknown[:5]}"
            )
            return False
    else:
        logger.warning(
            f"[CATALOG] menu cache empty for {restaurant_id} — "
            f"accepting {len(items)} catalog items (catalog_id verified)"
        )
        invalidate_menu_cache(restaurant_id)

    cart = {}
    for item_line in items:
        item_id = item_line["id"]
        cart[item_id] = {
            "title":      item_line["title"],
            "qty":        item_line["qty"],
            "unit_price": item_line["unit_price"],
        }

    await enrich_cart_titles(cart, restaurant_id)
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
