# chat/agents/supply/nlp_api.py
# ============================================================================
# Python → Supply Node API helpers for NLP order pricing / confirm / eval log.
# Uses form_token auth (same HMAC as webcart) + AUTOM8_BACKEND_URL /
# SUPPLY_API_URL — matching existing chat→api patterns.
# ============================================================================

from __future__ import annotations

import logging
import os
from typing import Any, Optional

import httpx

from tools.supply_form_token import create_form_token, get_today_cutoff_date, get_supplier_ordering_cutoff

logger = logging.getLogger(__name__)


def _api_base() -> str:
    return (
        os.getenv('SUPPLY_API_URL')
        or os.getenv('AUTOM8_BACKEND_URL')
        or 'https://api.autom8.works'
    ).rstrip('/')


async def _mint_form_token(supplier_id: str, client_id: str) -> str:
    cutoff = await get_supplier_ordering_cutoff(supplier_id)
    valid_until = get_today_cutoff_date(cutoff)
    return create_form_token(supplier_id, client_id, valid_until, permanent=False)


async def preview_nlp_prices(
    supplier_id: str,
    client_id: str,
    items: list[dict[str, Any]],
) -> Optional[dict]:
    """
    Call Node POST /api/supply/orders/nlp-preview which uses resolvePrice().
    items: [{ item_id, qty }]
    """
    try:
        token = await _mint_form_token(supplier_id, client_id)
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                f'{_api_base()}/api/supply/orders/nlp-preview',
                json={'form_token': token, 'items': items},
            )
        if resp.status_code != 200:
            logger.error(
                '[nlp-api] preview HTTP %s: %s',
                resp.status_code, resp.text[:300],
            )
            return None
        return resp.json()
    except Exception as exc:
        logger.error('[nlp-api] preview failed: %s', exc)
        return None


async def confirm_nlp_order(
    supplier_id: str,
    client_id: str,
    items: list[dict[str, Any]],
    *,
    draft_id: Optional[str] = None,
    notes: Optional[str] = None,
) -> Optional[dict]:
    """Create supply_orders via Node path that mirrors webcart form create."""
    try:
        token = await _mint_form_token(supplier_id, client_id)
        payload: dict[str, Any] = {
            'form_token': token,
            'items': items,
        }
        if draft_id:
            payload['draft_id'] = draft_id
        if notes:
            payload['notes'] = notes
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f'{_api_base()}/api/supply/orders/nlp-confirm',
                json=payload,
            )
        if resp.status_code not in (200, 201):
            logger.error(
                '[nlp-api] confirm HTTP %s: %s',
                resp.status_code, resp.text[:400],
            )
            try:
                return {'_error': True, **resp.json()}
            except Exception:
                return {'_error': True, 'error': resp.text[:200]}
        return resp.json()
    except Exception as exc:
        logger.error('[nlp-api] confirm failed: %s', exc)
        return {'_error': True, 'error': str(exc)}


async def log_nlp_parse(
    supplier_id: str,
    client_id: str,
    *,
    raw_text: str,
    parsed_output: dict,
    unmatched: list,
    confidence_avg: float,
    outcome: str,
    draft_id: Optional[str] = None,
    phone: Optional[str] = None,
    order_id: Optional[str] = None,
) -> None:
    """Fire-and-forget eval log (Node → supply_nlp_order_parse_logs)."""
    try:
        token = await _mint_form_token(supplier_id, client_id)
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f'{_api_base()}/api/supply/orders/nlp-log',
                json={
                    'form_token': token,
                    'draft_id': draft_id,
                    'raw_text': raw_text,
                    'parsed_output': parsed_output,
                    'unmatched': unmatched,
                    'confidence_avg': confidence_avg,
                    'outcome': outcome,
                    'phone': phone,
                    'order_id': order_id,
                },
            )
    except Exception as exc:
        logger.warning('[nlp-api] log failed: %s', exc)
