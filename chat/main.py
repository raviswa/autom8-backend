"""FastAPI application entry point with webhook handlers."""

import json
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
    get_restaurant_by_id,
    get_customer,
    create_customer,
    create_booking,
    get_next_token_number,
    update_booking_status,
    get_session_state,
    save_session_state,
    customer_lock,
)
from tools.whatsapp_tools import parse_incoming, send_whatsapp_message, send_whatsapp_cta_url
from agents.customer.booking_helpers import touch_session_activity, is_reset_keyword, mark_session_visit_complete
from tools.feedback_bridge import try_handle_feedback_via_api, try_dismiss_feedback_via_api
from tools.payment_tools import (
    verify_webhook_signature,
    handle_payment_webhook,
    razorpay_status_message,
    handle_payment_link_callback,
    prepare_checkout_page,
    render_checkout_html,
    verify_checkout_payment,
    ensure_prepay_payment_link,
    build_checkout_page_url,
)
from tools.auto_reply_filter import is_whatsapp_auto_reply
from tools.booking_mechanisms import (
    is_catalog_order,
    bridge_catalog_order_to_cart,
)
from agents.root_agent import route_message
from agents.supply_agent import handle_supply_message  # Module 11

import asyncio

from fastapi.responses import RedirectResponse, HTMLResponse
import httpx, os

# ── Lifespan ───────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    sha = os.getenv("RAILWAY_GIT_COMMIT_SHA", "unknown")
    logger.info(f"Starting Munafe bot... commit={sha} integration_model=no_phone_number")
    logger.info(f"[razorpay] status={razorpay_status_message()}")
    await init_db()
    from tools.scheduler_tools import start_scheduler
    await start_scheduler()
    yield

    logger.info("Shutting down Munafe bot...")
    from tools.whatsapp_tools import close_http_client
    await close_http_client()
    from tools.supply_whatsapp import close_supply_http_client  # Module 11
    await close_supply_http_client()
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


def _normalize_whatsapp_phone(raw: str | None) -> str:
    digits = "".join(ch for ch in str(raw or "") if ch.isdigit())
    if len(digits) == 12 and digits.startswith("91"):
        return digits[2:]
    return digits


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
                if isinstance(raw, dict):
                    data = raw
                elif isinstance(raw, str) and raw.strip():
                    data = json.loads(raw)
                else:
                    data = {}
                date_str   = (
                    data.get("reservation_date")
                    or data.get("date")
                    or data.get("delivery_date")
                    or data.get("pickup_date")
                    or ""
                )
                time_str   = (
                    data.get("reservation_time")
                    or data.get("time")
                    or data.get("delivery_time")
                    or data.get("pickup_time")
                    or ""
                )
                # flow_token is inside response_json (set when the Flow was sent)
                flow_token = data.get(
                    "flow_token",
                    message_obj.get("context", {}).get("id", "unknown"),
                )
                if date_str and time_str:
                    return f"FLOW:{flow_token}|date={date_str}|time={time_str}"
                logger.warning(f"nfm_reply missing date/time fields: {data}")
                return "FLOW_PARSE_FAILED"
            except Exception as e:
                logger.error(f"Failed to parse nfm_reply response_json: {e} | raw={raw}")
                return "FLOW_PARSE_FAILED"

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
    phone: str | None = None
    restaurant_id: str | None = None
    manager_phone: str | None = None
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

        # Skip truly unhandled types (not order, not interactive calendar replies)
        if not message_body and msg_type not in ("order", "interactive"):
            logger.info(f"Skipping unhandled message type={msg_type!r}")
            return
        if not message_body and msg_type == "interactive":
            interactive_type = message_obj.get("interactive", {}).get("type", "")
            if interactive_type == "nfm_reply":
                message_body = "FLOW_PARSE_FAILED"
            else:
                logger.info(f"Skipping unhandled interactive type={interactive_type!r}")
                return

        # 2b. Skip auto-replies (WhatsApp Business auto-responders)
        # These fire when the customer's number has an auto-reply configured.
        # Responding to them creates a confusing conversation loop.
        # We detect them by text pattern OR by context.from == our own number.
        _our_phone = settings.whatsapp_phone_number
        if is_whatsapp_auto_reply(message_obj, message_body, _our_phone):
            logger.info(
                f"[auto-reply] Ignoring auto-reply from {message_obj.get('from')} "
                f"body={message_body[:80]!r}"
            )
            return

        # 3. Restaurant lookup (DB is canonical — env phone IDs are dev fallback only)
        parsed = await parse_incoming(payload)
        phone  = message_obj.get("from")
        metadata = value.get("metadata", {})

        # Ignore Meta echoes of our own outbound messages.
        our_display_phone = _normalize_whatsapp_phone(metadata.get("display_phone_number"))
        incoming_phone = _normalize_whatsapp_phone(phone)
        if our_display_phone and incoming_phone and incoming_phone == our_display_phone:
            logger.info("[webhook] ignoring outbound echo from own WABA number=%s", incoming_phone)
            return

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
                    logger.info(f"[CATALOG] Successfully merged order into cart for {phone}")
                    in_checkout = session_state.get("booking_step") in (
                        "awaiting_special_notes",
                        "awaiting_prepay",
                        "confirming_order",
                    )
                    if in_checkout:
                        await send_whatsapp_message(
                            phone,
                            "We've noted those items — please finish payment for your "
                            "current order first. Reply *Home* to start a fresh order.",
                            restaurant_id,
                        )
                    else:
                        from tools.cart_tools import send_catalog_cart_acknowledgment
                        await send_catalog_cart_acknowledgment(
                            phone, restaurant_id, session_state,
                        )
                    touch_session_activity(session_state)
                    await save_session_state(restaurant_id, phone, session_state)
                    return
                else:
                    logger.warning(f"[CATALOG] Failed to bridge order for {phone}")
                    await send_whatsapp_message(
                        phone,
                        "We had trouble processing your catalog order. "
                        "Please try again, or type *MENU* to order from our list. 🙏",
                        restaurant_id,
                    )
                    return

            # 5b. Feedback reply — delegate to Node before booking routing
            if msg_type in ("text", "button", "interactive") and is_reset_keyword(message_body):
                await try_dismiss_feedback_via_api(phone, restaurant_id)
            elif msg_type in ("text", "button", "interactive"):
                fb_result = await try_handle_feedback_via_api(phone, message_obj, restaurant_id)
                if fb_result.get("consumed"):
                    if fb_result.get("completed"):
                        mark_session_visit_complete(session_state)
                    touch_session_activity(session_state)
                    await save_session_state(restaurant_id, phone, session_state)
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
            touch_session_activity(session_state)
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
        if phone and restaurant_id:
            try:
                if manager_phone and phone == manager_phone:
                    fallback = (
                        "Sorry, something went wrong processing that command. "
                        "Please try again or use the Manager Portal."
                    )
                else:
                    fallback = (
                        "Sorry, something went wrong while saving your pickup time. "
                        "Please try again in a moment, or reply *Home* to start over."
                    )
                await send_whatsapp_message(phone, fallback, restaurant_id)
            except Exception:
                logger.exception("Failed to send webhook error fallback to customer")


# ── Module 11: Supply payload processor ───────────────────────────────────────

async def _process_supply_payload(payload: dict):
    """
    Process a supply WhatsApp webhook payload forwarded by autom8-backend-supply.

    The Node.js webhook already resolved supplier_id and client_id and injected
    them as _supply_context — no DB lookup needed here for routing.
    """
    try:
        value = (
            payload.get("entry", [{}])[0]
                   .get("changes", [{}])[0]
                   .get("value", {})
        )

        messages = value.get("messages")
        if not messages:
            return  # status-only update, nothing to process

        message_obj = messages[0]
        message_id  = message_obj.get("id", "")

        # Dedup — share the restaurant dedup set (Meta message IDs are globally unique)
        async with _processed_message_ids_lock:
            if message_id in _processed_message_ids:
                return
            _processed_message_ids[message_id] = 1
            if len(_processed_message_ids) > 1000:
                _processed_message_ids.popitem(last=False)

        # Context injected by Node.js resolveSupplier.js
        supply_context = value.get("_supply_context", {})
        supplier_id    = supply_context.get("supplier_id")
        client_id      = supply_context.get("client_id")   # None if unregistered number
        phone          = message_obj.get("from")

        if not supplier_id or not phone:
            logger.warning(
                f"[supply-webhook] Missing supplier_id={supplier_id} or phone={phone}, dropping"
            )
            return

        msg_type     = message_obj.get("type", "")
        message_body = _extract_message_body(message_obj)

        # Skip truly unhandleable types (stickers, reactions, etc.)
        if not message_body and msg_type not in ("audio", "image", "document"):
            logger.info(f"[supply-webhook] Skipping unhandled type={msg_type!r}")
            return

        logger.info(
            f"[supply-webhook] supplier={supplier_id} client={client_id} "
            f"phone={phone} type={msg_type!r}"
        )

        await handle_supply_message(
            phone           = phone,
            supplier_id     = supplier_id,
            client_id       = client_id,
            message         = message_body,
            message_type    = msg_type,
            raw_message_obj = message_obj,
        )

    except Exception as e:
        logger.error(f"[supply-webhook] Processing failed: {e}", exc_info=True)


@app.get("/health/razorpay")
async def health_razorpay():
    """Diagnostic — confirms keys loaded (no secrets exposed)."""
    from tools.payment_tools import _RAZORPAY_IMPORT_ERROR

    payload: dict[str, str] = {"status": razorpay_status_message()}
    if _RAZORPAY_IMPORT_ERROR:
        payload["import_error"] = _RAZORPAY_IMPORT_ERROR
    return JSONResponse(payload)


def _verify_internal_secret(request: Request) -> bool:
    from tools.booking_mechanisms import KDS_SECRET
    if not KDS_SECRET:
        return False
    auth = request.headers.get("authorization") or ""
    bearer = auth.split(" ", 1)[1] if auth.lower().startswith("bearer ") else ""
    candidate = (
        bearer
        or request.headers.get("x-internal-secret")
        or ""
    )
    return candidate == KDS_SECRET


@app.post("/internal/scheduled-approval-payment")
async def internal_scheduled_approval_payment(request: Request):
    """Node API calls this after manager approves a scheduled order."""
    if not _verify_internal_secret(request):
        raise HTTPException(status_code=403, detail="Forbidden")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    restaurant_id = body.get("restaurant_id")
    token = body.get("token")
    if not restaurant_id or not token:
        raise HTTPException(status_code=400, detail="restaurant_id and token required")

    from tools.scheduled_payment import trigger_scheduled_payment_after_approval

    result = await trigger_scheduled_payment_after_approval(
        str(restaurant_id),
        token,
        manager_phone=body.get("manager_phone"),
    )
    status_code = 200 if result.get("ok") else 500
    return JSONResponse(status_code=status_code, content=result)


@app.post("/internal/webcart-confirm-pay")
async def internal_webcart_confirm_pay(request: Request):
    """Node API calls this after webcart submit to send customer-facing Confirm & Pay CTA."""
    if not _verify_internal_secret(request):
        raise HTTPException(status_code=403, detail="Forbidden")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    restaurant_id = str(body.get("restaurant_id") or "").strip()
    customer_phone = str(body.get("customer_phone") or "").strip()
    customer_name = str(body.get("customer_name") or "Guest").strip() or "Guest"
    service_type = str(body.get("service_type") or "takeaway").strip().lower()
    token_label = str(body.get("token") or "").strip()
    order_ref = str(body.get("order_ref") or "").strip()
    items = body.get("items") or []

    try:
        total = float(body.get("total") or 0)
    except Exception:
        total = 0.0

    if not restaurant_id or not customer_phone or not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="restaurant_id, customer_phone, and items are required")
    if total < 1:
        raise HTTPException(status_code=400, detail="total must be at least 1")

    if service_type not in ("takeaway", "delivery", "dine_in"):
        service_type = "takeaway"

    phone_digits = "".join(ch for ch in customer_phone if ch.isdigit())
    phone_candidates = [customer_phone, phone_digits]
    if len(phone_digits) == 10:
        phone_candidates.append(f"91{phone_digits}")
    if len(phone_digits) == 12 and phone_digits.startswith("91"):
        phone_candidates.append(phone_digits[2:])
    phone_candidates = [p for p in dict.fromkeys([p.strip() for p in phone_candidates if p and p.strip()])]
    canonical_phone = phone_candidates[0]

    customer = None
    for ph in phone_candidates:
        customer = await get_customer(restaurant_id, ph)
        if customer:
            canonical_phone = ph
            break

    if not customer:
        customer = await create_customer(
            restaurant_id,
            canonical_phone,
            customer_name,
            profile_name=customer_name,
        )

    customer_id = str(customer.get("id") or "").strip()
    if not customer_id:
        raise HTTPException(status_code=500, detail="Customer resolution failed")

    token_number = await get_next_token_number(restaurant_id)
    booking = await create_booking(
        restaurant_id,
        customer_id,
        service_type,
        token_number=token_number,
    )
    booking_id = str(booking.get("id") or "").strip()
    if not booking_id:
        raise HTTPException(status_code=500, detail="Booking creation failed")

    session_state: dict = {
        "payment_mode": "prepay",
        "service_type": service_type,
        "order_total": total,
    }
    payment_link = await ensure_prepay_payment_link(
        booking_id,
        total,
        customer_name,
        f"Web cart {service_type.replace('_', ' ')} order",
        customer_phone=canonical_phone,
        session_state=session_state,
    )

    if not payment_link:
        fallback_text = (
            "We couldn't create your payment link right now.\n"
            f"Order ref: {order_ref or booking_id[-8:]}\n"
            f"Total: INR {total:.0f}\n\n"
            "Please reply *PAY* in this chat and we'll resend your payment link."
        )
        try:
            await send_whatsapp_message(canonical_phone, fallback_text, restaurant_id)
        except Exception as _send_err:
            logger.warning(
                "[webcart-confirm-pay] fallback whatsapp failed booking_id=%s err=%s",
                booking_id,
                _send_err,
            )
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "payment_link_unavailable", "booking_id": booking_id},
        )

    # Durable persistence — mirrors every other booking flow (takeaway_flow,
    # delivery_flow, dine_in_flow, reserve_table_flow). The hosted /pay
    # checkout page reads session_state["order_total"] first, but that key
    # lives only in the ephemeral WhatsApp conversation session and is lost
    # the moment any other inbound message re-saves session_state before the
    # customer taps "Confirm & Pay". Without this, prepare_checkout_page()
    # falls back to load_prepay_payload(), which previously found nothing
    # for web-cart orders and returned {"error": "amount_missing"} — this is
    # the root cause of the takeaway/delivery "Payment unavailable" bug.
    from tools.prepay_fulfillment import build_prepay_payload, stash_and_persist_prepay_payload

    cart_snapshot = {}
    for idx, row in enumerate(items, start=1):
        if not isinstance(row, dict):
            continue
        try:
            qty = int(row.get("qty") or 0)
        except Exception:
            qty = 0
        if qty <= 0:
            continue
        name = str(row.get("name") or "Item").strip() or "Item"
        item_id = str(
            row.get("retailer_id")
            or row.get("id")
            or row.get("sku")
            or name
            or f"item_{idx}"
        ).strip() or f"item_{idx}"
        try:
            unit_price = float(row.get("unit_price") or row.get("price") or 0)
        except Exception:
            unit_price = 0.0
        cart_snapshot[item_id] = {
            "title": name,
            "qty": qty,
            "unit_price": unit_price,
        }

    prepay_payload = build_prepay_payload(
        service_type=service_type,
        session_state=session_state,
        restaurant_id=restaurant_id,
        customer_id=customer_id,
        customer_name=customer_name,
        customer_phone=canonical_phone,
        booking_id=booking_id,
        token=token_label or str(token_number),
        total=total,
        booking_time=datetime.utcnow().isoformat(),
        order_text_display="\n".join(
            f"{int(row.get('qty') or 0)}x {str(row.get('name') or 'Item').strip()}"
            for row in items if int(row.get('qty') or 0) > 0
        ),
        cart_snapshot=cart_snapshot,
        totals={"total": total},
        order_ref=order_ref,
    )

    try:
        await stash_and_persist_prepay_payload(session_state, booking_id, prepay_payload)
    except Exception as _payload_err:
        logger.warning(
            f"[webcart-confirm-pay] prepay payload persistence failed for {booking_id}: {_payload_err}"
        )
        # Non-fatal on its own, but without this the checkout page can still
        # amount_missing if the session is lost — log loudly for ops.

    try:
        await save_session_state(restaurant_id, canonical_phone, session_state)
    except Exception as _sess_err:
        logger.warning(f"[webcart-confirm-pay] session save failed for {booking_id}: {_sess_err}")
        # Non-fatal — payment link was created; customer can still pay.

    preview_lines = []
    for row in items[:6]:
        try:
            qty = int(row.get("qty") or 0)
        except Exception:
            qty = 0
        name = str(row.get("name") or "Item").strip() or "Item"
        if qty > 0:
            preview_lines.append(f"- {qty}x {name}")
    order_preview = "\n".join(preview_lines)
    if len(items) > 6:
        order_preview += f"\n- +{len(items) - 6} more item(s)"

    body_text = (
        "Your order is almost confirmed.\n\n"
        f"Order ref: {order_ref or booking_id[-8:]}\n"
        f"Token: {token_label or token_number}\n"
        f"Total: INR {total:.0f}\n\n"
        f"{order_preview}\n\n"
        "Tap Confirm & Pay to complete payment securely via Razorpay."
    ).strip()

    sent = await send_whatsapp_cta_url(
        canonical_phone,
        restaurant_id,
        body_text=body_text,
        button_text="Confirm & Pay",
        url=str(payment_link),
        header_text="Confirm Your Order",
        footer_text="Secure payment powered by Razorpay",
    )

    if not sent:
        fallback_text = (
            "Your order is almost confirmed.\n"
            f"Order ref: {order_ref or booking_id[-8:]}\n"
            f"Total: INR {total:.0f}\n\n"
            "Confirm & Pay:\n"
            f"{payment_link}"
        )
        sent = await send_whatsapp_message(canonical_phone, fallback_text, restaurant_id)

    if not sent:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "whatsapp_send_failed", "booking_id": booking_id},
        )

    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "booking_id": booking_id,
            "payment_link": payment_link,
            "customer_phone": canonical_phone,
        },
    )


@app.get("/payment/complete")
async def payment_complete(request: Request):
    """Customer redirect after Razorpay checkout (Orders API or legacy payment links)."""
    from html import escape

    params = dict(request.query_params)
    simple_status = params.get("status", "")
    status = params.get("razorpay_payment_link_status", "") or simple_status
    result: dict = {}

    if params.get("razorpay_payment_link_id"):
        if status == "paid":
            result = await handle_payment_link_callback(params)
            if not result.get("ok"):
                logger.warning(f"[razorpay] Callback not fulfilled: {result}")
        elif status in ("cancelled", "failed", "expired"):
            result = await handle_payment_link_callback(params)
    elif simple_status == "paid":
        result = {"ok": True, "fulfilled": True}

    retry_url = params.get("retry", "")
    support_phone = ""
    waba_phone = ""
    restaurant_name = "your restaurant"

    booking_id_hint = (
        params.get("booking_id")
        or params.get("reference_id")
        or params.get("razorpay_payment_link_reference_id")
        or ""
    )
    if not booking_id_hint and retry_url:
        import re
        m = re.search(r"/pay/([0-9a-fA-F-]{36})", retry_url)
        if m:
            booking_id_hint = m.group(1)

    if status in ("failed", "cancelled", "expired"):
        logger.info(
            "[payment-complete] status=%s reason=%s booking_hint=%s has_retry=%s",
            status,
            str(params.get("reason") or ""),
            booking_id_hint or "",
            bool(retry_url),
        )

    if booking_id_hint:
        try:
            from tools.db_tools import get_booking_with_customer
            from tools.booking_mechanisms import fetch_restaurant_info

            booking = await get_booking_with_customer(str(booking_id_hint))
            if booking and booking.get("restaurant_id"):
                info = await fetch_restaurant_info(str(booking["restaurant_id"]))
                restaurant_name = (
                    (info.get("display_name") or "").strip()
                    or (info.get("name") or "").strip()
                    or restaurant_name
                )

                digits = "".join(ch for ch in str(info.get("whatsapp_number") or info.get("phone") or "") if ch.isdigit())
                if digits:
                    support_phone = digits

                rest = await get_restaurant_by_id(str(booking["restaurant_id"]))
                if rest and rest.get("whatsapp_number"):
                    waba_phone = str(rest.get("whatsapp_number"))
        except Exception as _meta_err:
            logger.debug(f"[payment-complete] metadata resolve failed: {_meta_err}")

    title = "Payment status"
    message = "Return to WhatsApp and reply <em>pay</em> to get a new payment link."
    cause_hint = ""
    tone = "neutral"

    if status == "paid" and result.get("fulfilled") is not False and result.get("ok") is not False:
        title = "Thank you!"
        message = "Your payment was received. Return to WhatsApp for confirmation."
        tone = "ok"
    elif status == "paid":
        title = "Payment received"
        message = (
            "We received your payment. If confirmation does not arrive in a few minutes, "
            "send <em>pay</em> on WhatsApp to retry confirmation."
        )
        tone = "ok"
    elif status in ("cancelled", "failed", "expired"):
        title = "Payment not completed"
        message = (
            "No worries. Return to WhatsApp and tap Confirm &amp; Pay again, "
            "or retry payment below."
        )
        cause_hint = (
            "This can happen due to network interruption, app close, bank timeout, "
            "or UPI/card cancellation."
        )
        tone = "warn"

    chat_phone = _normalize_whatsapp_phone(waba_phone) or _normalize_whatsapp_phone(support_phone)
    safe_status = escape(status or "unknown")
    safe_support_phone = escape(support_phone, quote=True)
    safe_chat_phone = escape(chat_phone, quote=True)
    safe_retry = escape(retry_url, quote=True)

    retry_btn = ""
    if retry_url:
        retry_btn = f'<a class="btn btn-secondary" href="{safe_retry}">Try Payment Again</a>'

    cause_block = ""
    if cause_hint:
        cause_block = f'<p class="help">{cause_hint}</p>'

    support_actions = ""
    if support_phone:
        support_actions = f"""
        <p class=\"help\">To speak with customer care, call <strong>{safe_support_phone}</strong>.</p>
        <div class=\"support-row\">
            <a class=\"support-link\" href=\"tel:{safe_support_phone}\">Call Support</a>
            <a class=\"support-link\" href=\"https://wa.me/{safe_support_phone}\">WhatsApp Support</a>
        </div>
        """

    html = f"""
<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>{title}</title>
    <style>
        :root {{
            --ink: #0f172a;
            --muted: #475569;
            --line: #e2e8f0;
            --ok-bg: #ecfdf3;
            --ok-line: #86efac;
            --warn-bg: #fff7ed;
            --warn-line: #fdba74;
            --cta: #e36d26;
        }}
        * {{ box-sizing: border-box; }}
        body {{
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #f8fafc;
            color: var(--ink);
            min-height: 100vh;
            display: grid;
            place-items: center;
            padding: 20px;
        }}
        .card {{
            width: min(560px, 100%);
            background: #fff;
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 22px;
        }}
        .status {{
            border-radius: 12px;
            padding: 12px 14px;
            font-size: 13px;
            margin-bottom: 14px;
        }}
        .status.ok {{ background: var(--ok-bg); border: 1px solid var(--ok-line); }}
        .status.warn {{ background: var(--warn-bg); border: 1px solid var(--warn-line); }}
        h1 {{ margin: 0 0 8px; font-size: 34px; line-height: 1.1; }}
        p {{ margin: 0; color: var(--muted); font-size: 18px; line-height: 1.5; }}
        .actions {{ display: grid; gap: 10px; margin-top: 18px; }}
        .btn {{
            appearance: none;
            text-decoration: none;
            border-radius: 12px;
            padding: 13px 14px;
            text-align: center;
            font-weight: 700;
            border: 1px solid transparent;
            cursor: pointer;
        }}
        .btn-primary {{ background: var(--cta); color: #fff; border-color: var(--cta); }}
        .btn-secondary {{ background: #fff; color: var(--ink); border-color: var(--line); }}
        .help {{ margin-top: 10px; font-size: 13px; color: #64748b; }}
        .support-row {{ margin-top: 10px; display: flex; gap: 10px; flex-wrap: wrap; }}
        .support-link {{
            text-decoration: none;
            border-radius: 999px;
            border: 1px solid var(--line);
            color: var(--ink);
            padding: 8px 12px;
            font-size: 12px;
            font-weight: 700;
            background: #fff;
        }}
    </style>
    <script>
        function goToWhatsApp() {{
            var ua = String(navigator.userAgent || '').toLowerCase();
            var supportPhone = '{safe_chat_phone}';
            var chatUrl = supportPhone ? ('https://wa.me/' + supportPhone) : 'https://web.whatsapp.com/';
            var movedAway = false;
            function onHide() {{
                movedAway = true;
                document.removeEventListener('visibilitychange', onHide);
            }}
            document.addEventListener('visibilitychange', onHide, {{ once: true }});
            if (ua.indexOf('android') >= 0) {{
                window.location.href = 'intent://send/#Intent;scheme=whatsapp;package=com.whatsapp;end';
                setTimeout(function () {{
                    if (!movedAway && document.visibilityState === 'visible') {{
                        window.location.href = chatUrl;
                    }}
                }}, 1500);
                return;
            }}
            if (/(iphone|ipad|ipod)/.test(ua)) {{
                window.location.href = 'whatsapp://send';
                setTimeout(function () {{
                    if (!movedAway && document.visibilityState === 'visible') {{
                        window.location.href = chatUrl;
                    }}
                }}, 1500);
                return;
            }}
            window.location.href = supportPhone ? ('https://web.whatsapp.com/send?phone=' + supportPhone) : 'https://web.whatsapp.com/';
        }}
    </script>
</head>
<body>
    <main class="card">
        <div class="status {tone}">Payment status: {safe_status}</div>
        <h1>{title}</h1>
        <p>{message}</p>
        {cause_block}
        <div class="actions">
            <button class="btn btn-primary" type="button" onclick="goToWhatsApp()">Return to WhatsApp</button>
            {retry_btn}
        </div>
        <p class="help">🙏 Thank you for reaching out to <strong>{escape(restaurant_name)}</strong>.</p>
        <p class="help">To place an order or check your queue, message us on WhatsApp.</p>
        {support_actions}
        <p class="help">Works for dine-in, takeaway, and delivery prepay flows.</p>
    </main>
</body>
</html>
"""

    return HTMLResponse(html, status_code=200)


@app.get("/pay/{booking_id}")
async def pay_checkout(booking_id: str, request: Request):
    """Hosted Razorpay Checkout page (Orders API — unlimited test checkouts)."""
    support_phone = ""
    waba_phone = ""
    restaurant_name = "your restaurant"
    booking: dict | None = None

    async def notify_customer_pay_fallback(reason: str) -> None:
        """Best-effort WhatsApp fallback when hosted checkout cannot open."""
        if not booking:
            return

        restaurant_id = str(booking.get("restaurant_id") or "").strip()
        customer_phone = str(
            booking.get("customer_phone")
            or booking.get("phone")
            or booking.get("customer_whatsapp")
            or ""
        ).strip()
        if not restaurant_id or not customer_phone:
            return

        try:
            retry_url = build_checkout_page_url(str(booking_id))
        except Exception:
            retry_url = ""

        text = (
            "Your payment page did not open just now.\n"
            f"Order: {str(booking.get('token_number') or booking_id[-8:])}\n\n"
            "Please reply *PAY* to receive a fresh payment link."
        )
        if retry_url:
            text += f"\n\nRetry link:\n{retry_url}"

        try:
            sent = await send_whatsapp_message(customer_phone, text, restaurant_id)
            if sent:
                logger.info(
                    "[pay-checkout] fallback message sent booking_id=%s reason=%s",
                    booking_id,
                    reason,
                )
            else:
                logger.warning(
                    "[pay-checkout] fallback message send failed booking_id=%s reason=%s",
                    booking_id,
                    reason,
                )
        except Exception as _notify_err:
            logger.warning(
                "[pay-checkout] fallback notify error booking_id=%s reason=%s err=%s",
                booking_id,
                reason,
                _notify_err,
            )

    def render_pay_error_page(title: str, message: str, status_code: int, ref: str = ""):
        ref_line = f"<p class='help'>Reference: <strong>{ref}</strong></p>" if ref else ""
        chat_phone = _normalize_whatsapp_phone(waba_phone) or _normalize_whatsapp_phone(support_phone)
        html = f"""
<!doctype html>
<html lang='en'>
<head>
    <meta charset='utf-8' />
    <meta name='viewport' content='width=device-width, initial-scale=1' />
    <title>{title}</title>
    <style>
        body {{ font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; margin: 0; padding: 18px; background: #f8fafc; color: #0f172a; }}
        .card {{ max-width: 620px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 18px; }}
        h1 {{ margin: 0 0 10px; font-size: 40px; line-height: 1.05; }}
        p {{ margin: 0; font-size: 19px; line-height: 1.5; color: #334155; }}
        .actions {{ margin-top: 16px; display: grid; gap: 10px; }}
        .btn {{ text-decoration: none; text-align: center; border-radius: 12px; padding: 12px 14px; font-weight: 700; border: 1px solid transparent; }}
        .btn-primary {{ background: #e36d26; color: #fff; border-color: #e36d26; }}
        .btn-secondary {{ background: #fff; color: #0f172a; border-color: #e2e8f0; }}
        .help {{ margin-top: 10px; font-size: 13px; color: #64748b; }}
    </style>
</head>
<body>
    <main class='card'>
        <h1>{title}</h1>
        <p>{message}</p>
        <div class='actions'>
            <a class='btn btn-primary' href='{'https://wa.me/' + chat_phone if chat_phone else 'https://web.whatsapp.com/'}'>Open WhatsApp</a>
            <a class='btn btn-secondary' href='{'tel:' + chat_phone if chat_phone else '#'}'>Call Support</a>
        </div>
        <p class='help'>🙏 Thank you for reaching out to <strong>{restaurant_name}</strong>.</p>
        <p class='help'>Reply <strong>pay</strong> on WhatsApp to receive a fresh payment link.</p>
        {ref_line}
    </main>
</body>
</html>
"""
        return HTMLResponse(html, status_code=status_code)

    token = request.query_params.get("t", "")
    logger.info(
        "[pay-checkout] open booking_id=%s token_present=%s ua=%s",
        booking_id,
        bool(token),
        (request.headers.get("user-agent") or "")[:120],
    )

    # Quick UUID-format guard to avoid avoidable server exceptions on malformed links.
    try:
        from uuid import UUID
        UUID(str(booking_id))
    except Exception:
        logger.warning("[pay-checkout] invalid booking id format booking_id=%s", booking_id)
        return render_pay_error_page(
            "Invalid payment link",
            "This payment URL is not valid. Return to WhatsApp and tap Confirm & Pay again.",
            400,
        )

    # Best-effort dynamic fallback details for support pages.
    try:
        from tools.db_tools import get_booking_with_customer
        from tools.booking_mechanisms import fetch_restaurant_info

        booking = await get_booking_with_customer(str(booking_id))
        if booking and booking.get("restaurant_id"):
            info = await fetch_restaurant_info(str(booking["restaurant_id"]))
            restaurant_name = (
                (info.get("display_name") or "").strip()
                or (info.get("name") or "").strip()
                or restaurant_name
            )
            digits = "".join(
                ch for ch in str(info.get("whatsapp_number") or info.get("phone") or "") if ch.isdigit()
            )
            if digits:
                support_phone = digits

            rest = await get_restaurant_by_id(str(booking["restaurant_id"]))
            if rest and rest.get("whatsapp_number"):
                waba_phone = str(rest.get("whatsapp_number"))
    except Exception as _ctx_err:
        logger.debug("[pay-checkout] support details resolve failed booking_id=%s err=%s", booking_id, _ctx_err)

    try:
        ctx = await prepare_checkout_page(booking_id, token)
    except Exception as exc:
        from uuid import uuid4

        error_ref = str(uuid4())[:8]
        logger.exception(
            "[pay-checkout] unhandled error ref=%s booking_id=%s token_present=%s: %s",
            error_ref,
            booking_id,
            bool(token),
            exc,
        )
        await notify_customer_pay_fallback("prepare_checkout_exception")
        return render_pay_error_page(
            "Payment temporarily unavailable",
            "We could not open the payment page right now. Please return to WhatsApp and tap Confirm & Pay again.",
            503,
            error_ref,
        )

    if ctx.get("error") == "invalid_token":
        logger.info("[pay-checkout] invalid token booking_id=%s", booking_id)
        await notify_customer_pay_fallback("invalid_token")
        return render_pay_error_page(
            "Invalid or expired payment link",
            "This link has expired. Please return to WhatsApp and request a fresh link.",
            403,
        )
    if ctx.get("error") == "booking_not_found":
        logger.info("[pay-checkout] booking not found booking_id=%s", booking_id)
        return render_pay_error_page(
            "Order not found",
            "We could not find this order. Please return to WhatsApp and send Hi to restart.",
            404,
        )
    if ctx.get("already_paid"):
        logger.info("[pay-checkout] already paid booking_id=%s", booking_id)
        return HTMLResponse(
            "<h1>Already paid ✅</h1><p>Return to WhatsApp for your confirmation.</p>",
            status_code=200,
        )
    if ctx.get("error"):
        logger.warning("[pay-checkout] payment unavailable booking_id=%s reason=%s", booking_id, str(ctx.get("error")))
        await notify_customer_pay_fallback(f"ctx_error:{str(ctx.get('error'))}")
        return render_pay_error_page(
            "Payment unavailable",
            f"Payment could not start ({ctx['error']}). Please return to WhatsApp and tap Confirm & Pay again.",
            400,
        )
    return HTMLResponse(render_checkout_html(ctx), status_code=200)


@app.post("/pay/verify")
async def pay_verify(request: Request):
    """Verify Razorpay Checkout payment signature after customer pays."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    logger.info(
        "[pay-verify] order_id=%s payment_id=%s",
        str(body.get("razorpay_order_id") or ""),
        str(body.get("razorpay_payment_id") or ""),
    )

    result = await verify_checkout_payment(body)
    logger.info(
        "[pay-verify] ok=%s booking_id=%s reason=%s",
        bool(result.get("ok")),
        str(result.get("booking_id") or ""),
        str(result.get("reason") or ""),
    )
    status_code = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status_code, content=result)


@app.post("/pay/failure-event")
async def pay_failure_event(request: Request):
    """Client-side Razorpay failure telemetry from hosted checkout page."""
    try:
        body = await request.json()
    except Exception:
        body = {}

    kind = str(body.get("kind") or "unknown")
    booking_id = str(body.get("booking_id") or "")
    order_id = str(body.get("order_id") or "")
    details = body.get("details") if isinstance(body.get("details"), dict) else {}

    logger.warning(
        "[razorpay][client-failure] kind=%s booking_id=%s order_id=%s reason=%s code=%s source=%s step=%s desc=%s",
        kind,
        booking_id,
        order_id,
        str(details.get("reason") or ""),
        str(details.get("code") or ""),
        str(details.get("source") or ""),
        str(details.get("step") or ""),
        str(details.get("description") or "")[:180],
    )

    # Tenant-safe manager alert for live gateway failures.
    if booking_id:
        try:
            from tools.db_tools import get_booking_with_customer

            booking = await get_booking_with_customer(str(booking_id))
            if booking and booking.get("restaurant_id"):
                restaurant = await get_restaurant_by_id(str(booking["restaurant_id"]))
                manager_phone = str((restaurant or {}).get("manager_phone") or "").strip()
                if manager_phone:
                    token = str(booking.get("token_number") or booking_id[-8:])
                    failure_reason = str(details.get("reason") or kind or "payment_failed")
                    note = (
                        "⚠️ Payment attempt failed\n"
                        f"Token: {token}\n"
                        f"Customer: {str(booking.get('customer_phone') or '')}\n"
                        f"Reason: {failure_reason}\n"
                        "Customer can retry from the same payment link."
                    )
                    await send_whatsapp_message(manager_phone, note, str(booking["restaurant_id"]))
        except Exception as _mgr_err:
            logger.debug("[pay-failure-event] manager alert skipped booking_id=%s err=%s", booking_id, _mgr_err)

    return JSONResponse(status_code=200, content={"ok": True})


@app.get("/webhook/razorpay")
async def razorpay_webhook_probe():
    """Browser/Razorpay URL check — real events must use POST."""
    return JSONResponse({
        "status": "ok",
        "message": "Razorpay webhook endpoint is live. Configure payment.captured and order.paid events here.",
    })


@app.post("/webhook/razorpay")
async def razorpay_webhook(request: Request):
    """Razorpay payment events (configure in Razorpay Dashboard → Webhooks)."""
    body_bytes = await request.body()
    body_text = body_bytes.decode("utf-8")
    signature = request.headers.get("X-Razorpay-Signature", "")

    if not await verify_webhook_signature(body_text, signature):
        raise HTTPException(status_code=400, detail="Invalid Razorpay signature")

    try:
        payload = json.loads(body_text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    result = await handle_payment_webhook(payload)
    status_code = 200 if result.get("ok", True) else 500
    return JSONResponse(status_code=status_code, content=result)


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


# ── Module 11: Supply webhook routes ──────────────────────────────────────────

@app.get("/webhook/supply")
async def verify_supply_webhook(request: Request):
    """Meta webhook verification for the supplier WABA number."""
    params = request.query_params
    if (
        params.get("hub.mode") == "subscribe"
        and params.get("hub.verify_token") == settings.supply_webhook_verify_token
    ):
        return PlainTextResponse(content=params.get("hub.challenge"), status_code=200)
    return PlainTextResponse(content="Verification failed", status_code=403)


@app.post("/webhook/supply")
async def supply_webhook_post(request: Request, background_tasks: BackgroundTasks):
    """
    Receives WhatsApp messages forwarded by autom8-backend-supply.
    Uses SUPPLY_WEBHOOK_SECRET for signature verification (separate from restaurant secret).
    """
    body      = await request.body()
    signature = request.headers.get("x-hub-signature-256", "")

    if not _verify_supply_signature(body, signature):
        return JSONResponse(status_code=200, content={"status": "invalid signature"})

    payload = await request.json()
    background_tasks.add_task(_process_supply_payload, payload)
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


def _verify_supply_signature(body: bytes, signature: str) -> bool:
    """Mirror of _verify_meta_signature but uses SUPPLY_WEBHOOK_SECRET."""
    is_prod = settings.environment == "production"

    if not settings.supply_webhook_secret:
        if is_prod:
            logger.error("[supply-webhook] SUPPLY_WEBHOOK_SECRET not set in production")
            return False
        return True  # local dev without secret configured

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
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
