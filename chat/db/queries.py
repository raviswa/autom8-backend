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

async def get_client_by_phone(supplier_id: str, phone: str) -> Optional[dict]:
    """
    Look up a supply client by supplier + phone.
    Returns a dict with at minimum {'id': str, 'name': str, 'phone': str}
    or None if not found / inactive.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _url("supply_clients"),
            headers=_headers(),
            params={
                "supplier_id": f"eq.{supplier_id}",
                "phone":       f"eq.{phone}",
                "is_active":   "eq.true",
                "select":      "id,name,phone",
                "limit":       "1",
            },
        )
    if resp.status_code == 200:
        data = resp.json()
        return data[0] if data else None
    logger.error(f"[queries] get_client_by_phone HTTP {resp.status_code}: {resp.text[:200]}")
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
        resp = await client.post(
            _url("supply_conversation_states"),
            headers=headers,
            params={"on_conflict": "supplier_id,phone"},
            json=payload,
        )
    if resp.status_code not in (200, 201):
        logger.error(f"[queries] save_supply_session HTTP {resp.status_code}: {resp.text[:200]}")


async def get_client_outstanding(supplier_id: str, client_id: str) -> float:
    """
    Return the total outstanding (unpaid) balance for a client in rupees.
    Sums the 'amount' column of supply_statements where status='unpaid'.
    """
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _url("supply_statements"),
            headers=_headers(),
            params={
                "supplier_id": f"eq.{supplier_id}",
                "client_id":   f"eq.{client_id}",
                "status":      "eq.unpaid",
                "select":      "amount",
            },
        )
    if resp.status_code == 200:
        return sum(float(row.get("amount", 0)) for row in resp.json())
    logger.error(f"[queries] get_client_outstanding HTTP {resp.status_code}: {resp.text[:200]}")
    return 0.0


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
                _url("supply_notification_log"),
                headers=_headers(prefer="return=minimal"),
                json=row,
            )
        if resp.status_code not in (200, 201):
            logger.warning(f"[queries] log_supply_notification HTTP {resp.status_code}")
    except Exception as exc:
        logger.warning(f"[queries] log_supply_notification failed: {exc}")
