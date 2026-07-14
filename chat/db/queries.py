"""Database query functions for Munafe Supply.

All functions use the Supabase REST API (httpx) — no SQLAlchemy models needed
for supply tables, keeping this module independent from db/models.py.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

import httpx

from config.settings import settings

logger = logging.getLogger(__name__)


# ─── Supabase REST helpers ────────────────────────────────────────────────────

def _headers(prefer: str = "return=representation") -> dict:
    key = settings.autom8_supabase_service_key or ""
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": prefer,
    }


def _url(table: str) -> str:
    base = (settings.autom8_supabase_url or "").rstrip("/")
    return f"{base}/rest/v1/{table}"


# ─── Public query functions ───────────────────────────────────────────────────

def _phone_variants(phone: str) -> list[str]:
    digits = ''.join(c for c in str(phone or '') if c.isdigit())
    if not digits:
        return []
    variants = [digits]
    if len(digits) == 10:
        variants.append(f'91{digits}')
    if len(digits) > 10:
        variants.append(digits[-10:])
    if digits.startswith('91') and len(digits) == 12:
        variants.append(digits[2:])
    return list(dict.fromkeys(variants))


async def get_client_by_phone(supplier_id: str, phone: str) -> Optional[dict]:
    """
    Look up a supply client by supplier + phone.
    Returns a dict with at minimum {'id': str, 'name': str, 'phone': str}
    or None if not found / inactive.
    """
    variants = _phone_variants(phone)
    if not variants:
        return None

    async with httpx.AsyncClient(timeout=10) as client:
        for variant in variants:
            resp = await client.get(
                _url("supply_clients"),
                headers=_headers(),
                params={
                    "supplier_id": f"eq.{supplier_id}",
                    "phone":       f"eq.{variant}",
                    "is_active":   "eq.true",
                    "select":      "id,name,phone",
                    "limit":       "1",
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                if data:
                    return data[0]
            else:
                logger.error(
                    f"[queries] get_client_by_phone HTTP {resp.status_code}: {resp.text[:200]}"
                )
                return None
    return None


async def get_supply_client_by_restaurant_id(restaurant_id: str) -> Optional[dict]:
    """
    Bridge lookup for the shared-WABA testing path: given a Munafe
    tenant/restaurant id (a "supply" lob_type tenant acting as a client),
    resolve the real supply_clients row — and therefore the real
    supplier_id — via supply_clients.munafe_restaurant_id.

    Returns {'id': <supply_clients.id>, 'supplier_id': <suppliers.id>} or
    None if this restaurant hasn't been registered as a client of any
    supplier yet.

    NOTE: assumes one supplier per restaurant for now (limit=1). If a
    restaurant is ever linked to multiple suppliers, this needs a
    disambiguation step (e.g. keyed by which supplier's WABA the
    conversation is pinned to).
    """
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _url("supply_clients"),
            headers=_headers(),
            params={
                "munafe_restaurant_id": f"eq.{restaurant_id}",
                "is_active":            "eq.true",
                "select":               "id,supplier_id",
                "limit":                "1",
            },
        )
    if resp.status_code == 200:
        data = resp.json()
        return data[0] if data else None
    logger.error(
        f"[queries] get_supply_client_by_restaurant_id HTTP {resp.status_code}: {resp.text[:200]}"
    )
    return None


async def get_supply_session(supplier_id: str, phone: str) -> dict:
    """
    Fetch the current conversation state for a supplier+phone pair.
    Returns an empty dict when no session exists yet.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _url("supply_conversation_states"),
            headers=_headers(),
            params={
                "supplier_id": f"eq.{supplier_id}",
                "phone":       f"eq.{phone}",
                "select":      "state",
                "limit":       "1",
            },
        )
    if resp.status_code == 200:
        data = resp.json()
        return (data[0].get("state") or {}) if data else {}
    logger.error(f"[queries] get_supply_session HTTP {resp.status_code}: {resp.text[:200]}")
    return {}


async def save_supply_session(
    supplier_id: str,
    phone: str,
    client_id: Optional[str],
    session: dict,
) -> None:
    """
    Upsert the conversation state for a supplier+phone pair.
    The table must have a UNIQUE constraint on (supplier_id, phone).
    """
    payload = {
        "supplier_id": supplier_id,
        "phone":       phone,
        "client_id":   client_id,
        "state":       session,
        "updated_at":  datetime.now(timezone.utc).isoformat(),
    }
    headers = _headers(prefer="resolution=merge-duplicates,return=minimal")
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_url("supply_conversation_states"), headers=headers, json=payload)
    if resp.status_code not in (200, 201):
        logger.error(f"[queries] save_supply_session HTTP {resp.status_code}: {resp.text[:200]}")


async def get_client_outstanding(supplier_id: str, client_id: str) -> float:
    """
    Return the current outstanding balance for a client in rupees.

    Matches Node ledger.getCurrentBalance:
      1) latest supply_credit_ledger.balance_after
      2) else SUM(debits) − SUM(credits)
    """
    async with httpx.AsyncClient(timeout=10) as client:
        latest = await client.get(
            _url("supply_credit_ledger"),
            headers=_headers(),
            params={
                "client_id": f"eq.{client_id}",
                "select":    "balance_after",
                "order":     "created_at.desc",
                "limit":     "1",
            },
        )
        if latest.status_code == 200:
            rows = latest.json()
            if rows:
                return float(rows[0].get("balance_after") or 0)

        debits_resp = await client.get(
            _url("supply_credit_ledger"),
            headers=_headers(),
            params={
                "client_id": f"eq.{client_id}",
                "type":      "eq.debit",
                "select":    "amount",
            },
        )
        credits_resp = await client.get(
            _url("supply_credit_ledger"),
            headers=_headers(),
            params={
                "client_id": f"eq.{client_id}",
                "type":      "eq.credit",
                "select":    "amount",
            },
        )

    if debits_resp.status_code != 200 or credits_resp.status_code != 200:
        logger.error(
            f"[queries] get_client_outstanding fallback failed "
            f"debits={debits_resp.status_code} credits={credits_resp.status_code}"
        )
        return 0.0

    total_debits = sum(float(r.get("amount", 0) or 0) for r in debits_resp.json())
    total_credits = sum(float(r.get("amount", 0) or 0) for r in credits_resp.json())
    return total_debits - total_credits


async def get_client_latest_order(supplier_id: str, client_id: str) -> Optional[dict]:
    """Return the most recent non-cancelled order for a client, or None."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _url("supply_orders"),
            headers=_headers(),
            params={
                "supplier_id": f"eq.{supplier_id}",
                "client_id":   f"eq.{client_id}",
                "status":      "neq.cancelled",
                "select":      "order_number,delivery_date,status,total_amount",
                "order":       "created_at.desc",
                "limit":       "1",
            },
        )
    if resp.status_code == 200:
        rows = resp.json()
        return rows[0] if rows else None
    logger.error(f"[queries] get_client_latest_order HTTP {resp.status_code}: {resp.text[:200]}")
    return None


async def get_supplier_phone(supplier_id: str) -> Optional[str]:
    """Return suppliers.phone for WhatsApp alerts, or None."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _url("suppliers"),
            headers=_headers(),
            params={
                "id":     f"eq.{supplier_id}",
                "select": "phone",
                "limit":  "1",
            },
        )
    if resp.status_code == 200:
        rows = resp.json()
        if rows and rows[0].get("phone"):
            return str(rows[0]["phone"])
    else:
        logger.error(f"[queries] get_supplier_phone HTTP {resp.status_code}: {resp.text[:200]}")
    return None


async def create_payment_claim(
    supplier_id: str,
    client_id: str,
    claimed_amount: float,
    method: str,
    reference: Optional[str],
    raw_message: str,
) -> Optional[dict]:
    """
    Insert a pending payment claim.
    Returns the created record dict on success, None on failure.
    """
    payload = {
        "supplier_id":    supplier_id,
        "client_id":      client_id,
        "claimed_amount": claimed_amount,
        "method":         method,
        "reference":      reference,
        "raw_message":    raw_message,
        "status":         "pending",
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_url("supply_payment_claims"), headers=_headers(), json=payload)
    if resp.status_code in (200, 201):
        data = resp.json()
        return (data[0] if isinstance(data, list) else data) or {}
    logger.error(f"[queries] create_payment_claim HTTP {resp.status_code}: {resp.text[:200]}")
    return None


async def log_supply_notification(
    supplier_id: str,
    client_id: Optional[str],
    template_name: str,
    phone: str,
    direction: str = "outbound",
    status: str = "sent",
    wa_message_id: Optional[str] = None,
    error_message: Optional[str] = None,
    payload: Optional[dict] = None,
) -> None:
    """
    Fire-and-forget log of every outbound/inbound supply WhatsApp notification.
    Failures are logged but never raised — callers must not depend on this.
    """
    row = {
        "supplier_id":   supplier_id,
        "client_id":     client_id,
        "template_name": template_name,
        "phone":         phone,
        "direction":     direction,
        "status":        status,
        "wa_message_id": wa_message_id,
        "error_message": error_message,
        "payload":       payload or {},
    }
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.post(
                _url("supply_notifications"),
                headers=_headers(prefer="return=minimal"),
                json=row,
            )
        if resp.status_code not in (200, 201):
            logger.warning(f"[queries] log_supply_notification HTTP {resp.status_code}")
    except Exception as exc:
        logger.warning(f"[queries] log_supply_notification failed: {exc}")


async def get_last_supply_order(supplier_id: str, client_id: str) -> Optional[dict]:
    """
    Fetch this client's most recent supply order, including its line items —
    used by the "reorder my last order" WhatsApp flow.

    Returns a dict shaped like:
        {
            "id": str,
            "order_number": str,
            "delivery_date": str,      # ISO date
            "status": str,
            "total_amount": float,
            "gst_amount": float,
            "delivery_notes": str | None,
            "created_at": str,         # ISO timestamp
            "items": [
                {
                    "item_id": str | None,
                    "item_name": str,
                    "unit": str,
                    "unit_price": float,
                    "qty_ordered": float,
                    "line_total": float,
                },
                ...
            ],
        }
    or None if this client has never placed an order (or on lookup failure).

    NOTE: this fetches the latest order regardless of status (including
    cancelled ones) so "reorder my last order" always has something to
    repeat. If a caller needs to exclude cancelled orders, add
    "status": "neq.cancelled" to the params below.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        order_resp = await client.get(
            _url("supply_orders"),
            headers=_headers(),
            params={
                "supplier_id": f"eq.{supplier_id}",
                "client_id":   f"eq.{client_id}",
                "select":      "id,order_number,delivery_date,status,total_amount,gst_amount,delivery_notes,created_at",
                "order":       "created_at.desc",
                "limit":       "1",
            },
        )
        if order_resp.status_code != 200:
            logger.error(
                f"[queries] get_last_supply_order (orders) HTTP {order_resp.status_code}: "
                f"{order_resp.text[:200]}"
            )
            return None

        orders = order_resp.json()
        if not orders:
            return None
        order = orders[0]

        items_resp = await client.get(
            _url("supply_order_items"),
            headers=_headers(),
            params={
                "order_id": f"eq.{order['id']}",
                "select":   "item_id,item_name,unit,unit_price,qty_ordered,line_total",
            },
        )
        if items_resp.status_code != 200:
            logger.error(
                f"[queries] get_last_supply_order (items) HTTP {items_resp.status_code}: "
                f"{items_resp.text[:200]}"
            )
            order["items"] = []
            return order

        order["items"] = items_resp.json()
        return order
