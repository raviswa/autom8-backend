# chat/tools/supply_form_token.py
# ============================================================================
# Munafe Supply — order-form URL minting for the WhatsApp agent.
#
# Prefer POST supply-api /api/supply/form/mint-link so HMAC uses the same
# SUPPLY_FORM_SIGNING_SECRET as GET /api/supply/form/:token validation.
#
# Railway env on autom8-chat (required for working WhatsApp Order links):
#   SUPPLY_API_BASE_URL=https://supply-api.autom8.works
#   SUPPLY_FORM_SIGNING_SECRET   (MUST match autom8-backend supply)
#   AUTOM8_KDS_SECRET            (optional; same as supply-api — preferred mint auth)
#   SUPPLY_FORM_BASE_URL=https://app.autom8.works
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
_DEFAULT_BASE_URL = 'https://app.autom8.works'
_DEFAULT_SUPPLY_API = 'https://supply-api.autom8.works'


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


def _supply_api_base_url() -> str:
    return (
        getattr(settings, 'supply_api_base_url', None)
        or os.environ.get('SUPPLY_API_BASE_URL')
        or _DEFAULT_SUPPLY_API
    ).rstrip('/')


def _internal_secret() -> str:
    return (
        getattr(settings, 'autom8_kds_secret', None)
        or os.environ.get('AUTOM8_KDS_SECRET')
        or getattr(settings, 'supply_internal_secret', None)
        or os.environ.get('SUPPLY_INTERNAL_SECRET')
        or ''
    )


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
    Prefer mint-link via supply-api; use this only when SUPPLY_FORM_SIGNING_SECRET
    matches supply-api exactly.
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
    """Next daily ordering cutoff in IST."""
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


def _mint_auth_headers() -> Optional[dict]:
    """Headers for mint-link: KDS secret preferred, else form signing secret."""
    headers = {'Content-Type': 'application/json'}
    internal = _internal_secret()
    if internal:
        headers['x-internal-secret'] = internal
        return headers
    form_secret = _signing_secret()
    if form_secret and form_secret != _DEFAULT_SECRET:
        headers['x-supply-form-signing-secret'] = form_secret
        return headers
    return None


async def _mint_via_supply_api(
    supplier_id: str,
    client_id: str,
    *,
    permanent: bool = False,
) -> Optional[str]:
    """Ask supply-api to mint with its production HMAC secret."""
    headers = _mint_auth_headers()
    if not headers:
        logger.error(
            '[supply_form_token] No AUTOM8_KDS_SECRET / SUPPLY_INTERNAL_SECRET / '
            'SUPPLY_FORM_SIGNING_SECRET on autom8-chat — cannot mint-link'
        )
        return None

    url = f'{_supply_api_base_url()}/api/supply/form/mint-link'
    payload = {
        'supplier_id': supplier_id,
        'client_id': client_id,
        'permanent': bool(permanent),
    }
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            resp = await client.post(url, headers=headers, json=payload)
        if resp.status_code in (200, 201):
            data = resp.json() or {}
            order_url = data.get('url')
            if order_url:
                logger.info('[supply_form_token] mint-link ok supplier=%s', supplier_id)
                return order_url
            logger.error('[supply_form_token] mint-link missing url: %s', resp.text[:200])
            return None
        logger.error(
            '[supply_form_token] mint-link HTTP %s: %s',
            resp.status_code,
            resp.text[:300],
        )
        return None
    except Exception as exc:
        logger.error('[supply_form_token] mint-link request failed: %s', exc)
        return None


async def build_order_form_url(supplier_id: str, client_id: str) -> str:
    """
    Mint a daily cutoff token and return the public /s/:token URL.

    Raises RuntimeError if minting would produce an Invalid order link
    (missing/mismatched secrets). Callers should surface that to the customer.
    """
    minted = await _mint_via_supply_api(supplier_id, client_id, permanent=False)
    if minted:
        return minted

    secret = _signing_secret()
    # Never fall back to the shared dev secret in production — supply-api rejects it.
    if secret == _DEFAULT_SECRET:
        raise RuntimeError(
            'Order link unavailable: set SUPPLY_FORM_SIGNING_SECRET on autom8-chat '
            'to match supply-api (and AUTOM8_KDS_SECRET for mint-link).'
        )

    logger.warning(
        '[supply_form_token] mint-link failed — local HMAC with SUPPLY_FORM_SIGNING_SECRET'
    )
    cutoff_time = await get_supplier_ordering_cutoff(supplier_id)
    valid_until = get_today_cutoff_date(cutoff_time)
    token = create_form_token(supplier_id, client_id, valid_until, permanent=False)
    return f'{_form_base_url()}/s/{token}'
