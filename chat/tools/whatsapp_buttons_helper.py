"""WhatsApp interactive button message helper.

Sends a WhatsApp Cloud API interactive reply-button message using the same
credential resolution and HTTP client pattern as whatsapp_tools.py.

Up to 3 buttons per message (WhatsApp platform limit).
Button titles must be ≤ 20 characters.

Usage example:
    await send_whatsapp_buttons(
        to=customer_phone,
        body="Are you *John*?",
        buttons=[
            {"id": "identity_new_confirm_yes",  "title": "✅ Yes, that's me"},
            {"id": "identity_new_confirm_edit", "title": "✏️ Enter my name"},
        ],
        restaurant_id=restaurant_id,
    )

Incoming button reply shape (WhatsApp Cloud API webhook):
    {
        "type": "interactive",
        "interactive": {
            "type": "button_reply",
            "button_reply": {
                "id": "identity_new_confirm_yes",
                "title": "✅ Yes, that's me"
            }
        }
    }
The dispatcher must pass this raw message dict as `message_obj` to
handle_identity_flow() so button ID validation works correctly.
"""

import logging
from typing import List, Dict, Any, Optional

import httpx

from config.settings import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Credential resolution (mirrors whatsapp_tools._get_whatsapp_credentials)
# ---------------------------------------------------------------------------

async def _get_whatsapp_credentials(restaurant_id: str) -> Dict[str, str] | None:
    """Resolve per-restaurant WhatsApp credentials, with env fallback."""
    from tools.restaurant_config import get_whatsapp_credentials
    creds = await get_whatsapp_credentials(restaurant_id)
    if creds:
        return creds

    if (
        settings.botbiz_phone_number_id != "your_phone_number_id_here"
        and settings.botbiz_access_token != "your_access_token_here"
    ):
        logger.warning(
            "Using global BotBiz env credentials for restaurant %s; add restaurant_integrations row",
            restaurant_id,
        )
        return {
            "api_endpoint": settings.botbiz_api_endpoint.rstrip("/"),
            "phone_number_id": settings.botbiz_phone_number_id,
            "access_token": settings.botbiz_access_token,
        }

    logger.error("No active WhatsApp integration found for restaurant %s", restaurant_id)
    return None


# ---------------------------------------------------------------------------
# send_whatsapp_buttons
# ---------------------------------------------------------------------------

async def send_whatsapp_buttons(
    to: str,
    body: str,
    buttons: List[Dict[str, str]],
    restaurant_id: str,
    header: Optional[str] = None,
    footer: Optional[str] = None,
) -> bool:
    """
    Send an interactive reply-button message via the WhatsApp Cloud API.

    Args:
        to:            Recipient phone number (E.164 without '+', e.g. '919876543210').
        body:          Message body text. Supports WhatsApp markdown (*bold*, _italic_).
        buttons:       List of dicts with keys "id" (≤256 chars) and "title" (≤20 chars).
                       WhatsApp allows a maximum of 3 buttons.
        restaurant_id: Used to look up the WABA credentials for the restaurant.
        header:        Optional plain-text header (≤60 chars).
        footer:        Optional plain-text footer (≤60 chars).

    Returns:
        True on success (HTTP 200/201), False on any error.

    Raises:
        ValueError: if more than 3 buttons are supplied.
    """
    if len(buttons) > 3:
        raise ValueError(
            f"WhatsApp allows at most 3 reply buttons; {len(buttons)} supplied."
        )

    try:
        credentials = await _get_whatsapp_credentials(restaurant_id)
        if not credentials:
            return False

        url = f"{credentials['api_endpoint']}/{credentials['phone_number_id']}/messages"

        # Build the interactive payload per WhatsApp Cloud API spec
        interactive: Dict[str, Any] = {
            "type": "button",
            "body": {"text": body},
            "action": {
                "buttons": [
                    {
                        "type": "reply",
                        "reply": {"id": btn["id"], "title": btn["title"]},
                    }
                    for btn in buttons
                ]
            },
        }

        if header:
            interactive["header"] = {"type": "text", "text": header}

        if footer:
            interactive["footer"] = {"text": footer}

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to,
            "type": "interactive",
            "interactive": interactive,
        }

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {credentials['access_token']}",
        }

        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(url, json=payload, headers=headers)

        logger.info(
            f"BotBiz send_buttons → {response.status_code} | to={to} | "
            f"response={response.text[:200]}"
        )
        return response.status_code in (200, 201)

    except Exception as e:
        logger.error(f"Failed to send WhatsApp buttons to {to}: {e}")
        return False
