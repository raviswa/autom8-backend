"""FastAPI application entry point with webhook handlers."""

import json
import logging
import hmac
import hashlib
import os
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime

from fastapi import FastAPI, Request, HTTPException, BackgroundTasks, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse, PlainTextResponse

from config.settings import settings
from tools.db_tools import (
    extract_short_code,
    init_db,
    get_restaurant_by_whatsapp_number,
    get_restaurant_by_phone_number_id,
    get_restaurant_by_short_code,
    get_active_restaurant_for_phone,
    pin_active_restaurant_for_phone,
    get_active_short_codes_for_waba,
    get_customer,
    create_customer,
    create_booking,
    get_next_token_number,
    update_booking_status,
    get_session_state,
    save_session_state,
    customer_lock,
    get_restaurant_by_id,
    get_booking_with_customer,
)
from tools.whatsapp_tools import parse_incoming, send_whatsapp_message, send_whatsapp_cta_url
from agents.customer.booking_helpers import touch_session_activity, is_reset_keyword, mark_session_visit_complete, should_skip_feedback_bridge
from tools.feedback_bridge import try_handle_feedback_via_api, try_dismiss_feedback_via_api
from tools.payment_tools import (
    verify_webhook_signature,
    handle_payment_webhook,
    razorpay_status_message,
    handle_payment_link_callback,
    prepare_checkout_page,
    render_checkout_html,
    resolve_checkout_context,
    create_order_for_method,
    render_method_selection_html,
    verify_checkout_payment,
    ensure_prepay_payment_link,
)
from tools.phonepe_tools import (
    phonepe_status_message,
    prepare_phonepe_redirect,
    confirm_phonepe_return,
    verify_webhook_auth as verify_phonepe_webhook_auth,
    handle_payment_webhook as handle_phonepe_webhook,
)
from tools.booking_mechanisms import notify_manager_order_alert
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


class _LatencyTrace:
    """Per-message stage timer for webhook processing (Phase A instrumentation)."""

    __slots__ = ("wamid", "t0", "last", "breakdown")

    def __init__(self, wamid: str | None):
        self.wamid = wamid or "unknown"
        self.t0 = time.monotonic()
        self.last = self.t0
        self.breakdown: dict[str, int] = {}

    def mark(self, stage: str) -> int:
        now = time.monotonic()
        dur_ms = int((now - self.last) * 1000)
        self.last = now
        self.breakdown[stage] = self.breakdown.get(stage, 0) + dur_ms
        logger.info(f"[LATENCY] wamid={self.wamid} stage={stage} dur_ms={dur_ms}")
        return dur_ms

    def add(self, stage: str, dur_ms: int) -> None:
        """Accumulate a nested stage (e.g. send_wa) without moving the main cursor."""
        self.breakdown[stage] = self.breakdown.get(stage, 0) + int(dur_ms)
        logger.info(f"[LATENCY] wamid={self.wamid} stage={stage} dur_ms={int(dur_ms)}")

    def summary(self) -> None:
        total_ms = int((time.monotonic() - self.t0) * 1000)
        b = self.breakdown
        feedback_ms = (
            b.get("feedback_bridge", 0)
            + b.get("feedback_dismiss", 0)
            + b.get("feedback_handle", 0)
            + b.get("feedback_skipped", 0)
        )
        logger.info(
            f"[LATENCY] wamid={self.wamid} summary total_ms={total_ms} "
            f"resolve_ms={b.get('resolve_restaurant', 0)} "
            f"lock_ms={b.get('customer_lock', 0)} "
            f"session_get_ms={b.get('session_get', 0)} "
            f"special_notes_ms={b.get('special_notes', 0)} "
            f"feedback_ms={feedback_ms} "
            f"route_ms={b.get('route_message', 0)} "
            f"session_save_ms={b.get('session_save', 0)} "
            f"send_ms={b.get('send_wa', 0)}"
        )


async def _latency_send_wa(lat: _LatencyTrace | None, *args, **kwargs):
    t0 = time.monotonic()
    try:
        return await send_whatsapp_message(*args, **kwargs)
    finally:
        if lat is not None:
            lat.add("send_wa", int((time.monotonic() - t0) * 1000))


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


async def _dispatch_to_lob(
    lob_type: str,
    restaurant: dict,
    phone: str,
    message_body: str,
    msg_type: str,
    message_obj: dict,
    payload: dict,
) -> None:
    """
    Routes a message to the correct Line-of-Business agent based on lob_type.

    Current LOBs
    ------------
    "restaurant"     → handled by caller (booking_agent / dine-in / takeaway / delivery)
    "food_products"  → handle_minimal_order_flow in _process_meta_payload (early return)
    "psl"            → handle_minimal_order_flow in _process_meta_payload (early return)
    "retail"         → handle_minimal_order_flow in _process_meta_payload (early return)
    "supply"         → handle_supply_message (B2B food supply, already live)
    "jewellery"      → placeholder — will route to jewellery_agent when built

    Adding a new LOB
    ----------------
    1. Add its lob_type string to the elif ladder below (or wire via minimal agent above).
    2. Import and call its handle_* function.
    3. Set lob_type on the tenant's restaurant row in the DB.
    No changes to the webhook handler or routing logic required.

    Testing-mode note (shared WABA number)
    ---------------------------------------
    Until each supplier gets its own dedicated WABA number, multiple LOBs
    (fnb, psl, ...) share Munafe's restaurant WhatsApp number and are routed
    here purely via the "Hi <short_code>" keyword. Because of that, a
    "supply" tenant here is a *client* of some supplier, not a supplier
    itself — its real supplier_id/client_id must be resolved via the
    supply_clients bridge row (supply_clients.munafe_restaurant_id), never
    assumed to equal restaurant_id.
    """
    restaurant_id = restaurant["id"]

    if lob_type == "supply":
        from db.queries import get_supply_client_by_restaurant_id

        # Shared-WABA entry: "Hi fnb" → tenant with short_code=fnb, lob_type=supply.
        # Resolve the real supplier/client bridge via munafe_restaurant_id —
        # never treat the shared tenant id as supplier_id.
        client_row = await get_supply_client_by_restaurant_id(restaurant_id)
        if not client_row:
            logger.warning(
                f"[lob-dispatch] no supply_clients row for restaurant {restaurant_id} "
                f"(munafe_restaurant_id not linked) — dropping supply message"
            )
            from tools.whatsapp_tools import send_whatsapp_message as _send
            await _send(
                phone,
                "This outlet isn't registered as a supply client yet. "
                "Please contact your supplier to get set up. 🙏",
                restaurant_id,
            )
            return

        await handle_supply_message(
            phone           = phone,
            supplier_id     = client_row["supplier_id"],
            client_id       = client_row["id"],
            message         = message_body,
            message_type    = msg_type,
            raw_message_obj = message_obj,
        )

    elif lob_type == "retail":
        # Should not run — retail is handled by minimal agent before _dispatch_to_lob.
        logger.warning(
            f"[lob-dispatch] retail reached _dispatch_to_lob for {restaurant_id} — check routing"
        )

    elif lob_type == "jewellery":
        # Placeholder
        logger.info(f"[lob-dispatch] jewellery agent not yet implemented for {restaurant_id}")
        from tools.whatsapp_tools import send_whatsapp_message as _send
        await _send(phone, "Our jewellery enquiry service is coming soon! 💍", restaurant_id)

    else:
        logger.warning(
            f"[lob-dispatch] Unknown lob_type='{lob_type}' for {restaurant_id} — dropping message"
        )


async def _process_meta_payload(payload: dict):
    phone: str | None = None
    restaurant_id: str | None = None
    manager_phone: str | None = None
    lat: _LatencyTrace | None = None
    result: dict = {}
    session_state: dict = {}
    try:
        # 1. Extraction & in-process dedup
        value = payload.get("entry", [{}])[0].get("changes", [{}])[0].get("value", {})
        if not value.get("messages"):
            return

        message_obj = value["messages"][0]
        message_id  = message_obj.get("id", "") or "unknown"

        async with _processed_message_ids_lock:
            if message_id in _processed_message_ids:
                return
            _processed_message_ids[message_id] = 1
            if len(_processed_message_ids) > 1000:
                _processed_message_ids.popitem(last=False)

        lat = _LatencyTrace(message_id)

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

        # 3. Restaurant / LOB resolution — keyword-first, pin-second approach
        #
        #    Priority order:
        #    a. Explicit keyword — resolves to a real tenant → always wins,
        #       even mid-conversation (customer stating intent to switch
        #       outlets, e.g. "Hi psl"). An unrecognized single word is NOT
        #       treated as an error when a pin already exists — it's just
        #       an ordinary reply (party size, address text, etc.).
        #    b. Pin table       — phone already mid-conversation with a tenant.
        #    c. phone_number_id — ONLY for a genuinely dedicated (single-tenant)
        #       WABA number. Returns None on Munafe's shared number by design.
        #    d. Default         — is_default_for_number=True fallback.
        parsed = await parse_incoming(payload)
        phone  = message_obj.get("from")
        metadata = value.get("metadata", {})

        restaurant_whatsapp = (
            parsed.get("restaurant_whatsapp_number") or settings.whatsapp_phone_number
        )
        phone_number_id = metadata.get("phone_number_id")
        restaurant      = None
        keyword         = extract_short_code(message_body or "")

        # 3a. Explicit keyword — only acts when it resolves to a real, active tenant
        if keyword:
            candidate = await get_restaurant_by_short_code(restaurant_whatsapp, keyword)
            if candidate:
                restaurant = candidate
                logger.info(f"[routing] keyword '{keyword}' → {restaurant['name']}")

        # 3b. Pin table — mid-conversation continuation
        if not restaurant:
            pinned_id = await get_active_restaurant_for_phone(restaurant_whatsapp, phone)
            if pinned_id:
                restaurant = await get_restaurant_by_id(pinned_id)
                if restaurant:
                    logger.debug(f"[routing] pin hit: {phone} → {restaurant['name']}")

        # 3c. Unrecognized keyword AND no pin — genuinely fresh, unknown-outlet contact
        if not restaurant and keyword:
            codes = await get_active_short_codes_for_waba(restaurant_whatsapp)
            hint  = ", ".join(f"*Hi {c}*" for c in codes) if codes else "*Hi* (to start)"
            await _latency_send_wa(
                lat,
                phone,
                f"Sorry, we couldn't find that outlet. 🙏\n\n"
                f"Available options on this number:\n{hint}\n\n"
                f"Please try again with one of the above.",
                None,
            )
            lat.mark("resolve_restaurant")
            logger.warning(
                f"[routing] unknown keyword '{keyword}' from {phone} on {restaurant_whatsapp}"
            )
            return

        # 3d. Dedicated phone_number_id — only unambiguous single-tenant numbers
        if not restaurant and phone_number_id:
            restaurant = await get_restaurant_by_phone_number_id(str(phone_number_id))
            if restaurant:
                logger.debug(f"[routing] phone_number_id hit: {phone_number_id}")

        # 3e. Default fallback — plain "Hi" routes to is_default_for_number=True tenant
        if not restaurant:
            restaurant = await get_restaurant_by_whatsapp_number(restaurant_whatsapp)

        if not restaurant:
            lat.mark("resolve_restaurant")
            logger.error(
                f"[routing] no tenant resolved for "
                f"waba={restaurant_whatsapp!r} pnid={phone_number_id!r} phone={phone!r}"
            )
            return

        # Refresh pin on every message — keeps subsequent turns fast
        await pin_active_restaurant_for_phone(restaurant_whatsapp, phone, restaurant["id"])
        lat.mark("resolve_restaurant")

        # 3e. LOB dispatch — non-restaurant tenants go to their own agent
        lob_type      = restaurant.get("lob_type") or "restaurant"
        restaurant_id = restaurant["id"]
        profile_name  = (
            value.get("contacts", [{}])[0].get("profile", {}).get("name", "")
        )

        # 3e-i. Minimal-message LOBs (packaged food / PSL / retail) — single
        # webcart-link reply per turn, via the existing (but previously
        # unwired) handle_minimal_order_flow agent. Without this branch these
        # tenants fell straight through to the "Unknown lob_type" drop below
        # (food_products/psl) or a permanent "coming soon" placeholder
        # (retail) — no functioning agent was ever reached.
        MINIMAL_MESSAGE_LOBS = ("food_products", "psl", "retail")
        if lob_type in MINIMAL_MESSAGE_LOBS:
            logger.info(
                f"[routing] lob='{lob_type}' for {restaurant['name']} — minimal-message agent"
            )
            lat.last = time.monotonic()
            async with customer_lock(restaurant_id, phone):
                lat.mark("customer_lock")
                session_state = await get_session_state(restaurant_id, phone)
                if session_state is None:
                    session_state = {}
                from agents.customer.minimal_order_agent import handle_minimal_order_flow
                await handle_minimal_order_flow(
                    restaurant=restaurant,
                    phone=phone,
                    message_body=message_body,
                    session_state=session_state,
                    profile_name=profile_name,
                )
                await save_session_state(restaurant_id, phone, session_state)
            return

        if lob_type != "restaurant":
            logger.info(
                f"[routing] lob='{lob_type}' for {restaurant['name']} — dispatching"
            )
            await _dispatch_to_lob(
                lob_type    = lob_type,
                restaurant  = restaurant,
                phone       = phone,
                message_body= message_body,
                msg_type    = msg_type,
                message_obj = message_obj,
                payload     = payload,
            )
            return

        manager_phone = restaurant["manager_phone"]

        # 4. Per-customer advisory lock → load → process → save
        # Reset cursor so customer_lock stage = acquisition wait only.
        lat.last = time.monotonic()
        async with customer_lock(restaurant_id, phone):
            lat.mark("customer_lock")

            session_state = await get_session_state(restaurant_id, phone)
            if session_state is None:
                session_state = {}
            lat.mark("session_get")

            from agents.customer.dine_in_flow import _on_special_notes_timeout
            from agents.customer.booking_helpers import ensure_special_notes_kitchen_delivery
            await ensure_special_notes_kitchen_delivery(
                restaurant_id,
                phone,
                session_state,
                on_timeout=lambda: _on_special_notes_timeout(restaurant_id, phone),
            )
            lat.mark("special_notes")

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
                        await _latency_send_wa(
                            lat,
                            phone,
                            "We've noted those items — please finish payment for your "
                            "current order first. Reply *Home* to start a fresh order.",
                            restaurant_id,
                        )
                    else:
                        from tools.cart_tools import send_catalog_cart_acknowledgment
                        _t_send = time.monotonic()
                        await send_catalog_cart_acknowledgment(
                            phone, restaurant_id, session_state,
                        )
                        lat.add("send_wa", int((time.monotonic() - _t_send) * 1000))
                    touch_session_activity(session_state)
                    await save_session_state(restaurant_id, phone, session_state)
                    lat.mark("session_save")
                    return
                else:
                    logger.warning(f"[CATALOG] Failed to bridge order for {phone}")
                    await _latency_send_wa(
                        lat,
                        phone,
                        "We had trouble processing your catalog order. "
                        "Please try again, or type *MENU* to order from our list. 🙏",
                        restaurant_id,
                    )
                    return

            # 5b. Feedback reply — delegate to Node before booking routing.
            # Skip the Node hop for greetings / Home / Menu — those are never
            # feedback replies and the bridge timeout can add seconds to Hi.
            if msg_type in ("text", "button", "interactive") and is_reset_keyword(message_body):
                await try_dismiss_feedback_via_api(phone, restaurant_id)
                lat.mark("feedback_dismiss")
            elif msg_type in ("text", "button", "interactive") and should_skip_feedback_bridge(message_body):
                lat.mark("feedback_skipped")
            elif msg_type in ("text", "button", "interactive"):
                fb_result = await try_handle_feedback_via_api(phone, message_obj, restaurant_id)
                lat.mark("feedback_handle")
                if fb_result.get("consumed"):
                    if fb_result.get("completed"):
                        mark_session_visit_complete(session_state)
                    touch_session_activity(session_state)
                    await save_session_state(restaurant_id, phone, session_state)
                    lat.mark("session_save")
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
                message_id=message_id,
            )
            lat.mark("route_message")

            # 7. Persist state
            logger.info(
                f"[DIAG] POST-ROUTE result={result} "
                f"booking_step={session_state.get('booking_step')!r}"
            )
            touch_session_activity(session_state)
            await save_session_state(restaurant_id, phone, session_state)
            lat.mark("session_save")

        # 8. Manager fallback (outside lock)
        if phone == manager_phone and result.get("status") == "unknown_command":
            await _latency_send_wa(
                lat,
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
                await _latency_send_wa(lat, phone, fallback, restaurant_id)
            except Exception:
                logger.exception("Failed to send webhook error fallback to customer")
    finally:
        if lat is not None:
            lat.summary()


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


@app.get("/health/phonepe")
async def health_phonepe():
    """Diagnostic — confirms PhonePe keys loaded (no secrets exposed)."""
    return JSONResponse({
        "status": phonepe_status_message(),
        "env": settings.phonepe_env,
        "active_gateway": settings.payment_gateway,
    })


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


def _normalize_webcart_service_type(raw: str | None) -> tuple[str, bool]:
    """Map walk-in / body service labels → (booking service_type, is_scheduled)."""
    value = str(raw or "takeaway").strip().lower()
    if value in ("scheduled_delivery",):
        return "delivery", True
    if value in ("scheduled_takeaway", "scheduled_pickup"):
        return "takeaway", True
    if value in ("delivery", "takeaway", "dine_in"):
        return value, False
    if value in ("dinein", "dine-in"):
        return "dine_in", False
    return "takeaway", False


@app.post("/internal/webcart-confirm-pay")
async def internal_webcart_confirm_pay(request: Request):
    """Node API calls this after webcart submit to send Confirm & Pay (or schedule approval)."""
    if not _verify_internal_secret(request):
        raise HTTPException(status_code=403, detail="Forbidden")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    restaurant_id = str(body.get("restaurant_id") or "").strip()
    customer_phone = str(body.get("customer_phone") or "").strip()
    customer_name = str(body.get("customer_name") or "Guest").strip() or "Guest"
    body_delivery_address = str(body.get("delivery_address") or "").strip()
    body_pincode = "".join(ch for ch in str(body.get("pincode") or "") if ch.isdigit()).strip()[:6]
    raw_service = str(body.get("service_type") or "takeaway").strip().lower()
    token_label = str(body.get("token") or "").strip()
    order_ref = str(body.get("order_ref") or "").strip()
    items = body.get("items") or []
    body_order_mode = str(body.get("order_mode") or "").strip().lower()

    try:
        total = float(body.get("total") or 0)
    except Exception:
        total = 0.0

    if not restaurant_id or not customer_phone or not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="restaurant_id, customer_phone, and items are required")
    if total < 1:
        raise HTTPException(status_code=400, detail="total must be at least 1")

    service_type, scheduled_from_type = _normalize_webcart_service_type(raw_service)

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

    # Hydrate WhatsApp session — never invent a blank prepay-only state that
    # drops scheduled_at / delivery address / order_mode from the chat flow.
    session_state: dict = {}
    for ph in phone_candidates:
        session_state = dict(await get_session_state(restaurant_id, ph) or {})
        if session_state:
            canonical_phone = ph
            break

    session_service = str(session_state.get("service_type") or "").strip().lower()
    if body_delivery_address:
        service_type, _ = _normalize_webcart_service_type(raw_service or "delivery")
    elif session_service in ("delivery", "takeaway", "dine_in"):
        service_type = session_service

    is_scheduled = bool(
        scheduled_from_type
        or body_order_mode == "scheduled"
        or str(session_state.get("order_mode") or "").lower() == "scheduled"
        or session_state.get("scheduled_at")
        or body.get("scheduled_at")
    )
    if is_scheduled:
        session_state["order_mode"] = "scheduled"
        if body.get("scheduled_at") and not session_state.get("scheduled_at"):
            session_state["scheduled_at"] = body.get("scheduled_at")

    # Prefer walk-in token meta when the menu row knows the schedule.
    from tools.db_tools import get_walk_in_token_by_id, get_active_walk_in_token, parse_walk_in_meta
    portal_token = None
    if token_label:
        portal_token = await get_walk_in_token_by_id(restaurant_id, token_label)
    if not portal_token:
        portal_token = await get_active_walk_in_token(restaurant_id, canonical_phone)
    portal_meta = parse_walk_in_meta((portal_token or {}).get("meta")) if portal_token else {}
    portal_type = str((portal_token or {}).get("type") or "").strip().lower()
    if portal_type in ("scheduled_delivery", "scheduled_takeaway"):
        is_scheduled = True
        session_state["order_mode"] = "scheduled"
        mapped, _ = _normalize_webcart_service_type(portal_type)
        service_type = mapped
    if portal_meta.get("scheduled_at") and not session_state.get("scheduled_at"):
        session_state["scheduled_at"] = portal_meta.get("scheduled_at")
        is_scheduled = True
        session_state["order_mode"] = "scheduled"
    if portal_meta.get("service_type") in ("delivery", "takeaway", "dine_in") and not body_delivery_address:
        service_type = str(portal_meta["service_type"])

    session_state["payment_mode"] = "prepay"
    session_state["service_type"] = service_type
    session_state["restaurant_id"] = restaurant_id
    session_state["customer_name"] = (
        customer_name
        or session_state.get("customer_name")
        or "Guest"
    )
    if body_delivery_address:
        formatted_address = body_delivery_address
        if body_pincode and body_pincode not in formatted_address:
            formatted_address = f"{formatted_address}, {body_pincode}"
        session_state["delivery_address"] = formatted_address
        if body_pincode:
            session_state["delivery_pincode"] = body_pincode
    if body.get("delivery_charge") is not None:
        try:
            session_state["delivery_charge"] = float(body.get("delivery_charge") or 0)
        except Exception:
            pass
    if body.get("delivery_zone"):
        session_state["delivery_zone"] = str(body.get("delivery_zone"))
    session_state["order_total"] = total
    if token_label:
        session_state["menu_session_token"] = token_label

    # Build cart_snapshot from webcart items in the shape prepay_fulfillment expects
    cart_snapshot = {}
    order_text_lines = []
    for row in items:
        item_id = str(row.get("id") or row.get("name") or "").strip()
        if not item_id:
            continue
        qty = int(row.get("qty") or 0)
        if qty <= 0:
            continue
        name = str(row.get("name") or "Item").strip()
        price = float(row.get("price") or 0)
        cart_snapshot[item_id] = {"title": name, "name": name, "qty": qty, "unit_price": price}
        order_text_lines.append(f"{qty}x {name}")
    order_text_display = ", ".join(order_text_lines)

    token_number = await get_next_token_number(restaurant_id)
    booking = await create_booking(
        restaurant_id,
        customer_id,
        service_type,
        token_number=token_number,
        delivery_address=session_state.get("delivery_address"),
        booking_datetime=session_state.get("scheduled_at"),
    )
    booking_id = str(booking.get("id") or "").strip()
    if not booking_id:
        raise HTTPException(status_code=500, detail="Booking creation failed")

    session_state["booking_id"] = booking_id
    session_state["token_number"] = token_number
    session_state["cart"] = cart_snapshot

    from tools.order_pricing import compute_order_totals, resolve_delivery_charge
    from tools.booking_mechanisms import cache_restaurant_pricing

    await cache_restaurant_pricing(session_state, restaurant_id)
    parcel_rate = float(session_state.get("parcel_charge_per_item") or 0)
    delivery_fee = resolve_delivery_charge(session_state) if service_type == "delivery" else 0.0
    totals = compute_order_totals(
        cart_snapshot,
        service_type if service_type in ("takeaway", "delivery") else "takeaway",
        parcel_per_item=parcel_rate,
        delivery_charge=delivery_fee,
    )
    # Prefer webcart-calculated total when present (includes the same fee rules).
    if total > 0:
        totals = {**totals, "grand_total": total, "total": total}
    session_state["order_totals"] = totals
    session_state["order_total"] = float(totals.get("grand_total") or total)

    # Scheduled delivery/takeaway must go through manager approval — never issue pay CTA here.
    needs_scheduled_approval = bool(is_scheduled)
    if needs_scheduled_approval and not session_state.get("scheduled_at"):
        logger.error(
            f"[webcart-confirm-pay] scheduled order missing scheduled_at "
            f"phone={canonical_phone} service={service_type} portal_type={portal_type}"
        )
        await send_whatsapp_message(
            canonical_phone,
            "We couldn't find your delivery/pickup time for this scheduled order. "
            "Please reply *Home* and choose *Scheduled Delivery* / *Scheduled Pickup* again.",
            restaurant_id,
        )
        await save_session_state(restaurant_id, canonical_phone, session_state)
        return JSONResponse(
            status_code=409,
            content={"ok": False, "error": "scheduled_at_missing", "booking_id": booking_id},
        )

    if needs_scheduled_approval and service_type == "delivery":
        from agents.customer.delivery_flow import _submit_scheduled_delivery_for_approval

        restaurant = await get_restaurant_by_id(restaurant_id)
        manager_phone = str(
            session_state.get("manager_phone")
            or (restaurant or {}).get("manager_phone")
            or ""
        )
        try:
            result = await _submit_scheduled_delivery_for_approval(
                restaurant_id,
                customer_id,
                session_state.get("customer_name") or customer_name,
                canonical_phone,
                manager_phone,
                session_state,
                order_text=order_text_display,
                cart_snapshot=cart_snapshot,
                totals=totals,
                total=float(totals.get("grand_total") or total),
                delivery_fee=delivery_fee,
                token=str(token_label or token_number),
                booking_id=booking_id,
            )
        except Exception as exc:
            logger.error(f"[webcart-confirm-pay] scheduled delivery approval submit failed: {exc}")
            await save_session_state(restaurant_id, canonical_phone, session_state)
            return JSONResponse(
                status_code=500,
                content={"ok": False, "error": "scheduled_approval_failed", "booking_id": booking_id},
            )
        await save_session_state(restaurant_id, canonical_phone, session_state)
        logger.info(
            f"[webcart-confirm-pay] scheduled delivery routed to manager approval "
            f"booking={booking_id} phone={canonical_phone}"
        )
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "booking_id": booking_id,
                "payment_link": None,
                "awaiting_approval": True,
                "status": result.get("status"),
                "customer_phone": canonical_phone,
            },
        )

    if needs_scheduled_approval and service_type == "takeaway":
        from agents.customer.takeaway_flow import _submit_scheduled_takeaway_for_approval

        restaurant = await get_restaurant_by_id(restaurant_id)
        manager_phone = str(
            session_state.get("manager_phone")
            or (restaurant or {}).get("manager_phone")
            or ""
        )
        try:
            result = await _submit_scheduled_takeaway_for_approval(
                restaurant_id,
                customer_id,
                session_state.get("customer_name") or customer_name,
                canonical_phone,
                manager_phone,
                session_state,
                order_text=order_text_display,
                cart_snapshot=cart_snapshot,
                totals=totals,
                total=float(totals.get("grand_total") or total),
                token=str(token_label or token_number),
                booking_id=booking_id,
                booking_time=datetime.utcnow().isoformat(),
            )
        except Exception as exc:
            logger.error(f"[webcart-confirm-pay] scheduled takeaway approval submit failed: {exc}")
            await save_session_state(restaurant_id, canonical_phone, session_state)
            return JSONResponse(
                status_code=500,
                content={"ok": False, "error": "scheduled_approval_failed", "booking_id": booking_id},
            )
        await save_session_state(restaurant_id, canonical_phone, session_state)
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "booking_id": booking_id,
                "payment_link": None,
                "awaiting_approval": True,
                "status": result.get("status"),
                "customer_phone": canonical_phone,
            },
        )

    payment_link = await ensure_prepay_payment_link(
        booking_id,
        float(totals.get("grand_total") or total),
        session_state.get("customer_name") or customer_name,
        f"Web cart {service_type.replace('_', ' ')} order",
        customer_phone=canonical_phone,
        session_state=session_state,
    )
    if not payment_link:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "payment_link_unavailable", "booking_id": booking_id},
        )

    from tools.prepay_fulfillment import build_prepay_payload, persist_prepay_payload
    prepay_payload = build_prepay_payload(
        service_type=service_type,
        session_state=session_state,
        restaurant_id=restaurant_id,
        customer_id=customer_id,
        customer_name=session_state.get("customer_name") or customer_name,
        customer_phone=canonical_phone,
        booking_id=booking_id,
        token=str(token_label or token_number),
        total=float(totals.get("grand_total") or total),
        booking_time=datetime.utcnow().isoformat(),
        order_text_display=order_text_display,
        cart_snapshot=cart_snapshot,
        totals=totals,
    )
    await persist_prepay_payload(booking_id, prepay_payload)
    session_state["booking_step"] = "awaiting_prepay"
    await save_session_state(restaurant_id, canonical_phone, session_state)

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

    gateway_label = "Razorpay" if settings.payment_gateway == "razorpay" else "PhonePe"
    body_text = (
        "Your order is almost confirmed.\n\n"
        f"Order ref: {order_ref or booking_id[-8:]}\n"
        f"Token: {token_label or token_number}\n"
        f"Total: INR {float(totals.get('grand_total') or total):.0f}\n\n"
        f"{order_preview}\n\n"
        f"Tap Confirm & Pay to complete payment securely via {gateway_label}."
    ).strip()

    sent = await send_whatsapp_cta_url(
        canonical_phone,
        restaurant_id,
        body_text=body_text,
        button_text="Confirm & Pay",
        url=str(payment_link),
        header_text="Confirm Your Order",
        footer_text=f"Secure payment powered by {gateway_label}",
    )

    if not sent:
        fallback_text = (
            "Your order is almost confirmed.\n"
            f"Order ref: {order_ref or booking_id[-8:]}\n"
            f"Total: INR {float(totals.get('grand_total') or total):.0f}\n\n"
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


@app.post("/pay/failure-event")
async def pay_failure_event(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}

    booking_id = str(body.get("booking_id") or "").strip()
    kind = str(body.get("kind") or "").strip() or "unknown"
    details = body.get("details") or {}

    logger.warning(
        f"[pay-failure-event] booking_id={booking_id or 'unknown'} kind={kind} details={details}"
    )

    # Don't alert the manager for the customer simply closing the modal —
    # that's not actionable and is the majority of these events.
    NOTIFY_KINDS = {"payment_failed"}
    if booking_id and kind in NOTIFY_KINDS:
        try:
            booking = await get_booking_with_customer(booking_id)
            if booking and booking.get("payment_status") != "paid":
                restaurant_id = str(booking.get("restaurant_id") or "").strip()
                customer_phone = str(booking.get("customer_phone") or "").strip()
                token_number = str(booking.get("token_number") or booking_id[-8:]).strip()

                detail_reason = ""
                if isinstance(details, dict):
                    detail_reason = str(
                        details.get("reason") or details.get("code")
                        or details.get("description") or ""
                    ).strip()

                if restaurant_id:
                    from tools.restaurant_config import get_manager_phone
                    manager_phone = await get_manager_phone(restaurant_id)
                    if manager_phone:
                        await send_whatsapp_message(
                            manager_phone,
                            f"⚠️ Payment attempt failed — Token *{token_number}*\n"
                            f"Customer: {customer_phone or 'unknown'}\n"
                            f"Reason: {detail_reason or kind}\n\n"
                            f"Order has NOT gone to kitchen. Customer may retry payment.",
                            restaurant_id,
                        )
        except Exception as exc:
            logger.warning(f"[pay-failure-event] manager alert skipped for {booking_id}: {exc}")

    return JSONResponse(status_code=200, content={"ok": True})

    if booking_id:
        try:
            booking = await get_booking_with_customer(booking_id)
            if booking:
                restaurant_id = str(booking.get("restaurant_id") or "").strip()
                token_number = str(booking.get("token_number") or booking_id[-8:]).strip() or booking_id[-8:]
                customer_name = str(booking.get("customer_name") or "Guest").strip() or "Guest"
                customer_phone = str(booking.get("customer_phone") or "").strip()
                service_type = str(booking.get("service_type") or "takeaway").strip() or "takeaway"
                total = float(booking.get("order_total") or 0)

                detail_reason = ""
                if isinstance(details, dict):
                    detail_reason = str(
                        details.get("reason")
                        or details.get("code")
                        or details.get("description")
                        or ""
                    ).strip()

                reason_text = f"Payment issue detected ({kind})"
                if detail_reason:
                    reason_text += f": {detail_reason}"

                if restaurant_id and customer_phone:
                    await notify_manager_order_alert(
                        restaurant_id,
                        token_number=token_number,
                        customer_name=customer_name,
                        customer_phone=customer_phone,
                        order_text=reason_text,
                        total=total,
                        table_number=booking.get("table_number"),
                        party_size=booking.get("party_size"),
                        booking_time=datetime.utcnow().isoformat(),
                        service_type=service_type,
                    )
        except Exception as exc:
            logger.warning(f"[pay-failure-event] manager alert skipped for {booking_id}: {exc}")

    return JSONResponse(status_code=200, content={"ok": True})


@app.get("/pay/{booking_id}")
async def pay_checkout(booking_id: str, request: Request):
    """Hosted checkout entry point — routes to PhonePe or Razorpay.

    Gateway is settings.payment_gateway ("phonepe" by default). Append
    ?gw=razorpay or ?gw=phonepe to a link to force a specific gateway for
    testing without redeploying.
    """
    token = request.query_params.get("t", "")

    from tools.phonepe_tools import phonepe_configured 
    
    gateway = (request.query_params.get("gw") or settings.payment_gateway or "phonepe").lower()

    if gateway == "phonepe" and not phonepe_configured():
        logger.warning(f"[pay-checkout] PhonePe not configured, falling back to Razorpay, booking={booking_id}")
        gateway = "razorpay"

    if gateway == "phonepe" and phonepe_configured():
        result = await prepare_phonepe_redirect(booking_id, token)
        if result.get("error") == "invalid_token":
            return HTMLResponse("<h1>Invalid or expired payment link</h1>", status_code=403)
        if result.get("error") == "booking_not_found":
            return HTMLResponse("<h1>Order not found</h1>", status_code=404)
        if result.get("already_paid"):
            return HTMLResponse(
                "<h1>Already paid ✅</h1><p>Return to WhatsApp for your confirmation.</p>",
                status_code=200,
            )
        if result.get("error") == "phonepe_not_configured":
            logger.error(f"[pay-checkout] PhonePe not configured, booking={booking_id}")
            return HTMLResponse(
                "<h1>Payment unavailable</h1>"
                "<p>Online payment isn't set up yet. Please contact the restaurant, "
                "or reply <em>pay</em> on WhatsApp in a moment to try again.</p>",
                status_code=503,
            )
        if result.get("error"):
            return HTMLResponse(f"<h1>Payment unavailable</h1><p>{result['error']}</p>", status_code=400)
        return RedirectResponse(result["redirect_url"], status_code=303)

    # Razorpay — hosted method-picker page (click-first to avoid WebView popup blocking)
    ctx = await resolve_checkout_context(booking_id, token)
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
    return HTMLResponse(render_method_selection_html(ctx), status_code=200)


@app.get("/payment/phonepe/return")
async def payment_phonepe_return(request: Request):
    """PhonePe redirects the customer's browser here after the hosted checkout page."""
    booking_id = request.query_params.get("booking_id", "")
    token = request.query_params.get("t", "")
    if not booking_id:
        return HTMLResponse("<h1>Payment status unknown</h1>", status_code=400)

    result = await confirm_phonepe_return(booking_id, token)
    status = result.get("status", "pending")
    simple_status = "paid" if status == "paid" else ("failed" if status in ("failed", "fulfillment_failed") else "unknown")

    # Reuse the existing /payment/complete page for the actual HTML response.
    return RedirectResponse(
        f"/payment/complete?status={simple_status}&booking_id={booking_id}",
        status_code=303,
    )


@app.post("/pay/{booking_id}/create-order")
async def pay_create_order_for_method(booking_id: str, request: Request):
    """Create a Razorpay order after customer chooses payment method."""
    token = request.query_params.get("t", "")
    method = request.query_params.get("method", "")
    logger.info(
        f"[checkout-create-order] booking_id={booking_id} method={method or 'missing'} token_present={bool(token)}"
    )
    result = await create_order_for_method(booking_id, token, method)

    logger.info(
        "[checkout-create-order] "
        f"booking_id={booking_id} ok={not bool(result.get('error'))} "
        f"error={result.get('error') or 'none'} already_paid={bool(result.get('already_paid'))} "
        f"order_id={result.get('order_id') or 'none'}"
    )

    if result.get("error") == "invalid_token":
        return JSONResponse(status_code=403, content=result)

    if result.get("error"):
        return JSONResponse(status_code=400, content=result)

    return JSONResponse(status_code=200, content=result)


@app.post("/pay/verify")
async def pay_verify(request: Request):
    """Verify Razorpay Checkout payment signature after customer pays."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    logger.info(
        "[checkout-verify] "
        f"order_id={body.get('razorpay_order_id') or 'missing'} "
        f"payment_id={body.get('razorpay_payment_id') or 'missing'} "
        f"signature_present={bool(body.get('razorpay_signature'))}"
    )
    result = await verify_checkout_payment(body)
    logger.info(
        "[checkout-verify] "
        f"ok={bool(result.get('ok'))} booking_id={result.get('booking_id') or 'unknown'} "
        f"fulfilled={result.get('fulfilled')} reason={result.get('reason') or result.get('error') or 'none'}"
    )
    status_code = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status_code, content=result)

@app.post("/pay/mock-success")
async def pay_mock_success(request: Request):
    """Test-mode only: simulate a successful checkout, bypassing flaky Razorpay sandbox rails."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    booking_id = str(body.get("booking_id") or "").strip()
    order_id = str(body.get("order_id") or "").strip()
    if not booking_id:
        raise HTTPException(status_code=400, detail="booking_id is required")

    from tools.payment_tools import mark_test_checkout_paid
    result = await mark_test_checkout_paid(booking_id, order_id)
    status_code = 200 if result.get("ok") else 400
    return JSONResponse(status_code=status_code, content=result)

@app.get("/webhook/razorpay")
async def razorpay_webhook_probe():
    """Browser/Razorpay URL check — real events must use POST."""
    return JSONResponse({
        "status": "ok",
        "message": "Razorpay webhook endpoint is live. Configure payment.captured and order.paid events here.",
    })


@app.get("/webhook/phonepe")
async def phonepe_webhook_probe():
    """Browser/PhonePe URL check — real events must use POST."""
    return JSONResponse({
        "status": "ok",
        "message": "PhonePe webhook endpoint is live. Configure it in PhonePe Dashboard → Webhooks.",
    })


@app.post("/webhook/phonepe")
async def phonepe_webhook(request: Request):
    """PhonePe checkout order events (configure in PhonePe Business Dashboard → Webhooks)."""
    body_bytes = await request.body()
    auth_header = request.headers.get("Authorization", "")

    if not verify_phonepe_webhook_auth(auth_header):
        raise HTTPException(status_code=400, detail="Invalid PhonePe webhook auth")

    try:
        payload = json.loads(body_bytes.decode("utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    result = await handle_phonepe_webhook(payload)
    return JSONResponse(status_code=200, content=result)


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
