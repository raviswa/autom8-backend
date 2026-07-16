"""
tools/booking_mechanisms.py
─────────────────────────────────────────────────────────────────────────────
Unified booking mechanism with deterministic web-menu channel.

MERGED: original catalog/cart strategy + backend helpers extracted from
        agents/customer/booking_agent.py.

Strategy
────────
    PRIMARY  : branded web menu link
                         Customer browses full menu/search/cart on web and returns to WhatsApp.

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
      "primary":          "log",
      "fallback":         "cart",
      "timeout_seconds":  30,
      "log_mechanism":    True,
  }

FIX LOG
───────
  DEFECT FIX (2026-07-06): fetch_restaurant_info() previously returned {} on
  BOTH "restaurant genuinely has no services configured" AND "the fetch call
  itself failed / timed out / errored". build_service_menu_rows() couldn't
  tell these apart, so a transient 3s timeout or a brief Supabase hiccup was
  silently equated with "restaurant has zero services enabled", and
  customers were told "We're not accepting orders right now" — even while
  the separate kitchen-hours check correctly said the kitchen was open.
  fetch_restaurant_info() now returns None (not {}) when the fetch itself
  failed, so callers can distinguish "no services" from "couldn't check".
  All existing callers that assumed a dict (cache_restaurant_pricing,
  _send_web_menu_message) now guard with `info = info or {}` to preserve
  their prior graceful-degradation behavior — only build_service_menu_rows
  needs to treat the two cases differently.
"""

from __future__ import annotations

import asyncio
import logging
import os as _os
import secrets
import time
from typing import Any, Literal
from uuid import uuid4

import aiohttp

from tools.whatsapp_tools import send_whatsapp_message, send_whatsapp_cta_url
from tools.db_tools import (
    get_available_tables,
    get_active_walk_in_token,
    get_restaurant_by_id,
    create_menu_link_token,
    create_walk_in_token_direct,
)

logger = logging.getLogger(__name__)

# In-process TTL cache for tenants metadata (Hi / service-menu path hits this
# multiple times per turn). Failures are never cached.
_RESTAURANT_INFO_TTL_S = int(_os.getenv("RESTAURANT_INFO_CACHE_TTL_S", "60"))
_RESTAURANT_INFO_CACHE: dict[str, tuple[float, dict]] = {}


# ─────────────────────────────────────────────
# BOOKING MECHANISM CONFIG
# ─────────────────────────────────────────────

BOOKING_MECHANISM_CONFIG: dict[str, Any] = {
    "primary":         "web_menu",
    "timeout_seconds": 30,
    "log_mechanism":   True,
}

MechanismType = Literal["web_menu", "none"]


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
    from generate_receipt import restaurant_receipt_fields as _restaurant_receipt_fields
    RECEIPT_AVAILABLE = True
    print("[receipt] ✅ generate_receipt loaded", flush=True)
except ImportError as _e:
    RECEIPT_AVAILABLE = False
    _generate_receipt = _ReceiptData = _LineItem = _restaurant_receipt_fields = None
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


async def fetch_restaurant_info(restaurant_id: str) -> dict | None:
    """
    Fetch restaurant metadata (services, pricing, receipt fields, etc).

    DEFECT FIX (2026-07-06): Returns None when the fetch itself failed
    (missing env vars, timeout, non-200 response, exception) — NOT {}.
    Returns {} only when Supabase responded 200 with zero matching rows
    (restaurant_id genuinely not found). This lets callers like
    build_service_menu_rows() distinguish "couldn't check right now"
    from "this restaurant really has nothing configured", instead of a
    transient network blip being silently read as "no services enabled"
    and customers being told the restaurant is closed.

    Callers that want the old best-effort/graceful-degradation behavior
    (e.g. receipt generation, pricing cache) should do `info = info or {}`
    after calling this.

    Results are TTL-cached in-process (default 60s) so Hi / service-menu
    paths that call this 2–3 times per turn share one Supabase round-trip.
    """
    rid = str(restaurant_id or "").strip()
    if not rid:
        return None

    now = time.monotonic()
    cached = _RESTAURANT_INFO_CACHE.get(rid)
    if cached and (now - cached[0]) < _RESTAURANT_INFO_TTL_S:
        return cached[1]

    try:
        base = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
        key  = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
        if not (base and key):
            logger.error("[restaurant-info] Supabase env vars not set — cannot fetch restaurant info")
            return None
        base_select = (
            "name,display_name,receipt_tagline,cuisine_type,timezone,"
            "whatsapp_number,address,phone,gstin,fssai_license,sac_code,website,city,state,"
            "parcel_charge_per_item,takeaway_ready_range,delivery_ready_range,kitchen_busy,"
            "restaurant_type,pickup_address,pickup_latitude,pickup_longitude,delivery_charge_default,"
            "delivery_charge_tiers,min_delivery_order_amount,min_takeaway_order_amount,"
            "scheduled_delivery_enabled,scheduled_takeaway_enabled,scheduled_kds_lead_minutes,"
            "max_delivery_radius_km,scheduled_slot_max_orders,schedule_buffer_minutes,"
            "schedule_rounding_minutes,payment_mode"
        )
        select_attempts = [
            f"{base_select},services_enabled,subscribed_features",
            f"{base_select},subscribed_features",
        ]

        last_status: int | None = None
        for select_clause in select_attempts:
            resp = await get_http().get(
                f"{base}/rest/v1/tenants",
                params={
                    "select": select_clause,
                    "id":     f"eq.{rid}",
                    "limit":  "1",
                },
                headers={"apikey": key, "Authorization": f"Bearer {key}"},
                timeout=aiohttp.ClientTimeout(total=3),
            )
            last_status = resp.status
            if resp.status == 200:
                rows = await resp.json()
                result = rows[0] if rows else {}
                _RESTAURANT_INFO_CACHE[rid] = (now, result)
                return result

        # All select attempts failed (non-200) — this is a fetch failure,
        # not "restaurant has no rows". Surface None so callers don't treat
        # it as "no services enabled". Do not cache failures.
        logger.error(
            f"[restaurant-info] fetch failed for restaurant_id={rid} "
            f"— last status={last_status}"
        )
        return None
    except Exception as e:
        logger.warning(f"[restaurant-info] fetch errored for restaurant_id={rid}: {e}")
        return None


def invalidate_restaurant_info_cache(restaurant_id: str | None = None) -> None:
    """Drop cached restaurant info for one tenant, or clear the whole map."""
    if restaurant_id is None:
        _RESTAURANT_INFO_CACHE.clear()
        return
    _RESTAURANT_INFO_CACHE.pop(str(restaurant_id).strip(), None)


async def cache_restaurant_pricing(session_state: dict, restaurant_id: str) -> None:
    """Store parcel rate, delivery tiers, pickup location, and timing in session."""
    # DEFECT FIX (2026-07-06): fetch_restaurant_info() can now return None on
    # fetch failure (previously always returned {}). Guard here so pricing
    # just falls back to defaults on a failed fetch, same as before.
    info = await fetch_restaurant_info(restaurant_id) or {}
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

    from tools.kitchen_hours import refresh_kitchen_acceptance
    await refresh_kitchen_acceptance(session_state, restaurant_id)


async def send_special_dishes_note(
    customer_phone: str,
    restaurant_id: str,
    *,
    menu_items: list[dict] | None = None,
) -> bool:
    """
    Friendly WhatsApp note for today's specials — not pushed to Meta catalog.
    Returns True if a message was sent.
    """
    from tools.catalog_tools import invalidate_menu_cache, fetch_menu_items

    if menu_items is None:
        invalidate_menu_cache(restaurant_id)
        menu_items = await fetch_menu_items(restaurant_id)

    specials = [
        i for i in (menu_items or [])
        if i.get("is_special_today") and i.get("is_available", True)
    ]
    if not specials:
        logger.info(f"[specials] No is_special_today items for restaurant {restaurant_id}")
        return False

    names = ", ".join(i.get("title", "Special") for i in specials[:8])
    extra = f" (+{len(specials) - 8} more)" if len(specials) > 8 else ""
    await send_whatsapp_message(
        customer_phone,
        f"🌟 *Today's specials:* {names}{extra}\n"
        "Ask us to add any of these while you order — we'd love to serve you! 😊",
        restaurant_id,
    )
    logger.info(f"[specials] Sent {len(specials)} special(s) to {customer_phone}")
    return True


async def maybe_send_special_dishes_note(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any] | None = None,
    *,
    menu_items: list[dict] | None = None,
    force: bool = False,
) -> bool:
    """Send today's specials once per session (unless force=True)."""
    if session_state is not None and session_state.get("_specials_note_sent") and not force:
        return False
    try:
        sent = await send_special_dishes_note(
            customer_phone, restaurant_id, menu_items=menu_items,
        )
        if sent and session_state is not None:
            session_state["_specials_note_sent"] = True
        return sent
    except Exception as exc:
        logger.warning(f"[specials] Failed for {customer_phone}: {exc}")
        return False


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
    *,
    manager_phone: str | None = None,
) -> None:
    """Manager WhatsApp when a scheduled delivery order awaits approval."""
    from tools.restaurant_config import get_manager_phone

    alert_phone = (manager_phone or "").strip()
    if not alert_phone:
        alert_phone = (await get_manager_phone(restaurant_id) or "").strip()
    if not alert_phone:
        logger.error(
            f"[scheduled-delivery-alert] No manager phone for restaurant {restaurant_id} "
            f"(token {token_id})"
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
        f"Approve before the customer pays.\n\n"
        f"Portal: {portal_url}"
    )
    try:
        from tools.whatsapp_buttons_helper import send_whatsapp_buttons

        ok = await send_whatsapp_buttons(
            to=alert_phone,
            body=body,
            buttons=[
                {"id": f"SCHED_APPROVE_{token_id}", "title": "✅ Approve"},
                {"id": f"SCHED_REJECT_{token_id}", "title": "❌ Reject"},
            ],
            restaurant_id=restaurant_id,
            footer="Manager Portal — Pending approval",
        )
        if not ok:
            await send_whatsapp_message(alert_phone, body, restaurant_id)
        logger.info(f"[scheduled-delivery-alert] ✅ {token_id} → manager {alert_phone}")
    except Exception as e:
        logger.error(f"[scheduled-delivery-alert] failed for {token_id}: {e}")
        try:
            await send_whatsapp_message(alert_phone, body, restaurant_id)
        except Exception as e2:
            logger.error(f"[scheduled-delivery-alert] plain-text fallback failed: {e2}")


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
        if resp.status == 409:
            logger.info(f"[scheduled-delivery] approve skipped — already handled ({token_id})")
            return {"ok": True, "already_handled": True}
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
        if resp.status == 409:
            logger.info(f"[scheduled-delivery] reject skipped — already handled ({token_id})")
            return {"ok": False, "error": "already_handled"}
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
    elif token_type == "scheduled_takeaway":
        body = (
            f"🥡 *Scheduled take-away* — Token *{token_id}*\n"
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
            if resp.status in (200, 201):
                data = await resp.json()
                token_id = data.get("token", {}).get("id")
                if data.get("deduplicated"):
                    logger.info(f"[{log_label}] Reused active token {token_id} for {customer_phone}")
                else:
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
    Reuses an existing non-terminal token for this phone when present.
    """
    from tools.db_tools import create_walk_in_token_direct, get_active_walk_in_token

    existing = await get_active_walk_in_token(restaurant_id, customer_phone)
    if existing and existing.get("type") == token_type:
        logger.info(
            f"[portal-sync] Reusing active token {existing['id']} for {customer_phone} "
            f"(status={existing.get('status')})"
        )
        return existing["id"]

    payload = {
        "restaurant_id": restaurant_id,
        "name":          customer_name,
        "phone":         customer_phone,
        "type":          token_type,
        "pax":           pax,
        "customer_notify": False,
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
    from tools.db_tools import create_walk_in_token_direct, get_active_walk_in_token

    existing = await get_active_walk_in_token(restaurant_id, customer_phone)
    if existing and existing.get("type") == "large_party":
        logger.info(
            f"[portal-sync-large] Reusing active token {existing['id']} for {customer_phone}"
        )
        return existing["id"]

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

    # skip_api_notify: Python sends the single manager WhatsApp alert below.
    # Node POST already broadcasts TOKEN_NEW to the portal — no rebroadcast needed.
    token_id = await _sync_token_via_api(
        payload, customer_phone, "portal-sync-scheduled", max_attempts,
        skip_api_notify=True,
    )
    if token_id:
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
        await _rebroadcast_portal_token(restaurant_id, token_id)
    return token_id


async def sync_scheduled_takeaway_to_portal(
    customer_name: str,
    customer_phone: str,
    restaurant_id: str,
    meta: dict,
    max_attempts: int = 3,
) -> str | None:
    """Queue a scheduled takeaway in the manager portal for approval before payment."""
    from tools.db_tools import create_walk_in_token_direct

    payload = {
        "restaurant_id": restaurant_id,
        "name":          customer_name,
        "phone":         customer_phone,
        "type":          "scheduled_takeaway",
        "pax":           1,
        "meta":          meta,
    }

    token_id = await _sync_token_via_api(
        payload, customer_phone, "portal-sync-scheduled-takeaway", max_attempts,
        skip_api_notify=True,
    )
    if token_id:
        return token_id

    logger.warning(f"[portal-sync-scheduled-takeaway] API failed — direct DB fallback for {customer_phone}")
    token_id = await create_walk_in_token_direct(
        restaurant_id=restaurant_id,
        name=customer_name,
        phone=customer_phone,
        token_type="scheduled_takeaway",
        pax=1,
        meta=meta,
    )
    if token_id:
        await _rebroadcast_portal_token(restaurant_id, token_id)
    return token_id


async def _notify_manager_scheduled_takeaway(
    restaurant_id: str,
    token_id: str,
    customer_name: str,
    customer_phone: str,
    meta: dict | None = None,
    *,
    manager_phone: str | None = None,
) -> None:
    """Manager WhatsApp when a scheduled takeaway order awaits approval."""
    from tools.restaurant_config import get_manager_phone

    alert_phone = (manager_phone or "").strip()
    if not alert_phone:
        alert_phone = (await get_manager_phone(restaurant_id) or "").strip()
    if not alert_phone:
        logger.error(
            f"[scheduled-takeaway-alert] No manager phone for restaurant {restaurant_id} "
            f"(token {token_id})"
        )
        return

    meta = meta or {}
    sched_at = meta.get("scheduled_at_label") or meta.get("scheduled_at") or "—"
    kitchen_at = meta.get("kitchen_start_at_label") or meta.get("kitchen_start_at") or "—"
    total = meta.get("total")
    total_label = f"₹{float(total):.0f}" if total is not None else "—"
    order_text = str(meta.get("order_text") or "—")[:120]
    portal_url = (
        f"{_os.getenv('FRONTEND_URL', 'https://app.autom8.works').rstrip('/')}"
        "/dashboard/manager"
    )

    body = (
        f"🥡 *Scheduled take-away* — Token *{token_id}*\n"
        f"👤 {customer_name}\n"
        f"📱 {customer_phone or '—'}\n"
        f"🕐 Pickup at: *{sched_at}*\n"
        f"👨‍🍳 Kitchen start: *{kitchen_at}*\n"
        f"💰 {total_label}\n\n"
        f"Order: {order_text}\n\n"
        f"Approve before the customer pays.\n\n"
        f"Portal: {portal_url}"
    )
    try:
        from tools.whatsapp_buttons_helper import send_whatsapp_buttons

        ok = await send_whatsapp_buttons(
            to=alert_phone,
            body=body,
            buttons=[
                {"id": f"SCHED_APPROVE_{token_id}", "title": "✅ Approve"},
                {"id": f"SCHED_REJECT_{token_id}", "title": "❌ Reject"},
            ],
            restaurant_id=restaurant_id,
            footer="Manager Portal — Pending approval",
        )
        if not ok:
            await send_whatsapp_message(alert_phone, body, restaurant_id)
        logger.info(f"[scheduled-takeaway-alert] ✅ {token_id} → manager {alert_phone}")
    except Exception as e:
        logger.error(f"[scheduled-takeaway-alert] failed for {token_id}: {e}")
        try:
            await send_whatsapp_message(alert_phone, body, restaurant_id)
        except Exception as e2:
            logger.error(f"[scheduled-takeaway-alert] plain-text fallback failed: {e2}")


async def approve_scheduled_takeaway_token(restaurant_id: str, token_id: str) -> dict[str, Any]:
    """Manager approved a scheduled takeaway via WhatsApp button."""
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
            logger.info(f"[scheduled-takeaway] approved {token_id}")
            return {"ok": True, "token": data.get("token")}
        if resp.status == 409:
            logger.info(f"[scheduled-takeaway] approve skipped — already handled ({token_id})")
            return {"ok": True, "already_handled": True}
        body = (await resp.text())[:300]
        logger.error(f"[scheduled-takeaway] approve failed {resp.status}: {body}")
        return {"ok": False, "error": body}
    except Exception as e:
        logger.error(f"[scheduled-takeaway] approve error: {e}")
        return {"ok": False, "error": str(e)}


async def reject_scheduled_takeaway_token(restaurant_id: str, token_id: str) -> dict[str, Any]:
    """Manager rejected a scheduled takeaway via WhatsApp button."""
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
            logger.info(f"[scheduled-takeaway] rejected {token_id}")
            return {"ok": True, "token": data.get("token")}
        if resp.status == 409:
            logger.info(f"[scheduled-takeaway] reject skipped — already handled ({token_id})")
            return {"ok": False, "error": "already_handled"}
        body = (await resp.text())[:300]
        logger.error(f"[scheduled-takeaway] reject failed {resp.status}: {body}")
        return {"ok": False, "error": body}
    except Exception as e:
        logger.error(f"[scheduled-takeaway] reject error: {e}")
        return {"ok": False, "error": str(e)}


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
    booking_id: str | None = None,
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
        if booking_id:
            payload["booking_id"] = booking_id
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
                    expected = len(items)
                    kds_added = int(data.get("kds_items_added", 0))
                    if data.get("deduplicated"):
                        if kds_added > 0:
                            logger.info(
                                f"[kds-notify] ♻️ idempotent retry OK ({kds_added} line(s)) "
                                f"for token {token_number} | order {data.get('order_id')}"
                            )
                            return data.get("order_id")
                        logger.error(
                            f"[kds-notify] attempt {attempt + 1}/3 — dedup blocked new items "
                            f"for token {token_number} (expected {expected}) | {data}"
                        )
                        if attempt < 2:
                            await asyncio.sleep(0.75 * (attempt + 1))
                        continue
                    if kds_added <= 0:
                        kds_added = int(data.get("kds_items_created") or 0)
                    if kds_added <= 0 or kds_added < expected:
                        logger.error(
                            f"[kds-notify] attempt {attempt + 1}/3 — expected {expected} new KDS line(s) "
                            f"but got {kds_added} for token {token_number} | restaurant {restaurant_id} | {data}"
                        )
                        if attempt < 2:
                            await asyncio.sleep(0.75 * (attempt + 1))
                        continue
                    logger.info(
                        f"[kds-notify] ✅ {kds_added} item(s) created for token {token_number} | "
                        f"table {table_number} | order {data.get('order_id', '?')} | "
                        f"restaurant {restaurant_id}"
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
# PRIMARY: BRANDED WEB MENU BOOKING
# ─────────────────────────────────────────────

def _slugify_subdomain(name: str) -> str:
    raw = ''.join(ch.lower() if ch.isalnum() else '-' for ch in str(name or '').strip())
    clean = '-'.join(part for part in raw.split('-') if part)
    return clean or 'restaurant'


def _service_label_and_icon(session_state: dict[str, Any]) -> tuple[str, str]:
    service = str(session_state.get('service_type') or '').strip().lower()
    mode = str(session_state.get('order_mode') or '').strip().lower()
    if service == 'dine_in':
        return 'Dine-in Now', '🍽️'
    if service == 'takeaway':
        return ('Scheduled Pickup', '📅') if mode == 'scheduled' else ('Takeaway Now', '🥡')
    if service == 'delivery':
        return ('Scheduled Delivery', '📅') if mode == 'scheduled' else ('Home Delivery', '🛵')
    if service == 'reserve_table':
        return 'Table Reservation', '🪑'
    return 'Order Now', '🍽️'


def _normalize_phone_digits(phone: str) -> str:
    digits = ''.join(c for c in str(phone or '') if c.isdigit())
    if digits.startswith('91') and len(digits) == 12:
        return digits[2:]
    return digits


def _build_web_menu_url(slug: str, token: str, phone_digits: str) -> str:
    """
    Build the branded web-menu URL as {slug}.autom8.works/menu?token=...&phone=...
    `webcart.js` resolves the restaurant from the subdomain (readHostSlug),
    so no slug query param is needed on the live domain. WEB_MENU_BASE_URL
    can still override the whole base (e.g. for local/staging testing where
    wildcard subdomains aren't set up).
    """
    override = _os.getenv("WEB_MENU_BASE_URL")
    if override:
        base = override.rstrip("/")
        return f"{base}/menu?slug={slug}&token={token}&phone={phone_digits}"

    domain = _os.getenv("WEB_MENU_DOMAIN", "autom8.works").strip().lstrip(".")
    return f"https://{slug}.{domain}/menu?token={token}&phone={phone_digits}"


def _expected_menu_walk_in_type(session_state: dict[str, Any]) -> str:
    """Walk-in token type that matches the customer's selected service/mode."""
    service = str(session_state.get("service_type") or "").strip().lower()
    mode = str(session_state.get("order_mode") or "").strip().lower()
    if service == "dine_in":
        return "dinein"
    if service == "delivery":
        return "scheduled_delivery" if mode == "scheduled" else "takeaway"
    if service == "takeaway":
        return "scheduled_takeaway" if mode == "scheduled" else "takeaway"
    return "takeaway"


async def _resolve_menu_walk_in_token(
    restaurant_id: str,
    customer_phone: str,
    session_state: dict[str, Any],
) -> tuple[str | None, bool]:
    """
    Return (token_id, is_real_walk_row) for the web-menu link.

    Never reuse an active token of the wrong type (e.g. leftover takeaway while
    the customer is on scheduled delivery) — that made webcart treat scheduled
    orders as immediate takeaway and skip manager approval / KDS deferral.
    """
    from tools.db_tools import get_walk_in_token_by_id

    expected = _expected_menu_walk_in_type(session_state)
    meta = {
        "source": "web_menu_link",
        "service_type": session_state.get("service_type"),
        "order_mode": session_state.get("order_mode"),
        "scheduled_at": session_state.get("scheduled_at"),
    }

    async def _refresh_meta(tid: str) -> None:
        try:
            import json
            from sqlalchemy import text
            from tools.db_tools import AsyncSessionLocal, parse_walk_in_meta

            if AsyncSessionLocal is None:
                return
            existing = await get_walk_in_token_by_id(restaurant_id, tid)
            prev = parse_walk_in_meta((existing or {}).get("meta"))
            merged = {**prev, **{k: v for k, v in meta.items() if v is not None}}
            async with AsyncSessionLocal() as session:
                await session.execute(
                    text("""
                        UPDATE walk_in_tokens
                        SET meta = CAST(:meta AS jsonb)
                        WHERE id = :tid AND restaurant_id = CAST(:rid AS uuid)
                    """),
                    {
                        "tid": tid,
                        "rid": restaurant_id,
                        "meta": json.dumps(merged),
                    },
                )
                await session.commit()
        except Exception as exc:
            logger.warning(f"[BOOKING] menu token meta refresh failed for {tid}: {exc}")

    candidates: list[str] = []
    for key in ("menu_session_token", "token_number", "display_token"):
        raw = session_state.get(key)
        if raw and str(raw) not in candidates:
            candidates.append(str(raw))

    for tid in candidates:
        walk = await get_walk_in_token_by_id(restaurant_id, tid)
        if (
            walk
            and walk.get("type") == expected
            and walk.get("status") in ("seated", "takeaway", "waiting", "pending_approval")
        ):
            await _refresh_meta(str(walk["id"]))
            return str(walk["id"]), True

    walk = await get_active_walk_in_token(restaurant_id, customer_phone)
    if walk and walk.get("type") == expected and walk.get("id"):
        await _refresh_meta(str(walk["id"]))
        return str(walk["id"]), True

    # Drop leftover tokens of a different service (e.g. old takeaway while
    # starting scheduled delivery) so webcart cannot resolve the wrong type.
    if walk and walk.get("id") and walk.get("type") != expected:
        try:
            from tools.db_tools import supersede_walk_in_token
            await supersede_walk_in_token(
                restaurant_id,
                str(walk["id"]),
                reason=f"replaced_by_menu_{expected}",
            )
        except Exception as exc:
            logger.warning(
                f"[BOOKING] could not supersede leftover token {walk.get('id')}: {exc}"
            )

    created_id = await create_walk_in_token_direct(
        restaurant_id=restaurant_id,
        name=session_state.get("customer_name") or "WhatsApp Guest",
        phone=customer_phone,
        token_type=expected,
        pax=int(session_state.get("pax") or 1),
        meta=meta,
    )
    if created_id:
        return created_id, True

    logger.error(
        "[BOOKING] %s → could not create walk_in_tokens row type=%s; "
        "menu link will rely on phone-based session lookup only",
        customer_phone,
        expected,
    )
    return uuid4().hex, False


async def _send_web_menu_message(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
    *,
    intro: str | None = None,
) -> bool:
    """Generate menu token + send branded web menu message; graceful no-link fallback on errors.

    `intro` lets a caller fold a short lead-in line (e.g. "Thank you! Browse
    today's menu below 🛒") into the same message as the CTA button, instead
    of sending it as a separate WhatsApp message beforehand.
    """
    restaurant = await get_restaurant_by_id(restaurant_id)
    display_name = (restaurant or {}).get('name') or 'Munafe'
    slug = _slugify_subdomain(display_name)
    service_label, service_icon = _service_label_and_icon(session_state)
    phone_digits = _normalize_phone_digits(customer_phone)

    token_id, token_id_is_real_walk_row = await _resolve_menu_walk_in_token(
        restaurant_id, customer_phone, session_state,
    )

    try:
        # Only pass walk_in_token_id when token_id genuinely refers to a
        # walk_in_tokens row — it's a foreign key, so passing the
        # session-only uuid4 fallback above would throw a FK violation
        # and crash the whole send (which is exactly what was happening).
        walk_token_id = token_id if token_id_is_real_walk_row else None

        # The walk_in_tokens id (token_id, e.g. "T-2606-136") is the
        # staff/KDS-facing display token — it's sequential and predictable
        # by design (so floor staff can call out "Token 136"). It must
        # NEVER be reused as the public URL token: anyone could enumerate
        # T-2606-001, 002, 003... and view (or submit into) other
        # customers' carts. So we mint a separate, cryptographically
        # random session_token here purely for the URL/menu_tokens row,
        # and keep walk_in_token_id as the FK back to the real display
        # token. Reuse the same random token across repeated sends within
        # one WA session so we don't invalidate a link the customer may
        # still have open in their browser.
        url_token = session_state.get('menu_url_session_token')
        if not url_token:
            url_token = secrets.token_urlsafe(16)
            session_state['menu_url_session_token'] = url_token

        await create_menu_link_token(
            restaurant_id=restaurant_id,
            customer_phone=phone_digits or customer_phone,
            session_token=url_token,
            walk_in_token_id=str(walk_token_id) if walk_token_id else None,
            expires_in_hours=24,
        )
        if token_id_is_real_walk_row:
            session_state['menu_session_token'] = str(token_id)

        url = _build_web_menu_url(slug, url_token, phone_digits)
        body_text = (
            f"📍 {display_name}\n"
            f"{service_icon} {service_label}\n\n"
            "Tap the button below to browse our full menu with search "
            "and easy selection. Add items to your cart and submit when ready!"
        )
        if intro and intro.strip():
            body_text = f"{intro.strip()}\n\n{body_text}"

        cta_sent = await send_whatsapp_cta_url(
            customer_phone,
            restaurant_id,
            body_text=body_text,
            button_text="View Menu",
            url=url,
            header_text="🍽️ Browse Our Menu",
        )
        if cta_sent:
            return True

        # Fallback: plain-text link if the CTA button send fails
        # (e.g. older template/account restrictions).
        message = (
            "🍽️ Browse Our Menu\n"
            f"📍 {display_name}\n"
            f"{service_icon} {service_label}\n\n"
            "Tap the button below to browse our full menu with search "
            "and easy selection. Add items to your cart and submit when ready!\n\n"
            "👉 View Menu\n"
            f"{url}"
        )
        if intro and intro.strip():
            message = f"{intro.strip()}\n\n{message}"
        await send_whatsapp_message(customer_phone, message, restaurant_id)
        logger.info(f"[BOOKING] {customer_phone} → Web menu sent ({url})")
        return True
    except Exception:
        logger.exception("[BOOKING] %s → Web menu token generation failed", customer_phone)
        fallback = (
            "🍽️ Browse Our Menu\n"
            f"📍 {display_name}\n"
            f"{service_icon} {service_label}\n\n"
            "Tap the button below to browse our full menu with search "
            "and easy selection. Add items to your cart and submit when ready!\n"
            "Reply Hi in a moment and we'll get your menu ready."
        )
        await send_whatsapp_message(customer_phone, fallback, restaurant_id)
        return False


# ─────────────────────────────────────────────
# UNIFIED BOOKING MENU
# Deterministic web-menu channel
# Used by flow modules as send_catalog_with_fallback
# ─────────────────────────────────────────────

async def send_unified_booking_menu(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
    *,
    intro: str | None = None,
) -> MechanismType:
    """Send deterministic web-menu message for all booking entry points.

    Pass `intro` to fold a short lead-in line into the same message as the
    menu CTA, instead of sending it as a separate message beforehand.
    """
    logger.info(f"[BOOKING] send_unified_booking_menu called for {customer_phone}")

    session_state["restaurant_id"] = restaurant_id

    sent = await _send_web_menu_message(customer_phone, restaurant_id, session_state, intro=intro)
    session_state["booking_mechanism"] = "web_menu"
    session_state["booking_mechanism_order_source"] = "web_menu"
    if session_state.get("service_type") in ("dine_in", "takeaway", "delivery", "reserve_table"):
        session_state["booking_step"] = "awaiting_order"
    return "web_menu" if sent else "none"


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

    cart = session_state.get("cart") or {}
    for item_line in items:
        item_id = item_line["id"]
        line = {
            "title":      item_line["title"],
            "qty":        item_line["qty"],
            "unit_price": item_line["unit_price"],
        }
        if item_id in cart:
            cart[item_id]["qty"] = int(cart[item_id].get("qty", 0)) + int(line["qty"])
        else:
            cart[item_id] = line

    await enrich_cart_titles(cart, restaurant_id)
    session_state["cart"] = cart
    session_state["booking_mechanism_order_source"] = "catalog"
    session_state["booking_step"] = "awaiting_cart_action"

    logger.info(
        f"Catalog order merged into cart: +{len(items)} line(s), "
        f"{len(cart)} unique item(s), session total ₹{sum(v['qty']*v['unit_price'] for v in cart.values()):.0f}"
    )
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
