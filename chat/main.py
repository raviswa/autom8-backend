"""FastAPI application entry point with webhook handlers."""

import json
import re
import logging
import hmac
import hashlib
import os
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse




from config.settings import settings
from tools.db_tools import (
    init_db,
    get_restaurant_by_whatsapp_number,
    get_restaurant_by_phone_number_id,
    get_customer,
    update_booking_status,
    get_session_state,
    save_session_state,
    customer_lock,
)
from tools.whatsapp_tools import parse_incoming, send_whatsapp_message
from tools.payment_tools import verify_webhook_signature
from tools.booking_mechanisms import (
    is_catalog_order,
    bridge_catalog_order_to_cart,
)
from agents.root_agent import route_message

import asyncio

from fastapi.responses import RedirectResponse, HTMLResponse
import httpx, os

# ── Lifespan ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    sha = os.getenv("RAILWAY_GIT_COMMIT_SHA", "unknown")
    logger.info(f"Starting Munafe bot... commit={sha} integration_model=no_phone_number")
    await init_db()
    from tools.scheduler_tools import start_scheduler
    await start_scheduler()
    yield

    logger.info("Shutting down Munafe bot...")
    from tools.whatsapp_tools import close_http_client
    await close_http_client()
    logger.info("HTTP client closed.")

logging.basicConfig(level=settings.log_level)
logger = logging.getLogger(__name__)

app = FastAPI(title="Munafe Bot", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Receipt redirect ───────────────────────────────────────────────────────────

@app.get("/r/{token}")
async def receipt_redirect(token: str):
    """Stable receipt QR target — generates fresh signed URL and redirects."""
    sb_base = os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
    sb_key  = os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            lst = await client.post(
                f"{sb_base}/storage/v1/object/list/Receipts",
                json={"prefix": "", "limit": 200},
                headers={"apikey": sb_key, "Authorization": f"Bearer {sb_key}",
                         "Content-Type": "application/json"},
            )
            files = [f["name"] for f in lst.json()
                     if token.lower() in f.get("name", "").lower()]
            if not files:
                return HTMLResponse(
                    "<h1>Receipt not found or expired</h1>"
                    "<p>Receipts are available for 48 hours after your order.</p>",
                    status_code=404)
            sign = await client.post(
                f"{sb_base}/storage/v1/object/sign/Receipts/{files[0]}",
                json={"expiresIn": 3600},
                headers={"apikey": sb_key, "Authorization": f"Bearer {sb_key}",
                         "Content-Type": "application/json"},
            )
            signed_path = sign.json().get("signedURL", "")
            return RedirectResponse(f"{sb_base}/storage/v1{signed_path}")
    except Exception:
        return HTMLResponse("<h1>Error retrieving receipt</h1>", status_code=500)

_processed_message_ids: OrderedDict[str, int] = OrderedDict()
_processed_message_ids_lock = asyncio.Lock()


# ─────────────────────────────────────────────
# Message body extraction
# ─────────────────────────────────────────────

def _extract_message_body(message_obj: dict) -> str:
    """
    Extract the text body from any WhatsApp message type.

    Returns a string that booking_agent can dispatch on:
      - Plain text      → the message body
      - button_reply    → the reply ID (e.g. "1", "SKIP", "YES", "CART:CONFIRM")
      - list_reply      → the reply ID (e.g. "4", "CAT:South Indian")
      - nfm_reply       → "FLOW:{token}|date=YYYY-MM-DD|time=HH:MM"
      - location        → "LOCATION:lat,lng|label"
      - order (catalog) → "" (handled separately via is_catalog_order)
    """
    msg_type = message_obj.get("type", "")

    if msg_type == "text":
        return message_obj.get("text", {}).get("body", "").strip()

    if msg_type == "button":
        return message_obj.get("button", {}).get("text", "").strip()

    if msg_type == "interactive":
        interactive      = message_obj.get("interactive", {})
        interactive_type = interactive.get("type", "")

        if interactive_type == "button_reply":
            # Use ID not title — handlers match on IDs like "1", "2", "SKIP", "YES"
            return interactive.get("button_reply", {}).get("id", "").strip()

        if interactive_type == "list_reply":
            # Use ID not title — handlers match on IDs like "4", "CAT:..."
            return interactive.get("list_reply", {}).get("id", "").strip()

        if interactive_type == "nfm_reply":
            # WhatsApp Flow completion payload.
            # Meta sends response_json as a JSON string inside nfm_reply.
            # We decode it here and reformat as the structured string that
            # handle_reserve_table_flow (awaiting_flow_datetime) expects:
            #   FLOW:{flow_token}|date=YYYY-MM-DD|time=HH:MM
            nfm = interactive.get("nfm_reply", {})
            raw = nfm.get("response_json", "{}")
            try:
                data       = json.loads(raw)
                date_str   = data.get("reservation_date", "")
                time_str   = data.get("reservation_time", "")
                # flow_token is inside response_json (set when the Flow was sent)
                flow_token = data.get(
                    "flow_token",
                    message_obj.get("context", {}).get("id", "unknown"),
                )
                return f"FLOW:{flow_token}|date={date_str}|time={time_str}"
            except Exception as e:
                logger.error(f"Failed to parse nfm_reply response_json: {e} | raw={raw}")
                return ""

        # Any other interactive type we don't handle yet
        logger.info(f"Unhandled interactive type: {interactive_type!r}")
        return ""

    if msg_type == "location":
        loc     = message_obj.get("location", {})
        lat     = loc.get("latitude", "")
        lng     = loc.get("longitude", "")
        name    = loc.get("name", "")
        address = loc.get("address", "")
        label   = f"{name} {address}".strip() or f"{lat}, {lng}"
        return f"LOCATION:{lat},{lng}|{label}"

    # order, reaction, image, sticker, etc. — caller handles these separately
    return ""


# ─────────────────────────────────────────────
# AUTO-REPLY DETECTION
# ─────────────────────────────────────────────

_AUTO_REPLY_RE = re.compile(
    r"(?:"
    r"hi,?\s+thanks\s+for\s+contacting|"
    r"thank\s+you\s+for\s+(?:contacting|reaching|your\s+message)|"
    r"we(?:'ve|\s+have)\s+received\s+your\s+message|"
    r"we(?:\s+will|'ll)\s+get\s+back\s+to\s+you|"
    r"auto.?reply|"
    r"automatic\s+(?:reply|response)|"
    r"out\s+of\s+(?:office|town)|"
    r"currently\s+(?:unavailable|away|busy)|"
    r"this\s+is\s+an\s+automated\s+(?:message|response)|"
    r"do\s+not\s+reply\s+to\s+this"
    r")",
    re.IGNORECASE,
)


def _is_auto_reply(message_obj: dict, our_phone: str, message_body: str) -> bool:
    """
    Return True if this message is an auto-reply that should be silently ignored.

    Signals checked (any one is sufficient):
      1. message_obj has a "system" field — Meta system-generated message
      2. message text matches known auto-reply patterns (business OOO, auto-responders)
      3. message context.from == our own phone number AND message is plain text
         (button taps also reply to our messages but are interactive type — excluded)
    """
    if message_obj.get("system"):
        return True

    msg_type = message_obj.get("type", "")

    # Pattern match on text content
    if msg_type == "text" and _AUTO_REPLY_RE.search(message_body):
        return True

    # Reply-to-us signal: context.from is our own number
    # This catches auto-replies that don't match patterns but are replies to our msg
    if msg_type == "text":
        context_from = message_obj.get("context", {}).get("from", "")
        if context_from and our_phone:
            _cf = context_from.replace("+", "").replace(" ", "")
            _op = our_phone.replace("+", "").replace(" ", "")
            if _cf == _op or _cf.endswith(_op[-10:]):
                return True

    return False


# ─────────────────────────────────────────────
# Webhook Handlers
# ─────────────────────────────────────────────

@app.get("/webhook/meta")
@app.get("/webhook/botbiz")
@app.get("/webhook/whatsapp")
async def verify_webhook(request: Request):
    params = request.query_params
    if (
        params.get("hub.mode") == "subscribe"
        and params.get("hub.verify_token") == settings.botbiz_verify_token
    ):
        return PlainTextResponse(content=params.get("hub.challenge"), status_code=200)
    return PlainTextResponse(content="Verification failed", status_code=403)


async def _process_meta_payload(payload: dict):
    try:
        # 1. Extraction & in-process dedup
        value = payload.get("entry", [{}])[0].get("changes", [{}])[0].get("value", {})
        if not value.get("messages"):
            return

        message_obj = value["messages"][0]
        message_id  = message_obj.get("id", "")

        async with _processed_message_ids_lock:
            if message_id in _processed_message_ids:
                return
            _processed_message_ids[message_id] = 1
            if len(_processed_message_ids) > 1000:
                _processed_message_ids.popitem(last=False)

        # 2. Parse message body
        msg_type     = message_obj.get("type", "")
        logger.info(f"[DIAG] RAW message_obj={json.dumps(message_obj, ensure_ascii=False)}")
        message_body = _extract_message_body(message_obj)
        logger.info(f"[DIAG] Extracted type={msg_type!r} body={message_body!r}")

        # Skip truly unhandled types (not order, not a known interactive type)
        if not message_body and msg_type not in ("order",):
            logger.info(f"Skipping unhandled message type={msg_type!r}")
            return

        # 2b. Skip auto-replies (WhatsApp Business auto-responders)
        # These fire when the customer's number has an auto-reply configured.
        # Responding to them creates a confusing conversation loop.
        # We detect them by text pattern OR by context.from == our own number.
        _our_phone = settings.whatsapp_phone_number
        if _is_auto_reply(message_obj, _our_phone, message_body):
            logger.info(
                f"[auto-reply] Ignoring auto-reply from {message_obj.get('from')} "
                f"body={message_body[:80]!r}"
            )
            return

        # 3. Restaurant lookup (DB is canonical — env phone IDs are dev fallback only)
        parsed = await parse_incoming(payload)
        phone  = message_obj.get("from")
        metadata = value.get("metadata", {})

        restaurant = None
        phone_number_id = metadata.get("phone_number_id")
        if phone_number_id:
            restaurant = await get_restaurant_by_phone_number_id(str(phone_number_id))

        if not restaurant:
            restaurant_whatsapp = (
                parsed.get("restaurant_whatsapp_number") or settings.whatsapp_phone_number
            )
            restaurant = await get_restaurant_by_whatsapp_number(restaurant_whatsapp)

        if not restaurant:
            logger.error(
                f"No restaurant linked to phone_number_id={phone_number_id!r} "
                f"or whatsapp={parsed.get('restaurant_whatsapp_number')!r}"
            )
            return

        restaurant_id = restaurant["id"]
        manager_phone = restaurant["manager_phone"]
        profile_name  = (
            value.get("contacts", [{}])[0].get("profile", {}).get("name", "")
        )

        # 4. Per-customer advisory lock → load → process → save
        async with customer_lock(restaurant_id, phone):

            session_state = await get_session_state(restaurant_id, phone)
            if session_state is None:
                session_state = {}

            from agents.customer.dine_in_flow import _on_special_notes_timeout
            from agents.customer.booking_helpers import ensure_special_notes_kitchen_delivery
            await ensure_special_notes_kitchen_delivery(
                restaurant_id,
                phone,
                session_state,
                on_timeout=lambda: _on_special_notes_timeout(restaurant_id, phone),
            )

            # 5a. Catalog order bridge
            if is_catalog_order(message_obj):
                logger.info(f"[CATALOG] Catalog order detected from {phone}")
                bridge_success = await bridge_catalog_order_to_cart(
                    message_obj, session_state, restaurant_id
                )
                if not bridge_success:
                    from tools.catalog_tools import invalidate_menu_cache
                    invalidate_menu_cache(restaurant_id)
                    bridge_success = await bridge_catalog_order_to_cart(
                        message_obj, session_state, restaurant_id
                    )
                if bridge_success:
                    logger.info(f"[CATALOG] Successfully bridged order to cart for {phone}")
                    message_body = "CART:CONFIRM"
                else:
                    logger.warning(f"[CATALOG] Failed to bridge order for {phone}")
                    await send_whatsapp_message(
                        phone,
                        "We had trouble processing your catalog order. "
                        "Please try again, or type *MENU* to order from our list. 🙏",
                        restaurant_id,
                    )
                    return

            # 6. Route message
            logger.info(
                f"[DIAG] PRE-ROUTE booking_step={session_state.get('booking_step')!r} "
                f"keys={list(session_state.keys())}"
            )
            result = await route_message(
                sender_phone=phone,
                restaurant_manager_phone=manager_phone,
                restaurant_id=restaurant_id,
                message=message_body,
                whatsapp_profile_name=profile_name,
                table_number=parsed.get("table_number"),
                session_state=session_state,
                raw_message_obj=message_obj,
            )

            # 7. Persist state
            logger.info(
                f"[DIAG] POST-ROUTE result={result} "
                f"booking_step={session_state.get('booking_step')!r}"
            )
            await save_session_state(restaurant_id, phone, session_state)

        # 8. Manager fallback (outside lock)
        if phone == manager_phone and result.get("status") == "unknown_command":
            await send_whatsapp_message(
                phone,
                "Welcome, Manager! Use 'dashboard' to see today's bookings "
                "or 'status' to check tables.",
                restaurant_id,
            )

        logger.info(
            f"Processed {phone} | type={msg_type} | "
            f"Status: {result.get('status')} | Step: {session_state.get('booking_step')}"
        )

    except Exception as e:
        logger.error(f"Webhook processing failed: {e}", exc_info=True)


@app.post("/webhook/meta")
@app.post("/webhook/botbiz")
@app.post("/webhook/whatsapp")
async def webhook_post(request: Request, background_tasks: BackgroundTasks):
    body      = await request.body()
    signature = request.headers.get("x-hub-signature-256", "")

    if not _verify_meta_signature(body, signature):
        return JSONResponse(status_code=200, content={"status": "invalid signature"})

    payload = await request.json()
    background_tasks.add_task(_process_meta_payload, payload)
    return JSONResponse(status_code=200, content={"status": "ok"})


# ─────────────────────────────────────────────
# Signature Verification
# ─────────────────────────────────────────────

def _verify_meta_signature(body: bytes, signature: str) -> bool:
    is_prod = settings.environment == "production"

    if not settings.webhook_secret:
        if is_prod:
            logger.error("[webhook] WEBHOOK_SECRET is not set in production")
            return False
        return True  # local dev without secret configured

    if not signature:
        return not is_prod  # production requires x-hub-signature-256

    expected = "sha256=" + hmac.new(
        settings.webhook_secret.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
