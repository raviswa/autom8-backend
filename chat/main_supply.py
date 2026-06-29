"""
chat/main_supply.py
===================
Minimal FastAPI entry-point for the *autom8-chat supply* Railway service.

Handles ONLY the WhatsApp supply webhook — nothing from the restaurant bot
is imported here, so a supply-side crash can never bring down autom8-chat.

Started by:  chat-supply/railway.json  →  "uvicorn main_supply:app …"
"""

import hashlib
import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse

from agents.supply_agent import handle_supply_message
from config.settings import settings
from tools.supply_whatsapp import close_supply_http_client

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("[supply] autom8-chat supply starting")
    yield
    logger.info("[supply] autom8-chat supply shutting down")
    await close_supply_http_client()


# ─── App ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="Munafe Supply Bot", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Health ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "service": "munafe-supply-chat"}


# ─── Webhook verification (GET) ───────────────────────────────────────────────

@app.get("/webhook/supply")
async def verify_supply_webhook(request: Request):
    """Meta webhook hub.challenge verification."""
    params = request.query_params
    if (
        params.get("hub.mode") == "subscribe"
        and params.get("hub.verify_token") == settings.supply_webhook_verify_token
    ):
        return PlainTextResponse(content=params.get("hub.challenge"), status_code=200)
    return PlainTextResponse(content="Verification failed", status_code=403)


# ─── Webhook receive (POST) ───────────────────────────────────────────────────

@app.post("/webhook/supply")
async def supply_webhook_post(request: Request, background_tasks: BackgroundTasks):
    """
    Receives supply WhatsApp messages forwarded by autom8-backend-supply.
    Validates with SUPPLY_WEBHOOK_SECRET (separate from the restaurant secret).
    """
    body      = await request.body()
    signature = request.headers.get("x-hub-signature-256", "")

    if not _verify_supply_signature(body, signature):
        logger.warning("[supply-webhook] Signature mismatch — dropping payload")
        return JSONResponse(status_code=200, content={"status": "invalid signature"})

    payload = await request.json()
    background_tasks.add_task(_process_supply_payload, payload)
    return JSONResponse(status_code=200, content={"status": "ok"})


# ─── Payload processor ────────────────────────────────────────────────────────

async def _process_supply_payload(payload: dict):
    """Process one supply WhatsApp webhook payload."""
    try:
        entry  = payload.get("entry", [{}])[0]
        change = entry.get("changes", [{}])[0]
        value  = change.get("value", {})

        messages = value.get("messages", [])
        if not messages:
            return

        msg              = messages[0]
        phone            = msg.get("from", "")
        msg_type         = msg.get("type", "")
        supply_context   = value.get("_supply_context", {})
        supplier_id      = supply_context.get("supplier_id")
        client_id        = supply_context.get("client_id")

        if not supplier_id or not phone:
            logger.warning(
                f"[supply-webhook] Missing supplier_id={supplier_id} or phone={phone}, dropping"
            )
            return

        if msg_type not in ("text", "interactive"):
            logger.info(f"[supply-webhook] Skipping unhandled type={msg_type!r}")
            return

        logger.info(
            f"[supply-webhook] supplier={supplier_id} client={client_id} "
            f"phone={phone} type={msg_type}"
        )

        await handle_supply_message(
            supplier_id      = supplier_id,
            client_id        = client_id,
            phone            = phone,
            message_type     = msg_type,
            raw_message_obj  = msg,
        )

    except Exception as exc:
        logger.error(f"[supply-webhook] Processing failed: {exc}", exc_info=True)


# ─── Signature helpers ────────────────────────────────────────────────────────

def _verify_supply_signature(body: bytes, signature: str) -> bool:
    is_prod = settings.environment == "production"

    if not settings.supply_webhook_secret:
        if is_prod:
            logger.error("[supply-webhook] SUPPLY_WEBHOOK_SECRET not set in production")
            return False
        return True  # allow in local dev

    if not signature:
        return not is_prod

    expected = "sha256=" + hmac.new(
        settings.supply_webhook_secret.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main_supply:app", host="0.0.0.0", port=8000, reload=True)
