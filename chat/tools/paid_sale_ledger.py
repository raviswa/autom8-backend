"""Durable paid-sale ledger writer (Python side).

Mirrors Node src/helpers/paidSaleLedger.js so WhatsApp/Razorpay/PhonePe
mark-paid paths record item spend + GST even when KDS never runs.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

DEFAULT_GST_RATE = 5.0


def _a8_base() -> str:
    return os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")


def _a8_headers() -> dict:
    key = os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def _calculate_gst(subtotal: float, rate_percent: float = DEFAULT_GST_RATE) -> dict[str, float]:
    rate = float(rate_percent or DEFAULT_GST_RATE)
    half = rate / 2.0
    cgst = round(subtotal * half / 100.0, 2)
    sgst = round(subtotal * half / 100.0, 2)
    total_tax = round(cgst + sgst, 2)
    grand_unrounded = round(subtotal + total_tax, 2)
    grand_total = float(round(grand_unrounded))
    return {
        "cgst_amount": cgst,
        "sgst_amount": sgst,
        "igst_amount": 0.0,
        "gst_amount": total_tax,
        "gst_rate": rate,
        "grand_total": grand_total,
    }


def _lines_from_cart(cart: Any) -> list[dict[str, Any]]:
    if not cart:
        return []
    if isinstance(cart, list):
        entries = [(str(i), line) for i, line in enumerate(cart)]
    elif isinstance(cart, dict):
        # Nested {items: [...]} shape
        if "items" in cart and isinstance(cart["items"], list):
            entries = [(str(i), line) for i, line in enumerate(cart["items"])]
        else:
            entries = list(cart.items())
    else:
        return []

    lines: list[dict[str, Any]] = []
    for sku, line in entries:
        if not isinstance(line, dict):
            continue
        qty = float(line.get("qty") or line.get("quantity") or 1)
        unit = float(line.get("unit_price") or line.get("price") or 0)
        if qty <= 0:
            continue
        name = str(line.get("title") or line.get("name") or line.get("item_name") or sku or "Item").strip() or "Item"
        lines.append({
            "menu_item_id": line.get("menu_item_id"),
            "item_name": name,
            "item_sku": str(line.get("retailer_id") or sku or ""),
            "quantity": qty,
            "unit_price": unit,
            "line_total": round(qty * unit, 2),
        })
    return lines


def _sum_lines(lines: list[dict[str, Any]]) -> float:
    return round(sum(float(l.get("line_total") or 0) for l in lines), 2)


async def _existing_sale(client: httpx.AsyncClient, base: str, *, booking_id: str | None = None, order_id: str | None = None) -> dict | None:
    params: dict[str, str] = {"select": "id", "limit": "1"}
    if booking_id:
        params["booking_id"] = f"eq.{booking_id}"
    elif order_id:
        params["order_id"] = f"eq.{order_id}"
    else:
        return None
    resp = await client.get(f"{base}/rest/v1/paid_sales", headers=_a8_headers(), params=params)
    if resp.status_code >= 400:
        return None
    rows = resp.json() or []
    return rows[0] if rows else None


async def record_paid_sale_from_booking(booking: dict[str, Any]) -> dict[str, Any]:
    """Insert paid_sales + paid_sale_items for a paid booking. Idempotent."""
    base = _a8_base()
    if not base:
        return {"ok": False, "error": "AUTOM8_SUPABASE_URL not set"}

    booking_id = str(booking.get("id") or "")
    restaurant_id = str(booking.get("restaurant_id") or "")
    if not booking_id or not restaurant_id:
        return {"ok": False, "error": "booking id/restaurant_id required"}

    meta = booking.get("schedule_meta") if isinstance(booking.get("schedule_meta"), dict) else {}
    bmeta = booking.get("meta") if isinstance(booking.get("meta"), dict) else {}
    prepay = bmeta.get("prepay_fulfillment_payload") or meta.get("prepay_fulfillment_payload") or {}
    if isinstance(prepay, str):
        prepay = {}

    cart = (
        meta.get("cart")
        or bmeta.get("cart")
        or (prepay.get("cart") if isinstance(prepay, dict) else None)
        or (prepay.get("cart_snapshot") if isinstance(prepay, dict) else None)
        or {}
    )
    lines = _lines_from_cart(cart)
    subtotal = _sum_lines(lines)
    if subtotal <= 0:
        for key in (
            meta.get("total"),
            (meta.get("totals") or {}).get("total") if isinstance(meta.get("totals"), dict) else None,
            (meta.get("totals") or {}).get("grand_total") if isinstance(meta.get("totals"), dict) else None,
            booking.get("order_subtotal"),
            bmeta.get("total"),
            bmeta.get("grand_total"),
            (prepay.get("total") if isinstance(prepay, dict) else None),
        ):
            try:
                n = float(key or 0)
            except (TypeError, ValueError):
                n = 0.0
            if n > 0:
                subtotal = n
                break

    if subtotal <= 0:
        return {"ok": False, "error": "no subtotal/lines for booking"}

    delivery = 0.0
    try:
        delivery = float(
            meta.get("delivery_charge")
            or bmeta.get("delivery_charge")
            or ((bmeta.get("web_cart_submission") or {}).get("delivery_charge") if isinstance(bmeta.get("web_cart_submission"), dict) else 0)
            or 0
        )
    except (TypeError, ValueError):
        delivery = 0.0

    gst = _calculate_gst(subtotal, DEFAULT_GST_RATE)
    gst["delivery_charge"] = delivery
    gst["grand_total"] = float(round(gst["grand_total"] + delivery, 2))

    customer = booking.get("customer") if isinstance(booking.get("customer"), dict) else {}
    paid_at = booking.get("updated_at") or booking.get("created_at")

    header = {
        "restaurant_id": restaurant_id,
        "lob_type": booking.get("lob_type"),
        "booking_id": booking_id,
        "order_id": meta.get("order_id") or bmeta.get("order_id"),
        "customer_phone": customer.get("phone") or booking.get("customer_phone"),
        "customer_name": customer.get("name") or booking.get("customer_name"),
        "service_type": booking.get("service_type"),
        "token_number": str(booking.get("token_number") or "") or None,
        "subtotal": subtotal,
        "currency": "INR",
        "paid_at": paid_at,
        **{k: gst[k] for k in ("gst_rate", "cgst_amount", "sgst_amount", "igst_amount", "gst_amount", "delivery_charge", "grand_total")},
    }

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            existing = await _existing_sale(client, base, booking_id=booking_id)
            if existing:
                return {"ok": True, "skipped": True, "sale_id": existing.get("id")}

            resp = await client.post(
                f"{base}/rest/v1/paid_sales",
                headers={**_a8_headers(), "Prefer": "return=representation"},
                json=header,
            )
            if resp.status_code >= 400:
                # Unique race
                if resp.status_code in (409, 23505) or "duplicate" in (resp.text or "").lower():
                    return {"ok": True, "skipped": True}
                logger.warning("[paid-sale-ledger] insert failed: %s %s", resp.status_code, resp.text[:300])
                return {"ok": False, "error": resp.text[:300]}

            sale_rows = resp.json() or []
            sale = sale_rows[0] if sale_rows else {}
            sale_id = sale.get("id")
            if sale_id and lines:
                item_rows = [
                    {
                        "paid_sale_id": sale_id,
                        "restaurant_id": restaurant_id,
                        "menu_item_id": ln.get("menu_item_id"),
                        "item_name": ln.get("item_name") or "Item",
                        "item_sku": ln.get("item_sku"),
                        "quantity": ln.get("quantity") or 1,
                        "unit_price": ln.get("unit_price") or 0,
                        "line_total": ln.get("line_total") or 0,
                        "paid_at": paid_at,
                    }
                    for ln in lines
                ]
                items_resp = await client.post(
                    f"{base}/rest/v1/paid_sale_items",
                    headers={**_a8_headers(), "Prefer": "return=minimal"},
                    json=item_rows,
                )
                if items_resp.status_code >= 400:
                    logger.warning("[paid-sale-ledger] items insert failed: %s", items_resp.text[:300])

            return {"ok": True, "sale_id": sale_id, "grand_total": header["grand_total"]}
    except Exception as e:
        logger.warning("[paid-sale-ledger] exception: %s", e)
        return {"ok": False, "error": str(e)}
