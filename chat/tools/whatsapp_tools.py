"""WhatsApp tools - BotBiz / Meta Cloud API integration.

BotBiz uses the official Meta WhatsApp Business Cloud API.
  Incoming webhooks: Meta Graph API format (entry > changes > value > messages)
  Outgoing messages: POST https://graph.facebook.com/v22.0/{phone_number_id}/messages
  Auth header: Authorization: Bearer {BOTBIZ_ACCESS_TOKEN}

Dashboard: https://dash.botbiz.io  (Bot Manager > API Developer)
Meta docs:  https://developers.facebook.com/docs/whatsapp/cloud-api
"""

import json
import logging
from typing import Dict, Any, Optional

import httpx

from config.settings import settings

logger = logging.getLogger(__name__)


def _compact_location_label(name: str, address: str, lat: str, lng: str) -> str:
    n = str(name or "").strip()
    a = str(address or "").strip()
    if a and n and (n.lower() in a.lower() or a.lower() in n.lower()):
        return a if len(a) >= len(n) else n
    if a and n:
        return f"{n} - {a}"
    if a:
        return a
    if n:
        return n
    return f"{lat}, {lng}"

# ─── Shared HTTP client ───────────────────────────────────────────────────────
_http_client: httpx.AsyncClient | None = None


def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(
            timeout=30,
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        )
    return _http_client


async def close_http_client() -> None:
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


# ---------------------------------------------------------------------------
# Credential resolution
# ---------------------------------------------------------------------------

async def _get_whatsapp_credentials(restaurant_id: str) -> Dict[str, str] | None:
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
            "api_endpoint":    settings.botbiz_api_endpoint.rstrip("/"),
            "phone_number_id": settings.botbiz_phone_number_id,
            "access_token":    settings.botbiz_access_token,
        }

    logger.error("No active WhatsApp integration found for restaurant %s", restaurant_id)
    return None


# ---------------------------------------------------------------------------
# Outbound: plain text
# ---------------------------------------------------------------------------

async def send_whatsapp_message(
    phone: str, message: str, restaurant_id: str
) -> bool:
    try:
        credentials = await _get_whatsapp_credentials(restaurant_id)
        if not credentials:
            return False

        url = f"{credentials['api_endpoint']}/{credentials['phone_number_id']}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "text",
            "text": {"body": message},
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {credentials['access_token']}",
        }

        client = _get_http_client()
        response = await client.post(url, json=payload, headers=headers)
        logger.info(
            f"BotBiz send_message → {response.status_code} | to={phone} | "
            f"response={response.text[:200]}"
        )
        return response.status_code in (200, 201)

    except Exception as e:
        logger.error(f"Failed to send WhatsApp message to {phone}: {e}")
        return False


def send_location_request_message(
    to: str,
    phone_number_id: str,
    access_token: str,
    body_text: str = "📍 Please share your delivery location",
) -> dict:
    """
    Sends WhatsApp's native location_request_message interactive type.
    On the customer's device this opens the 'Choose Address' sheet
    (saved Google Maps addresses / current location / type manually).
    Supported on Graph API v22.0+.
    """
    import requests

    url = f"https://graph.facebook.com/v22.0/{phone_number_id}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": to,
        "type": "interactive",
        "interactive": {
            "type": "location_request_message",
            "body": {
                "text": body_text,
            },
            "action": {
                "name": "send_location",
            },
        },
    }
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json",
    }
    resp = requests.post(url, json=payload, headers=headers, timeout=10)
    resp.raise_for_status()
    return resp.json()


# ---------------------------------------------------------------------------
# Outbound: template
# ---------------------------------------------------------------------------

async def send_whatsapp_template(
    phone: str,
    template_name: str,
    language_code: str,
    components: list,
    restaurant_id: str,
) -> bool:
    try:
        credentials = await _get_whatsapp_credentials(restaurant_id)
        if not credentials:
            return False

        url = f"{credentials['api_endpoint']}/{credentials['phone_number_id']}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "template",
            "template": {
                "name": template_name,
                "language": {"code": language_code},
                "components": components,
            },
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {credentials['access_token']}",
        }

        client = _get_http_client()
        response = await client.post(url, json=payload, headers=headers)
        logger.info(
            f"BotBiz send_template '{template_name}' → {response.status_code} | to={phone}"
        )
        return response.status_code in (200, 201)

    except Exception as e:
        logger.error(f"Failed to send WhatsApp template to {phone}: {e}")
        return False


# ---------------------------------------------------------------------------
# Outbound: CTA URL button (interactive)
# ---------------------------------------------------------------------------

async def send_whatsapp_cta_url(
    phone: str,
    restaurant_id: str,
    *,
    body_text: str,
    button_text: str,
    url: str,
    header_text: str | None = None,
    footer_text: str | None = None,
) -> bool:
    """Send a WhatsApp 'cta_url' interactive message — a tappable button
    that opens `url`, instead of a plain link inside the message body.

    Note: Meta only follows redirects up to a point and some in-app
    browsers behave oddly with dynamic query params, but this is the
    standard pattern for "View Menu" / "Track Order" style CTAs.
    """
    try:
        credentials = await _get_whatsapp_credentials(restaurant_id)
        if not credentials:
            return False

        url_endpoint = f"{credentials['api_endpoint']}/{credentials['phone_number_id']}/messages"

        interactive: dict = {
            "type": "cta_url",
            "body": {"text": body_text},
            "action": {
                "name": "cta_url",
                "parameters": {
                    "display_text": button_text[:20],  # Meta hard limit: 20 chars
                    "url": url,
                },
            },
        }
        if header_text:
            interactive["header"] = {"type": "text", "text": header_text[:60]}
        if footer_text:
            interactive["footer"] = {"text": footer_text[:60]}

        payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "interactive",
            "interactive": interactive,
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {credentials['access_token']}",
        }

        client = _get_http_client()
        response = await client.post(url_endpoint, json=payload, headers=headers)
        logger.info(
            f"send_whatsapp_cta_url → {response.status_code} | to={phone} | "
            f"url={url} | response={response.text[:200]}"
        )
        return response.status_code in (200, 201)

    except Exception as e:
        logger.error(f"Failed to send WhatsApp CTA URL to {phone}: {e}")
        return False


# ---------------------------------------------------------------------------
# Outbound: WhatsApp Flow
# ---------------------------------------------------------------------------

def _build_flow_navigate_payload(
    flow_screen: str,
    flow_data: dict | None,
) -> dict:
    payload: dict = {"screen": flow_screen}
    if flow_data:
        payload["data"] = flow_data
    return payload


async def send_whatsapp_flow(
    phone: str,
    flow_id: str,
    flow_token: str,
    flow_cta: str,
    flow_header: str | None = None,
    flow_body: str | None = None,
    flow_footer: str | None = None,
    restaurant_id: str | None = None,
    *,
    flow_screen: str = "RESERVATION_SCREEN",
    flow_data: dict | None = None,
) -> bool:
    """Send a WhatsApp Flow message (e.g. date/time picker).

    Uses flow_action=navigate (not data_exchange) for Without-Endpoint flows.
    Pass flow_data (e.g. min_date, max_date) to bind DatePicker limits in Flow JSON.
    Empty header/footer dicts are omitted — Meta rejects them.
    """
    try:
        credentials = await _get_whatsapp_credentials(restaurant_id)
        if not credentials:
            return False

        url = f"{credentials['api_endpoint']}/{credentials['phone_number_id']}/messages"

        interactive: dict = {
            "type": "flow",
            "body": {"text": flow_body or "Please complete the form below."},
            "action": {
                "name": "flow",
                "parameters": {
                    "flow_message_version": "3",
                    "flow_token": flow_token,
                    "flow_id": flow_id,
                    "flow_cta": flow_cta,
                    "flow_action": "navigate",
                    "flow_action_payload": _build_flow_navigate_payload(
                        flow_screen, flow_data,
                    ),
                    "mode": "published",
                },
            },
        }

        # Only include header/footer when provided — empty dicts cause API errors
        if flow_header:
            interactive["header"] = {"type": "text", "text": flow_header}
        if flow_footer:
            interactive["footer"] = {"text": flow_footer}

        payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "interactive",
            "interactive": interactive,
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {credentials['access_token']}",
        }

        client = _get_http_client()
        response = await client.post(url, json=payload, headers=headers)
        logger.info(
            f"send_whatsapp_flow → {response.status_code} | to={phone} | "
            f"flow_id={flow_id} | response={response.text[:200]}"
        )
        return response.status_code in (200, 201)

    except Exception as e:
        logger.error(f"Failed to send WhatsApp Flow to {phone}: {e}")
        return False


# ---------------------------------------------------------------------------
# Outbound: location request
# ---------------------------------------------------------------------------

def _location_request_body(
    *,
    purpose: str = "immediate",
    scheduled_label: str | None = None,
) -> str:
    """WhatsApp location-request copy — immediate vs scheduled delivery."""
    if purpose == "scheduled":
        slot = f" for *{scheduled_label}*" if scheduled_label else ""
        return (
            f"Great! You've selected *Scheduled Delivery* 📅{slot}\n\n"
            "Tap the button below to *share your delivery location pin* 📍 — "
            "we use it to calculate distance-based delivery charge.\n"
            "Or reply with your full address."
        )
    return (
        "Great! You've selected *Deliver Now* 🛵\n\n"
        "Tap the button below to *share your location pin* 📍 — "
        "we use it to calculate your delivery charge.\n"
        "Or reply with your full address."
    )


async def send_location_request(
    phone: str,
    restaurant_id: str,
    *,
    purpose: str = "immediate",
    scheduled_label: str | None = None,
    body_text: str | None = None,
) -> bool:
    """Send a native WhatsApp location-request message."""
    try:
        credentials = await _get_whatsapp_credentials(restaurant_id)
        if not credentials:
            return False

        url = f"{credentials['api_endpoint']}/{credentials['phone_number_id']}/messages"
        payload = {
            "messaging_product": "whatsapp",
            "to": phone,
            "type": "interactive",
            "interactive": {
                "type": "location_request_message",
                "body": {
                    "text": body_text
                    or _location_request_body(
                        purpose=purpose,
                        scheduled_label=scheduled_label,
                    ),
                },
                "action": {
                    "name": "send_location",
                },
            },
        }
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {credentials['access_token']}",
        }

        client = _get_http_client()
        response = await client.post(url, json=payload, headers=headers)
        logger.info(
            f"send_location_request → {response.status_code} | to={phone} | "
            f"response={response.text[:200]}"
        )
        return response.status_code in (200, 201)

    except Exception as e:
        logger.error(f"Failed to send location request to {phone}: {e}")
        return False


# ---------------------------------------------------------------------------
# Inbound parser
# ---------------------------------------------------------------------------

async def parse_incoming(payload: dict) -> Dict[str, Any]:
    """Parse a Meta Cloud API webhook payload.

    Handles message types:
      text, interactive (button_reply, list_reply, nfm_reply),
      button, location
    """
    try:
        entry = payload.get("entry", [])
        if not entry:
            raise ValueError("No 'entry' in BotBiz/Meta payload")

        changes = entry[0].get("changes", [])
        if not changes:
            raise ValueError("No 'changes' in BotBiz/Meta payload entry")

        value = changes[0].get("value", {})

        messages = value.get("messages", [])
        if not messages:
            raise ValueError("No 'messages' in BotBiz/Meta payload value")

        message_data = messages[0]
        phone     = message_data.get("from", "").lstrip("+")
        msg_type  = message_data.get("type", "text")
        timestamp = int(message_data.get("timestamp", 0))

        if msg_type == "text":
            message_text = message_data.get("text", {}).get("body", "")

        elif msg_type == "interactive":
            interactive = message_data.get("interactive", {})
            itype = interactive.get("type")

            if itype == "button_reply":
                # Use id (not title) — handlers match on ids like "1", "2", "SKIP", "YES"
                message_text = interactive["button_reply"].get("id", "")

            elif itype == "list_reply":
                # Use id for list replies too
                message_text = interactive["list_reply"].get("id", "")

            elif itype == "nfm_reply":
                # WhatsApp Flow completion payload
                # Meta sends: {"response_json": "{\"reservation_date\":\"...\",\"reservation_time\":\"...\"}"}
                nfm = interactive.get("nfm_reply", {})
                raw = nfm.get("response_json", "{}")
                try:
                    data       = json.loads(raw)
                    date_str   = data.get("reservation_date", "")
                    time_str   = data.get("reservation_time", "")
                    flow_token = message_data.get("context", {}).get("id", "unknown")
                    message_text = f"FLOW:{flow_token}|date={date_str}|time={time_str}"
                except Exception:
                    message_text = ""

            else:
                message_text = ""

        elif msg_type == "button":
            message_text = message_data.get("button", {}).get("text", "")

        elif msg_type == "location":
            loc     = message_data.get("location", {})
            lat     = loc.get("latitude", "")
            lng     = loc.get("longitude", "")
            name    = loc.get("name", "")
            address = loc.get("address", "")
            label = _compact_location_label(str(name), str(address), str(lat), str(lng))
            message_text = f"LOCATION:{lat},{lng}|{label}"

        else:
            message_text = ""

        contacts = value.get("contacts", [])
        profile_name: Optional[str] = None
        if contacts:
            profile_name = contacts[0].get("profile", {}).get("name")

        metadata = value.get("metadata", {})
        restaurant_whatsapp_number: str = metadata.get(
            "display_phone_number",
            settings.botbiz_phone_number_id,
        )

        table_number: Optional[str] = None
        if "context" in message_data:
            table_number = message_data["context"].get("table_number")

        return {
            "phone":                    phone,
            "message":                  message_text,
            "restaurant_whatsapp_number": restaurant_whatsapp_number,
            "whatsapp_profile_name":    profile_name,
            "timestamp":                timestamp,
            "table_number":             table_number,
        }

    except Exception as e:
        logger.error(f"Failed to parse BotBiz/Meta payload: {e}")
        raise
