# chat/tools/supply_form_token.py
# ============================================================================
# Munafe Supply — Python port of Node supplyFormToken.js + cutoff helper.
# Used by the WhatsApp agent to mint /s/:token order-form links without a
# supplier JWT.
# ============================================================================

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

import httpx

from config.settings import settings

logger = logging.getLogger(__name__)

_IST = ZoneInfo('Asia/Kolkata')
_DEFAULT_SECRET = 'dev_form_signing_secret'
_DEFAULT_BASE_URL = 'https://order.autom8.works'


def _signing_secret() -> str:
    return (
        getattr(settings, 'supply_form_signing_secret', None)
        or os.environ.get('SUPPLY_FORM_SIGNING_SECRET')
        or _DEFAULT_SECRET
    )


def _form_base_url() -> str:
    return (
        getattr(settings, 'supply_form_base_url', None)
        or os.environ.get('SUPPLY_FORM_BASE_URL')
        or _DEFAULT_BASE_URL
    ).rstrip('/')


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def create_form_token(
    supplier_id: str,
    client_id: str,
    valid_until: Optional[datetime] = None,
    permanent: bool = False,
) -> str:
    """
    Create a signed order form token matching Node createFormToken().

    Token format: base64url(payload).base64url(HMAC-SHA256 signature)
    """
    if valid_until is not None:
        expires = int(valid_until.timestamp())
    else:
        expires = int(datetime.now().timestamp()) + 30 * 24 * 60 * 60

    payload = json.dumps(
        {
            'supplier_id': supplier_id,
            'client_id': client_id,
            'expires': expires,
            'permanent': bool(permanent),
        },
        separators=(',', ':'),
    )
    b64 = _b64url_encode(payload.encode('utf-8'))
    sig = _b64url_encode(
        hmac.new(_signing_secret().encode('utf-8'), b64.encode('ascii'), hashlib.sha256).digest()
    )
    return f'{b64}.{sig}'


def get_today_cutoff_date(ordering_cutoff_time: Optional[str] = None) -> datetime:
    """
    Next daily ordering cutoff in IST (same behaviour as clients.js getTodayCutoffDate).
    If cutoff has already passed today, rolls to tomorrow.
    """
    cutoff = ordering_cutoff_time or '22:00:00'
    parts = str(cutoff).split(':')
    hours = int(parts[0]) if parts else 22
    minutes = int(parts[1]) if len(parts) > 1 else 0

    now = datetime.now(_IST)
    valid_until = now.replace(hour=hours, minute=minutes, second=0, microsecond=0)
    if valid_until.timestamp() <= now.timestamp():
        valid_until = valid_until + timedelta(days=1)
    return valid_until


async def get_supplier_ordering_cutoff(supplier_id: str) -> Optional[str]:
    """Fetch suppliers.ordering_cutoff_time; returns None on failure."""
    base = (settings.autom8_supabase_url or '').rstrip('/')
    key = settings.autom8_supabase_service_key or ''
    if not base or not key:
        return None

    headers = {
        'apikey': key,
        'Authorization': f'Bearer {key}',
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f'{base}/rest/v1/suppliers',
            headers=headers,
            params={
                'id': f'eq.{supplier_id}',
                'select': 'ordering_cutoff_time',
                'limit': '1',
            },
        )
    if resp.status_code != 200:
        logger.error(
            f'[supply_form_token] get_supplier_ordering_cutoff HTTP '
            f'{resp.status_code}: {resp.text[:200]}'
        )
        return None
    rows = resp.json()
    if not rows:
        return None
    return rows[0].get('ordering_cutoff_time')


async def build_order_form_url(supplier_id: str, client_id: str) -> str:
    """Mint a daily cutoff token and return the public /s/:token URL."""
    cutoff_time = await get_supplier_ordering_cutoff(supplier_id)
    valid_until = get_today_cutoff_date(cutoff_time)
    token = create_form_token(supplier_id, client_id, valid_until, permanent=False)
    return f'{_form_base_url()}/s/{token}'
