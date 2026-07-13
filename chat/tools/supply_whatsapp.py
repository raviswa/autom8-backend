# chat/tools/supply_whatsapp.py
# ============================================================================
# Supply WhatsApp send helpers — uses supplier WABA credentials.
# Kept separate from whatsapp_tools.py to avoid credential confusion.
#
# Reads from settings:
#   supply_waba_phone_number_id  — Meta phone_number_id for supplier's number
#   supply_waba_access_token     — Meta Cloud API access token
#   supply_waba_api_endpoint     — default: https://graph.facebook.com/v19.0
#
# All functions are fire-and-log — they return bool but callers don't need
# to handle failures (the agent just moves on).
# ============================================================================

import logging
from typing import Any

import httpx

from config.settings import settings
from db.queries import log_supply_notification

logger = logging.getLogger(__name__)

_http_client: httpx.AsyncClient | None = None


def _client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=15)
    return _http_client


async def close_supply_http_client() -> None:
    global _http_client
    if _http_client:
        await _http_client.aclose()
        _http_client = None


def _creds() -> dict | None:
    pid   = settings.supply_waba_phone_number_id
    token = settings.supply_waba_access_token
    if not pid or not token:
        logger.error('[supply-wa] SUPPLY_WABA_PHONE_NUMBER_ID or SUPPLY_WABA_ACCESS_TOKEN not set')
        return None
    return {
        'url':   f"{settings.supply_waba_api_endpoint.rstrip('/')}/{pid}/messages",
        'token': token,
    }


async def send_supply_text(
    phone:       str,
    message:     str,
    supplier_id: str,
    client_id:   str | None = None,
) -> bool:
    """Send a plain text WhatsApp message from the supplier's WABA number."""
    creds = _creds()
    if not creds:
        return False

    payload = {
        'messaging_product': 'whatsapp',
        'to':   phone,
        'type': 'text',
        'text': {'body': message},
    }
    return await _post(creds, payload, supplier_id, client_id, phone, 'text_message', message[:80])


async def send_supply_buttons(
    phone:       str,
    body:        str,
    buttons:     list[dict],   # [{'id': str, 'title': str}, ...]
    supplier_id: str,
    client_id:   str | None = None,
    header:      str | None = None,
    footer:      str | None = None,
) -> bool:
    """Send an interactive button message (max 3 buttons per Meta spec)."""
    creds = _creds()
    if not creds:
        return False

    interactive: dict[str, Any] = {
        'type': 'button',
        'body': {'text': body},
        'action': {
            'buttons': [
                {'type': 'reply', 'reply': {'id': b['id'], 'title': b['title'][:20]}}
                for b in buttons[:3]
            ]
        },
    }
    if header:
        interactive['header'] = {'type': 'text', 'text': header}
    if footer:
        interactive['footer'] = {'text': footer}

    payload = {
        'messaging_product': 'whatsapp',
        'recipient_type':    'individual',
        'to':                phone,
        'type':              'interactive',
        'interactive':       interactive,
    }
    return await _post(creds, payload, supplier_id, client_id, phone, 'interactive_buttons', body[:80])


async def _post(
    creds:         dict,
    payload:       dict,
    supplier_id:   str,
    client_id:     str | None,
    phone:         str,
    template_name: str,
    log_snippet:   str,
) -> bool:
    headers = {
        'Content-Type':  'application/json',
        'Authorization': f"Bearer {creds['token']}",
    }
    wamid      = None
    ok         = False
    error_text = None

    try:
        response = await _client().post(creds['url'], json=payload, headers=headers)
        ok       = response.status_code in (200, 201)
        if ok:
            wamid = response.json().get('messages', [{}])[0].get('id')
        else:
            error_text = response.text[:300]
            logger.error(f'[supply-wa] {template_name} → {response.status_code} body={error_text}')
        logger.info(f'[supply-wa] {template_name} → {response.status_code} to={phone}')
    except Exception as e:
        logger.error(f'[supply-wa] {template_name} send failed: {e}')
        error_text = str(e)

    await log_supply_notification(
        supplier_id   = supplier_id,
        client_id     = client_id,
        template_name = template_name,
        phone         = phone,
        direction     = 'outbound',
        status        = 'sent' if ok else 'failed',
        wa_message_id = wamid,
        error_message = error_text,
        payload       = {'snippet': log_snippet},
    )
    return ok
