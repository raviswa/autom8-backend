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
        cart_snapshot={"items": items},
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

    if status == "paid" and result.get("fulfilled") is not False and result.get("ok") is not False:
        html = (
            "<h1>Thank you! 🙏</h1>"
            "<p>Your payment was received. You can return to WhatsApp — "
            "we'll confirm your order there shortly.</p>"
        )
    elif status == "paid":
        html = (
            "<h1>Payment received ✅</h1>"
            "<p>We received your payment. If you don't get a WhatsApp confirmation "
            "within a few minutes, please message us <em>pay</em> to retry confirmation.</p>"
        )
    elif status in ("cancelled", "failed", "expired"):
        html = (
            "<h1>Payment not completed</h1>"
            "<p>Your payment was not completed. Return to WhatsApp — "
            "we've sent you a link to try again.</p>"
        )
    else:
        html = (
            "<h1>Payment status unknown</h1>"
            "<p>Return to WhatsApp and reply <em>pay</em> to get your payment link, "
            "or type <em>Home</em> to start over.</p>"
        )

    return HTMLResponse(html, status_code=200)


@app.get("/pay/{booking_id}")
async def pay_checkout(booking_id: str, request: Request):
    """Hosted Razorpay Checkout page (Orders API — unlimited test checkouts)."""
    token = request.query_params.get("t", "")
    ctx = await prepare_checkout_page(booking_id, token)
    if ctx.get("error") == "invalid_token":
        return HTMLResponse("<h1>Invalid or expired payment link</h1>", status_code=403)
    if ctx.get("error") == "booking_not_found":
        return HTMLResponse("<h1>Order not found</h1>", status_code=404)
    if ctx.get("already_paid"):
        return HTMLResponse(
            "<h1>Already paid ✅</h1><p>Return to WhatsApp for your confirmation.</p>",
            status_code=200,
        )
    if ctx.get("error"):
        return HTMLResponse(f"<h1>Payment unavailable</h1><p>{ctx['error']}</p>", status_code=400)
    return HTMLResponse(render_checkout_html(ctx), status_code=200)


@app.post("/pay/verify")
async def pay_verify(request: Request):
    """Verify Razorpay Checkout payment signature after customer pays."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    result = await verify_checkout_payment(body)
    status_code = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status_code, content=result)


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
