"""
PhonePe Standard Checkout (v2) integration.

Mirrors the public surface of tools/payment_tools.py (Razorpay) closely enough
that main.py can branch between the two gateways based on settings.payment_gateway.

Architecture differs from Razorpay in one important way: PhonePe's Standard
Checkout is a full-page hosted redirect (not an inline JS widget). So instead
of rendering a method-picker page ourselves, GET /pay/{booking_id} creates the
PhonePe order server-side and 303-redirects the browser straight to PhonePe's
redirectUrl. PhonePe then redirects back to our own /payment/phonepe/return,
where we confirm status via the Order Status API before handing off to the
existing /payment/complete page.

Credentials (from PhonePe Business Dashboard → Developer Settings):
    PHONEPE_CLIENT_ID
    PHONEPE_CLIENT_SECRET
    PHONEPE_CLIENT_VERSION   (usually 1)
    PHONEPE_ENV              ("sandbox" while testing, "production" when live)
    PHONEPE_WEBHOOK_USERNAME / PHONEPE_WEBHOOK_PASSWORD
        (whatever you configure in PhonePe Dashboard → Webhook settings —
        PhonePe signs webhooks with SHA256("username:password") in the
        Authorization header)

None of these are set yet — this module is a working scaffold. Until
PHONEPE_CLIENT_ID / PHONEPE_CLIENT_SECRET are set, phonepe_configured() is
False and prepare_phonepe_redirect() will return an error instead of crashing,
so it's safe to deploy ahead of having real sandbox keys.

SANDBOX VERIFICATION (still pending):
  - Webhook payload shape and Order Status API path should be confirmed
    against a live PhonePe sandbox account before going live as primary.
  - Until verified, runtime fallback to Razorpay covers checkout failures.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from typing import Any
from urllib.parse import quote

import httpx

from config.settings import settings

logger = logging.getLogger(__name__)

_SANDBOX_AUTH_URL = "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token"
_SANDBOX_API_BASE = "https://api-preprod.phonepe.com/apis/pg-sandbox"
_PROD_AUTH_URL = "https://api.phonepe.com/apis/identity-manager/v1/oauth/token"
_PROD_API_BASE = "https://api.phonepe.com/apis/pg"

# In-memory OAuth token cache (single-process; fine for a single Railway instance).
_token_cache: dict[str, Any] = {"access_token": None, "expires_at": 0}


def phonepe_configured() -> bool:
    return bool(settings.phonepe_client_id and settings.phonepe_client_secret)


def phonepe_status_message() -> str:
    """Mirrors razorpay_status_message() for symmetric health checks / logging."""
    if not phonepe_configured():
        return "keys_missing"
    return f"enabled_{settings.phonepe_env}"


def _auth_url() -> str:
    return _SANDBOX_AUTH_URL if settings.phonepe_env != "production" else _PROD_AUTH_URL


def _api_base() -> str:
    return _SANDBOX_API_BASE if settings.phonepe_env != "production" else _PROD_API_BASE


async def _get_auth_token() -> str | None:
    """Fetch + cache the OAuth token; refresh 5 minutes before expiry."""
    if not phonepe_configured():
        return None

    now = int(time.time())
    if _token_cache["access_token"] and _token_cache["expires_at"] - 300 > now:
        return _token_cache["access_token"]

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                _auth_url(),
                data={
                    "client_id": settings.phonepe_client_id,
                    "client_version": str(settings.phonepe_client_version),
                    "client_secret": settings.phonepe_client_secret,
                    "grant_type": "client_credentials",
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        data = resp.json() if resp.content else {}
        if resp.status_code >= 400 or not data.get("access_token"):
            logger.error(f"[phonepe] auth token request failed ({resp.status_code}): {data}")
            return None

        _token_cache["access_token"] = data["access_token"]
        _token_cache["expires_at"] = int(data.get("expires_at") or (now + 3000))
        return _token_cache["access_token"]
    except Exception as exc:
        logger.error(f"[phonepe] auth token fetch raised: {exc}")
        return None


def _return_url(booking_id: str) -> str:
    from tools.payment_tools import sign_checkout_token

    token = sign_checkout_token(str(booking_id))
    base = settings.chat_public_url.rstrip("/")
    return f"{base}/payment/phonepe/return?booking_id={quote(str(booking_id))}&t={quote(token)}"


async def create_phonepe_order(
    booking_id: str,
    amount: float,
    *,
    customer_name: str | None = None,
    description: str | None = None,
) -> dict[str, Any]:
    """Create a PhonePe Standard Checkout (v2) order.

    Returns {"ok": True, "order_id", "merchant_order_id", "redirect_url"} on
    success, or {"ok": False, "reason": ...} on failure — never raises, so
    callers in the request path can degrade gracefully.
    """
    token = await _get_auth_token()
    if not token:
        return {"ok": False, "reason": phonepe_status_message()}

    amount_paise = int(round(float(amount) * 100))
    if amount_paise < 100:
        return {"ok": False, "reason": "amount_too_small"}

    merchant_order_id = f"bk{str(booking_id).replace('-', '')[:20]}{int(time.time())}"[:63]

    payload = {
        "merchantOrderId": merchant_order_id,
        "amount": amount_paise,
        "expireAfter": 1200,
        "metaInfo": {
            "udf1": str(booking_id),
            "udf2": (customer_name or "Guest")[:120],
        },
        "paymentFlow": {
            "type": "PG_CHECKOUT",
            "message": (description or f"Munafe order {str(booking_id)[:8]}")[:120],
            "merchantUrls": {"redirectUrl": _return_url(booking_id)},
        },
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                f"{_api_base()}/checkout/v2/pay",
                json=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"O-Bearer {token}",
                },
            )
        data = resp.json() if resp.content else {}
        if resp.status_code >= 400:
            logger.error(f"[phonepe] create order failed ({resp.status_code}) for {booking_id}: {data}")
            return {"ok": False, "reason": "create_failed", "detail": data}

        redirect_url = data.get("redirectUrl")
        order_id = data.get("orderId") or merchant_order_id
        if not redirect_url:
            logger.error(f"[phonepe] no redirectUrl in create-order response: {data}")
            return {"ok": False, "reason": "no_redirect_url", "detail": data}

        logger.info(
            f"[phonepe] Order created: {order_id} "
            f"(merchant_order_id={merchant_order_id}) for booking {booking_id}"
        )
        return {
            "ok": True,
            "order_id": order_id,
            "merchant_order_id": merchant_order_id,
            "redirect_url": redirect_url,
        }
    except Exception as exc:
        logger.error(f"[phonepe] create order raised for {booking_id}: {exc}")
        return {"ok": False, "reason": "exception", "error": str(exc)}


async def get_order_status(merchant_order_id: str) -> dict[str, Any]:
    """Check Order Status API — the source of truth if a webhook is missed/delayed."""
    token = await _get_auth_token()
    if not token:
        return {"ok": False, "reason": phonepe_status_message()}

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_api_base()}/checkout/v2/order/{merchant_order_id}/status",
                params={"details": "false"},
                headers={"Authorization": f"O-Bearer {token}"},
            )
        data = resp.json() if resp.content else {}
        if resp.status_code >= 400:
            return {"ok": False, "reason": "status_failed", "detail": data}
        return {"ok": True, "state": str(data.get("state") or "").upper(), "detail": data}
    except Exception as exc:
        logger.error(f"[phonepe] order status fetch raised for {merchant_order_id}: {exc}")
        return {"ok": False, "reason": "exception", "error": str(exc)}


def verify_webhook_auth(auth_header: str) -> bool:
    """PhonePe signs webhooks with SHA256('username:password') in Authorization.

    Username/password are whatever you set in PhonePe Dashboard → Webhook
    configuration — not your client_id/client_secret.
    """
    username = settings.phonepe_webhook_username
    password = settings.phonepe_webhook_password
    if not username or not password:
        if settings.environment == "production":
            logger.error("[phonepe] Webhook received but username/password not configured")
            return False
        logger.warning("[phonepe] Skipping webhook auth check (dev, no username/password set)")
        return True

    expected = hashlib.sha256(f"{username}:{password}".encode()).hexdigest()
    return hmac.compare_digest(expected, (auth_header or "").strip())


async def handle_payment_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """Process a PhonePe checkout webhook and fulfill the booking if paid."""
    from tools.payment_tools import _mark_paid_and_fulfill, notify_customer_payment_failure

    event = str(payload.get("event") or payload.get("type") or "")
    data = payload.get("payload") or payload.get("data") or {}
    state = str(data.get("state") or "").upper()
    meta_info = data.get("metaInfo") or {}
    booking_id = meta_info.get("udf1") or data.get("merchantOrderId")

    logger.info(f"[phonepe] Webhook event={event} state={state} booking_id={booking_id}")

    if not booking_id:
        return {"ok": True, "event": event, "handled": False, "reason": "booking_id_missing"}

    if state in ("COMPLETED", "PAID") or "COMPLETED" in event.upper() or "SUCCESS" in event.upper():
        try:
            return await _mark_paid_and_fulfill(str(booking_id), source="phonepe_webhook")
        except Exception as exc:
            logger.error(f"[phonepe] Failed to fulfill booking {booking_id}: {exc}")
            return {"ok": False, "error": str(exc)}

    if state in ("FAILED", "EXPIRED", "CANCELLED"):
        await notify_customer_payment_failure(str(booking_id), reason=state.lower())
        return {"ok": True, "event": event, "handled": True, "booking_id": booking_id}

    return {"ok": True, "event": event, "handled": False, "state": state}


def _is_hosted_checkout_url(url: str) -> bool:
    """True when url is our GET /pay/{booking_id} page (not PhonePe’s gateway)."""
    try:
        from urllib.parse import urlparse

        path = (urlparse(url).path or "").rstrip("/")
        return "/pay/" in path
    except Exception:
        return "/pay/" in (url or "")


def _merchant_order_matches_booking(merchant_order_id: str | None, booking_id: str) -> bool:
    """merchant_order_id is bk{booking_uuid_nodash[:20]}{timestamp} — must match this booking."""
    if not merchant_order_id or not booking_id:
        return False
    prefix = f"bk{str(booking_id).replace('-', '')[:20]}"
    return str(merchant_order_id).startswith(prefix)


def clear_stale_phonepe_session(
    session_state: dict[str, Any] | None,
    booking_id: str,
) -> bool:
    """Drop cached PhonePe redirect/order when it belongs to a different booking.

    Returns True if anything was cleared. Safe to call on every new checkout.
    """
    if not session_state or not booking_id:
        return False
    existing_merchant = session_state.get("phonepe_merchant_order_id")
    existing_booking = session_state.get("phonepe_booking_id")
    existing_redirect = session_state.get("phonepe_redirect_url")
    if not (existing_merchant or existing_booking or existing_redirect):
        return False

    belongs_here = True
    if existing_booking:
        belongs_here = str(existing_booking) == str(booking_id)
    if belongs_here and existing_merchant:
        belongs_here = _merchant_order_matches_booking(existing_merchant, booking_id)
    if belongs_here and not existing_booking and not existing_merchant:
        # Orphan redirect with no booking/order binding — never reuse.
        belongs_here = False

    if belongs_here:
        return False

    for key in ("phonepe_redirect_url", "phonepe_merchant_order_id", "phonepe_booking_id"):
        session_state.pop(key, None)
    return True


async def prepare_phonepe_redirect(booking_id: str, token: str) -> dict[str, Any]:
    """Resolve booking + amount, create the PhonePe order, return its redirect_url.

    Called from GET /pay/{booking_id} when settings.payment_gateway == "phonepe".
    """
    from tools.payment_tools import build_checkout_page_url, verify_checkout_token

    if not verify_checkout_token(booking_id, token):
        return {"error": "invalid_token"}

    from tools.db_tools import get_booking_with_customer, get_session_state, save_session_state

    booking = await get_booking_with_customer(booking_id)
    if not booking:
        return {"error": "booking_not_found"}
    if booking.get("payment_status") == "paid" or booking.get("status") == "confirmed":
        return {"already_paid": True}

    restaurant_id = str(booking["restaurant_id"])
    phone = booking.get("customer_phone") or ""
    session: dict[str, Any] = {}
    if phone:
        session = dict(await get_session_state(restaurant_id, phone) or {})

    amount = float(session.get("order_total") or 0)
    customer_name = booking.get("customer_name") or session.get("customer_name") or "Guest"
    token_label = booking.get("token_number") or ""

    if amount < 1:
        from tools.prepay_fulfillment import load_prepay_payload

        payload = await load_prepay_payload(restaurant_id, phone, booking_id)
        amount = float((payload or {}).get("total") or 0)
    if amount < 1:
        return {"error": "amount_missing"}

    if clear_stale_phonepe_session(session, booking_id):
        logger.info(
            f"[phonepe] Cleared stale PhonePe session fields before checkout for {booking_id}"
        )

    # Reuse a real PhonePe gateway URL from an earlier create for THIS booking only.
    # Never reuse our hosted /pay/{booking_id} page — reminders and ensure_prepay
    # store that under payment_link for WhatsApp CTAs; treating it as the gateway
    # URL causes GET /pay → 303 → /pay → net::ERR_TOO_MANY_REDIRECTS.
    existing_redirect = str(
        session.get("phonepe_redirect_url")
        or session.get("payment_link")
        or ""
    ).strip()
    existing_merchant = session.get("phonepe_merchant_order_id")
    if (
        existing_redirect
        and existing_merchant
        and _merchant_order_matches_booking(existing_merchant, booking_id)
        and session.get("payment_gateway") == "phonepe"
        and not _is_hosted_checkout_url(existing_redirect)
    ):
        logger.info(f"[phonepe] Reusing existing redirect for booking {booking_id}")
        return {"redirect_url": existing_redirect}
    if existing_redirect and existing_merchant and not _merchant_order_matches_booking(
        existing_merchant, booking_id
    ):
        logger.info(
            f"[phonepe] Ignoring redirect for other booking "
            f"(merchant={existing_merchant}) while checking out {booking_id}; "
            "creating a fresh PhonePe order"
        )
    if existing_redirect and _is_hosted_checkout_url(existing_redirect):
        logger.info(
            f"[phonepe] Ignoring hosted /pay URL as redirect for booking {booking_id}; "
            "creating a fresh PhonePe order"
        )

    if not phonepe_configured():
        return {"error": "phonepe_not_configured", "fallback": True}

    description = f"Order {token_label}".strip() or f"Booking {booking_id[:8]}"
    order = await create_phonepe_order(
        booking_id, amount, customer_name=customer_name, description=description,
    )
    if not order.get("ok"):
        logger.error(f"[phonepe] redirect prep failed for {booking_id}: {order}")
        return {"error": order.get("reason") or "phonepe_error", "fallback": True}

    session["payment_gateway"] = "phonepe"
    session["phonepe_merchant_order_id"] = order["merchant_order_id"]
    session["phonepe_booking_id"] = str(booking_id)
    # Keep payment_link as our hosted checkout (WhatsApp CTA); store gateway separately.
    session["phonepe_redirect_url"] = order["redirect_url"]
    session["payment_link"] = build_checkout_page_url(str(booking_id))
    if phone:
        await save_session_state(restaurant_id, phone, session)

    return {"redirect_url": order["redirect_url"]}


async def scrub_session_for_abandoned_booking(
    restaurant_id: str,
    customer_phone: str,
    booking_id: str,
) -> bool:
    """Remove PhonePe/checkout fields tied to an abandoned unpaid booking.

    Safe no-op when the session already moved on to a newer booking.
    """
    from tools.db_tools import get_session_state, save_session_state

    if not restaurant_id or not customer_phone or not booking_id:
        return False

    state = dict(await get_session_state(restaurant_id, customer_phone) or {})
    if not state:
        return False

    bid = str(booking_id)
    tied = (
        str(state.get("phonepe_booking_id") or "") == bid
        or str(state.get("booking_id") or "") == bid
        or _merchant_order_matches_booking(state.get("phonepe_merchant_order_id"), bid)
    )

    changed = False
    pending = dict(state.get("pending_prepay_fulfillment") or {})
    if bid in pending:
        pending.pop(bid, None)
        state["pending_prepay_fulfillment"] = pending
        changed = True

    if tied:
        for key in (
            "phonepe_redirect_url",
            "phonepe_merchant_order_id",
            "phonepe_booking_id",
            "payment_link",
            "razorpay_payment_link_id",
            "razorpay_order_id",
            "payment_gateway",
        ):
            if key in state:
                state.pop(key, None)
                changed = True
        if str(state.get("booking_id") or "") == bid:
            state.pop("booking_id", None)
            changed = True
        if state.get("booking_step") in ("awaiting_prepay", "awaiting_payment"):
            state["booking_step"] = "visit_complete"
            changed = True
        if state.get("minimal_step") == "awaiting_repeat_payment":
            state.pop("minimal_step", None)
            changed = True
        state.pop("_prepay_blocks_kitchen", None)

    if not changed:
        return False

    await save_session_state(restaurant_id, customer_phone, state)
    logger.info(
        f"[phonepe] Scrubbed session checkout state for abandoned booking {bid} "
        f"({customer_phone})"
    )
    return True


async def confirm_phonepe_return(booking_id: str, token: str) -> dict[str, Any]:
    """Called from GET /payment/phonepe/return once PhonePe redirects the customer back.

    Confirms via the Order Status API (webhooks are the primary path, but the
    redirect needs an immediate answer for the page we show the customer).
    """
    from tools.payment_tools import verify_checkout_token, _mark_paid_and_fulfill

    if not verify_checkout_token(booking_id, token):
        return {"ok": False, "status": "invalid_token"}

    from tools.db_tools import get_booking_with_customer, get_session_state

    booking = await get_booking_with_customer(booking_id)
    if not booking:
        return {"ok": False, "status": "not_found"}
    if booking.get("payment_status") == "paid" or booking.get("status") == "confirmed":
        return {"ok": True, "status": "paid"}

    restaurant_id = str(booking["restaurant_id"])
    phone = booking.get("customer_phone") or ""
    session = dict(await get_session_state(restaurant_id, phone) or {}) if phone else {}
    merchant_order_id = session.get("phonepe_merchant_order_id")
    if not merchant_order_id:
        return {"ok": False, "status": "unknown"}

    status = await get_order_status(merchant_order_id)
    state = status.get("state") or ""

    if state in ("COMPLETED", "PAID"):
        result = await _mark_paid_and_fulfill(str(booking_id), source="phonepe_return")
        return {
            "ok": bool(result.get("fulfilled")),
            "status": "paid" if result.get("fulfilled") else "fulfillment_failed",
        }
    if state in ("FAILED", "EXPIRED", "CANCELLED"):
        return {"ok": False, "status": "failed"}
    return {"ok": False, "status": "pending"}


if phonepe_configured():
    logger.info(f"[phonepe] status={phonepe_status_message()}")
else:
    logger.warning(
        "[phonepe] PHONEPE_CLIENT_ID / PHONEPE_CLIENT_SECRET not set — "
        "checkout will report phonepe_not_configured until these are added"
    )
