"""Payment tools - Razorpay UPI payment integration (restaurant flows)."""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import re
import time
from typing import Any
from urllib.parse import quote

from config.settings import settings

logger = logging.getLogger(__name__)

_PLACEHOLDER_URL = "https://payment-placeholder.com"

FEE_RATES: dict[str, float] = {
    "upi": 0.01,
    "card": 0.028,
}

_RAZORPAY_METHOD_CONFIG: dict[str, dict[str, int]] = {
    "upi": {
        "netbanking": False,
        "card": False,
        "upi": True,
        "wallet": False,
        "paylater": False,
        "emi": False,
    },
    "card": {
        "netbanking": True,
        "card": True,
        "upi": False,
        "wallet": True,
        "paylater": False,
        "emi": False,
    },
}


def compute_fee_inclusive_total(subtotal: float, method: str) -> dict[str, float]:
    """Compute fee split where customer pays subtotal and payout is net of Munafe fee."""
    pct = FEE_RATES.get(method)
    if pct is None:
        raise ValueError(f"Unknown payment method: {method}")
    base = round(float(subtotal), 2)
    fee_amount = round(base * pct, 2)
    return {
        "subtotal": base,
        "fee_pct": pct,
        "fee_amount": fee_amount,
        "restaurant_payout": round(base - fee_amount, 2),
        "customer_total": base,
    }

RAZORPAY_NON_REFUND_NOTICE = (
    "⚠️ *Please note:* Payment cannot be reversed once completed. "
    "Cancellations or amendments are *not* possible after payment."
)


def format_razorpay_payment_line(
    link: str,
    *,
    label: str = "💳 Tap to pay and confirm your order:",
) -> str:
    """Payment link block with non-refundable disclaimer shown before the link."""
    return f"{RAZORPAY_NON_REFUND_NOTICE}\n\n{label}\n{link}"

_RAZORPAY_IMPORT_ERROR: str | None = None

try:
    import razorpay
    RAZORPAY_AVAILABLE = True
except ImportError as exc:
    razorpay = None  # type: ignore
    RAZORPAY_AVAILABLE = False
    _RAZORPAY_IMPORT_ERROR = str(exc)
    logger.warning(
        "[razorpay] Python package not installed — run: pip install razorpay (%s)",
        exc,
    )


def razorpay_configured() -> bool:
    return bool(
        RAZORPAY_AVAILABLE
        and settings.razorpay_key_id
        and settings.razorpay_key_secret
    )


def razorpay_status_message() -> str:
    if not RAZORPAY_AVAILABLE:
        return "package_missing"
    if not settings.razorpay_key_id or not settings.razorpay_key_secret:
        return "keys_missing"
    mode = "test" if str(settings.razorpay_key_id).startswith("rzp_test_") else "live"
    return f"enabled_{mode}"


def is_placeholder_payment_link(link: str) -> bool:
    if not link:
        return True
    if "/pay/" in str(link):
        return False
    return "placeholder" in link.lower() or link == _PLACEHOLDER_URL


def _checkout_signing_secret() -> str:
    secret = (settings.razorpay_key_secret or "").strip()
    if secret:
        return secret
    from tools.booking_mechanisms import KDS_SECRET
    return (KDS_SECRET or "autom8-checkout-dev").strip()


def sign_checkout_token(booking_id: str, *, ttl_seconds: int = 86_400) -> str:
    """Signed token authorising /pay/{booking_id} for a limited time."""
    exp = int(time.time()) + ttl_seconds
    payload = f"{booking_id}:{exp}"
    sig = hmac.new(
        _checkout_signing_secret().encode(),
        payload.encode(),
        hashlib.sha256,
    ).hexdigest()
    raw = f"{payload}:{sig}"
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def verify_checkout_token(booking_id: str, token: str) -> bool:
    if not token:
        return False
    try:
        padded = token + "=" * (-len(token) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
        bid, exp_str, sig = raw.rsplit(":", 2)
        if bid != str(booking_id):
            return False
        if int(exp_str) < int(time.time()):
            return False
        payload = f"{bid}:{exp_str}"
        expected = hmac.new(
            _checkout_signing_secret().encode(),
            payload.encode(),
            hashlib.sha256,
        ).hexdigest()
        return hmac.compare_digest(expected, sig)
    except Exception:
        return False


def build_checkout_page_url(booking_id: str) -> str:
    token = sign_checkout_token(str(booking_id))
    base = settings.chat_public_url.rstrip("/")
    return f"{base}/pay/{booking_id}?t={quote(token)}"


def build_hosted_checkout_url(booking_id: str) -> str:
    """Backward-compatible alias used by older checkout call sites."""
    return build_checkout_page_url(booking_id)


def _get_client():
    """Fresh client per call — picks up Railway env vars after redeploy."""
    if not razorpay_configured():
        return None
    return razorpay.Client(
        auth=(settings.razorpay_key_id, settings.razorpay_key_secret)
    )


def _format_contact(phone: str | None) -> str | None:
    if not phone:
        return None
    digits = re.sub(r"\D", "", str(phone))
    if len(digits) == 10:
        return f"+91{digits}"
    if len(digits) == 12 and digits.startswith("91"):
        return f"+{digits}"
    if len(digits) >= 10:
        return f"+{digits}"
    return None


def _callback_url() -> str:
    if settings.razorpay_callback_url:
        return settings.razorpay_callback_url
    return f"{settings.chat_public_url.rstrip('/')}/payment/complete"


def wants_online_payment(session_state: dict[str, Any] | None) -> bool:
    """Restaurant prepay mode — online payment link expected."""
    mode = (session_state or {}).get("payment_mode", "prepay")
    return str(mode).strip().lower() != "postpay"


def is_scheduled_order_session(session_state: dict[str, Any] | None) -> bool:
    """True when the customer booked a future scheduled slot."""
    state = session_state or {}
    return bool(state.get("scheduled_at") or state.get("kitchen_start_at"))


def scheduled_payment_already_delivered(session_state: dict[str, Any] | None) -> bool:
    """True when scheduled approval payment was sent with a real Razorpay link."""
    state = session_state or {}
    if not state.get("_scheduled_payment_sent"):
        return False
    link = state.get("payment_link")
    if is_scheduled_order_session(state):
        return bool(link and not is_placeholder_payment_link(str(link)))
    if not wants_online_payment(state):
        return True
    return bool(link and not is_placeholder_payment_link(str(link)))


async def create_razorpay_order(
    booking_id: str,
    amount: float,
    customer_name: str,
    description: str,
    *,
    customer_phone: str | None = None,
    session_state: dict[str, Any] | None = None,
    payment_method: str | None = None,
    fee_meta: dict[str, float] | None = None,
) -> str:
    """Create Razorpay Order (Orders API) — unlimited checkouts in test mode."""
    client = _get_client()
    if not client:
        reason = razorpay_status_message()
        logger.error(f"[razorpay] Cannot create order — status={reason}")
        if settings.environment == "production":
            raise RuntimeError(f"Razorpay not configured ({reason})")
        raise RuntimeError(f"Razorpay not configured ({reason})")

    amount_paise = int(round(amount * 100))
    if amount_paise < 100:
        raise ValueError(f"Amount too small for Razorpay: ₹{amount}")

    receipt = f"bk_{str(booking_id).replace('-', '')[:12]}_{int(time.time())}"[:40]
    notes: dict[str, str] = {
        "booking_id": str(booking_id),
        "customer_name": (customer_name or "Guest")[:120],
    }
    if customer_phone:
        notes["customer_phone"] = re.sub(r"\D", "", str(customer_phone))[-12:]
    if payment_method:
        notes["payment_method"] = str(payment_method)
    if fee_meta:
        notes["munafe_fee_pct"] = str(fee_meta.get("fee_pct", ""))
        notes["munafe_fee_amount"] = str(fee_meta.get("fee_amount", ""))
        notes["order_subtotal"] = str(fee_meta.get("subtotal", ""))
        notes["restaurant_payout"] = str(fee_meta.get("restaurant_payout", ""))

    payload: dict[str, Any] = {
        "amount": amount_paise,
        "currency": "INR",
        "receipt": receipt,
        "notes": notes,
    }

    response = client.order.create(data=payload)
    order_id = response.get("id", "")
    if not order_id:
        raise RuntimeError(f"Razorpay returned no order id: {response}")

    if session_state is not None:
        session_state["razorpay_order_id"] = order_id
        session_state["payment_link"] = build_checkout_page_url(str(booking_id))
        session_state.pop("razorpay_payment_link_id", None)

    logger.info(
        f"[razorpay] Order created: {order_id} for booking {booking_id} method={payment_method}"
    )
    return str(order_id)


def _cache_order_in_session(
    session_state: dict[str, Any] | None,
    order: dict[str, Any],
    booking_id: str,
) -> None:
    if session_state is None:
        return
    order_id = order.get("id")
    if order_id:
        session_state["razorpay_order_id"] = order_id
    session_state["payment_link"] = build_checkout_page_url(str(booking_id))


async def resolve_order_payment_status(
    booking_id: str,
    session_state: dict[str, Any] | None = None,
) -> str | None:
    """Return Razorpay order status: paid, created, attempted, or None."""
    client = _get_client()
    if not client:
        return None

    order_id = (session_state or {}).get("razorpay_order_id")
    if order_id:
        try:
            order = client.order.fetch(order_id)
            notes = order.get("notes") or {}
            if str(notes.get("booking_id")) == str(booking_id):
                _cache_order_in_session(session_state, order, booking_id)
                return order.get("status")
        except Exception as exc:
            logger.warning(f"[razorpay] fetch order {order_id} failed: {exc}")

    return None


async def create_payment_link(
    booking_id: str,
    amount: float,
    customer_name: str,
    description: str,
    *,
    customer_phone: str | None = None,
    session_state: dict[str, Any] | None = None,
    reference_id: str | None = None,
) -> str:
    """Return hosted checkout URL (Orders API — no payment-link quota)."""
    del reference_id  # legacy param from payment-link era
    url = await ensure_prepay_payment_link(
        str(booking_id), amount, customer_name, description,
        customer_phone=customer_phone,
        session_state=session_state,
    )
    if not url:
        raise RuntimeError(f"Could not create checkout for booking {booking_id}")
    return url


def _cache_payment_link_in_session(session_state: dict[str, Any] | None, plink: dict[str, Any]) -> None:
    if session_state is None:
        return
    link_id = plink.get("id")
    short_url = plink.get("short_url") or plink.get("url")
    if link_id:
        session_state["razorpay_payment_link_id"] = link_id
    if short_url:
        session_state["payment_link"] = short_url


_OPEN_PAYMENT_LINK_STATUSES = frozenset({"created", "issued", "partially_paid"})


def _is_payment_link_quota_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "payment_link" in msg and "limit" in msg


def format_payment_link_failure_message() -> str:
    """Customer-facing text when Razorpay checkout cannot be prepared."""
    return (
        "We couldn't open the payment page just now. "
        "Please reply *PAY* in a moment to try again."
    )


def _plink_matches_booking(plink: dict[str, Any], booking_id: str) -> bool:
    notes = plink.get("notes") or {}
    ref = str(plink.get("reference_id") or "")
    bid = str(booking_id)
    if str(notes.get("booking_id")) == bid:
        return True
    if ref == bid or ref.startswith(f"{bid}-"):
        return True
    return False


async def resolve_prepay_payment_status(
    booking_id: str,
    session_state: dict[str, Any] | None = None,
) -> str | None:
    """Order status first, then legacy payment-link status for old sessions."""
    order_status = await resolve_order_payment_status(booking_id, session_state)
    if order_status:
        return order_status
    return await _resolve_legacy_payment_link_status(booking_id, session_state)


async def _resolve_legacy_payment_link_status(
    booking_id: str,
    session_state: dict[str, Any] | None = None,
) -> str | None:
    """Return Razorpay payment-link status: paid, created, expired, cancelled, or None."""
    client = _get_client()
    if not client:
        return None

    link_id = (session_state or {}).get("razorpay_payment_link_id")
    if link_id:
        try:
            plink = client.payment_link.fetch(link_id)
            _cache_payment_link_in_session(session_state, plink)
            return plink.get("status")
        except Exception as exc:
            logger.warning(f"[razorpay] fetch link {link_id} failed: {exc}")

    try:
        by_ref = client.payment_link.all({"reference_id": str(booking_id)[:40], "count": 20})
        for plink in by_ref.get("items") or []:
            if not _plink_matches_booking(plink, str(booking_id)):
                continue
            _cache_payment_link_in_session(session_state, plink)
            return plink.get("status")
    except Exception as exc:
        logger.warning(f"[razorpay] reference_id lookup failed for {booking_id}: {exc}")

    try:
        recent = client.payment_link.all({"count": 100})
        for plink in recent.get("items") or []:
            if not _plink_matches_booking(plink, str(booking_id)):
                continue
            _cache_payment_link_in_session(session_state, plink)
            return plink.get("status")
    except Exception as exc:
        logger.warning(f"[razorpay] recent-link scan failed for {booking_id}: {exc}")

    return None


async def resolve_payment_link_status(
    booking_id: str,
    session_state: dict[str, Any] | None = None,
) -> str | None:
    """Backward-compatible — prefers Orders API, falls back to payment links."""
    return await resolve_prepay_payment_status(booking_id, session_state)


async def recover_prepay_if_already_paid(
    booking_id: str,
    session_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    If Razorpay shows paid (or DB already confirmed), fulfill and return state.
    States: already_confirmed | fulfilled | fulfill_failed | pending
    """
    from tools.db_tools import get_booking_with_customer

    booking = await get_booking_with_customer(booking_id)
    if not booking:
        return {"state": "pending"}

    if booking.get("status") == "confirmed":
        if booking.get("service_type") in ("takeaway", "delivery", "dine_in"):
            from tools.prepay_fulfillment import retry_kds_for_confirmed_booking
            had_kds_flag = bool(booking.get("kds_sent_at"))
            logger.info(
                f"[razorpay] Booking {booking_id} confirmed — verify KDS "
                f"(kds_sent_at={'set' if had_kds_flag else 'null'})"
            )
            ok = await retry_kds_for_confirmed_booking(booking_id, booking)
            if ok and not had_kds_flag:
                return {"state": "kds_retried", "booking": booking}
            if ok:
                return {"state": "already_confirmed", "booking": booking}
            if not had_kds_flag:
                return {"state": "kds_retry_failed", "booking": booking}
        return {"state": "already_confirmed", "booking": booking}

    link_status = await resolve_prepay_payment_status(booking_id, session_state)
    paid_on_razorpay = link_status == "paid"
    paid_in_db = booking.get("payment_status") == "paid"

    if not paid_on_razorpay and not paid_in_db:
        return {"state": "pending", "link_status": link_status}

    logger.info(
        f"[razorpay] Recovering prepay for booking {booking_id} "
        f"(link_status={link_status}, db_paid={paid_in_db})"
    )
    result = await _mark_paid_and_fulfill(booking_id, source="prepay_recovery")
    if result.get("fulfilled"):
        return {"state": "fulfilled", "booking": booking, "result": result}
    return {"state": "fulfill_failed", "booking": booking, "result": result}


def _reusable_payment_link(session_state: dict[str, Any] | None) -> str | None:
    link = (session_state or {}).get("payment_link")
    if link and not is_placeholder_payment_link(str(link)):
        return str(link)
    return None


_OPEN_ORDER_STATUSES = frozenset({"created", "attempted"})


async def ensure_prepay_payment_link(
    booking_id: str,
    amount: float,
    customer_name: str,
    description: str,
    *,
    customer_phone: str | None = None,
    session_state: dict[str, Any] | None = None,
) -> str | None:
    """
    Return hosted checkout URL (/pay/{booking_id}) backed by Razorpay Orders API.
    Unlimited checkouts in test mode — no payment-link quota.
    """
    if not booking_id:
        return None
    if not razorpay_configured():
        logger.error(
            f"[razorpay] ensure_prepay_payment_link unavailable for {booking_id} "
            f"(status={razorpay_status_message()})"
        )
        return None

    checkout_url = build_checkout_page_url(str(booking_id))
    existing = _reusable_payment_link(session_state)
    if existing:
        return existing

    pay_status = await resolve_prepay_payment_status(str(booking_id), session_state)
    if pay_status == "paid":
        return _reusable_payment_link(session_state)
    if pay_status in _OPEN_ORDER_STATUSES or pay_status in _OPEN_PAYMENT_LINK_STATUSES:
        existing = _reusable_payment_link(session_state)
        if existing:
            logger.info(f"[razorpay] Reusing open checkout for booking {booking_id}")
            return existing
        # Session may be unavailable in scheduler/reminder contexts.
        # Hosted checkout URL is deterministic for booking_id, so return it.
        return checkout_url

    try:
        await create_razorpay_order(
            str(booking_id), amount, customer_name, description,
            customer_phone=customer_phone,
            session_state=session_state,
        )
        return _reusable_payment_link(session_state) or checkout_url
    except Exception as exc:
        logger.error(f"[razorpay] ensure_prepay_payment_link failed for {booking_id}: {exc}")
        return None


async def build_scheduled_payment_line(
    booking_id: str,
    amount: float,
    customer_name: str,
    customer_phone: str,
    description: str,
    session_state: dict[str, Any],
    *,
    service_type: str = "takeaway",
) -> tuple[str, bool]:
    """
    Scheduled slots always require online prepay before kitchen fulfillment.
    Never falls back to counter/delivery cash messaging.
    """
    session_state["payment_mode"] = "prepay"
    if not booking_id:
        return "", False

    link = await ensure_prepay_payment_link(
        str(booking_id), amount, customer_name, description,
        customer_phone=customer_phone,
        session_state=session_state,
    )
    if not link:
        logger.error(
            f"[payment] build_scheduled_payment_line failed for {booking_id} "
            f"({service_type}, status={razorpay_status_message()})"
        )
        return "", False
    return format_razorpay_payment_line(link), True


async def build_payment_line(
    booking_id: str,
    amount: float,
    customer_name: str,
    customer_phone: str,
    description: str,
    session_state: dict[str, Any],
    *,
    counter_fallback: str = "💳 Payment can be made at the counter.",
    delivery_fallback: str = "💳 Payment can be made on delivery.",
    service_type: str = "takeaway",
) -> str:
    """Return WhatsApp payment line — Razorpay link when prepay + configured."""
    if not wants_online_payment(session_state):
        return counter_fallback if service_type != "delivery" else delivery_fallback

    link = await ensure_prepay_payment_link(
        booking_id, amount, customer_name, description,
        customer_phone=customer_phone,
        session_state=session_state,
    )
    if not link:
        logger.warning(
            f"[payment] build_payment_line failed for {booking_id} "
            f"(status={razorpay_status_message()})"
        )
        return counter_fallback if service_type != "delivery" else delivery_fallback
    return format_razorpay_payment_line(link)


async def verify_payment(razorpay_order_id: str) -> bool:
    """Check if a Razorpay order is paid."""
    client = _get_client()
    if not client:
        logger.warning("[razorpay] Not configured — skipping payment verification")
        return False

    try:
        order = client.order.fetch(razorpay_order_id)
        if order.get("status") == "paid":
            logger.info(f"[razorpay] Payment verified for order {razorpay_order_id}")
            return True
        logger.warning(f"[razorpay] Payment not completed for order {razorpay_order_id}")
        return False
    except Exception as e:
        logger.error(f"[razorpay] verify_payment failed: {e}")
        return False


async def initiate_refund(razorpay_order_id: str, amount: float) -> bool:
    """Initiate refund for a cancelled reservation advance."""
    client = _get_client()
    if not client:
        logger.warning("[razorpay] Not configured — refund not processed")
        return False

    try:
        amount_paise = int(round(amount * 100))
        payments = client.order.payments(razorpay_order_id)
        if not payments.get("items"):
            logger.warning(f"[razorpay] No payments found for order {razorpay_order_id}")
            return False

        payment_id = payments["items"][0]["id"]
        refund_response = client.payment.refund(
            payment_id,
            data={
                "amount": amount_paise,
                "notes": {"order_id": razorpay_order_id, "reason": "Reservation cancelled"},
            },
        )
        status = refund_response.get("status", "")
        logger.info(f"[razorpay] Refund {refund_response.get('id')} status={status}")
        return status in ("processed", "initiated", "pending")
    except Exception as e:
        logger.error(f"[razorpay] Refund failed: {e}")
        return False


def _webhook_signing_secret() -> str | None:
    return settings.razorpay_webhook_secret or settings.razorpay_key_secret


async def verify_webhook_signature(body: str, signature: str) -> bool:
    """Verify Razorpay webhook X-Razorpay-Signature header."""
    client = _get_client()
    secret = _webhook_signing_secret()
    if not client or not secret:
        if settings.environment == "production":
            logger.error("[razorpay] Webhook received but signing secret is not configured")
            return False
        logger.warning("[razorpay] Skipping webhook signature verification (dev)")
        return True

    try:
        return client.utility.verify_webhook_signature(
            body=body,
            signature=signature,
            secret=secret,
        )
    except Exception as e:
        logger.error(f"[razorpay] Webhook signature verification failed: {e}")
        return False


async def verify_payment_link_callback(params: dict[str, str]) -> bool:
    """Verify Razorpay GET callback query params after payment link checkout."""
    client = _get_client()
    if not client:
        return False
    try:
        return client.utility.verify_payment_link_signature({
            "payment_link_id": params.get("razorpay_payment_link_id", ""),
            "payment_link_reference_id": params.get("razorpay_payment_link_reference_id", ""),
            "payment_link_status": params.get("razorpay_payment_link_status", ""),
            "razorpay_payment_id": params.get("razorpay_payment_id", ""),
            "razorpay_signature": params.get("razorpay_signature", ""),
        })
    except Exception as e:
        logger.error(f"[razorpay] Payment link callback verify failed: {e}")
        return False


async def _mark_paid_and_fulfill(booking_id: str, *, source: str) -> dict[str, Any]:
    from tools.db_tools import update_booking_payment_status, get_booking_with_customer
    from tools.prepay_fulfillment import fulfill_from_webhook

    booking = await get_booking_with_customer(booking_id)
    if booking and booking.get("payment_status") == "paid" and booking.get("status") == "confirmed":
        return {"ok": True, "booking_id": booking_id, "fulfilled": True, "source": source, "already_done": True}

    # Payment capture and kitchen dispatch are separate concerns.
    # Never strand payment_status when fulfillment has a transient failure.
    if not booking or booking.get("payment_status") != "paid":
        await update_booking_payment_status(booking_id, "paid")

    fulfilled = await fulfill_from_webhook(booking_id)
    if not fulfilled:
        logger.error(
            f"[razorpay] Fulfillment failed for booking {booking_id} source={source} — "
            "payment_status kept as paid"
        )
        return {
            "ok": False,
            "booking_id": booking_id,
            "fulfilled": False,
            "source": source,
            "reason": "fulfillment_failed",
            "payment_status": "paid",
        }

    logger.info(
        f"[razorpay] Booking {booking_id} payment_status=paid "
        f"fulfilled={fulfilled} source={source}"
    )
    return {"ok": True, "booking_id": booking_id, "fulfilled": fulfilled, "source": source}


async def _resolve_booking_from_payment_entity(entity: dict[str, Any]) -> str | None:
    notes = entity.get("notes") or {}
    booking_id = notes.get("booking_id")
    if booking_id:
        return str(booking_id)
    link_id = entity.get("payment_link_id") or entity.get("id")
    if not link_id:
        return None
    client = _get_client()
    if not client:
        return None
    try:
        plink = client.payment_link.fetch(link_id)
        plink_notes = plink.get("notes") or {}
        return plink_notes.get("booking_id")
    except Exception as e:
        logger.error(f"[razorpay] Failed to fetch payment link {link_id}: {e}")
        return None


async def notify_customer_payment_failure(
    booking_id: str,
    *,
    reason: str = "failed",
    regenerate_link: bool = True,
) -> bool:
    """Send WhatsApp notice when Razorpay prepay fails, expires, or is cancelled."""
    from tools.db_tools import get_booking_with_customer
    from tools.prepay_fulfillment import load_prepay_payload

    booking = await get_booking_with_customer(booking_id)
    if not booking:
        logger.warning(f"[razorpay] notify_payment_failure — booking {booking_id} not found")
        return False
    if booking.get("payment_status") == "paid" or booking.get("status") == "confirmed":
        return False

    phone = booking.get("customer_phone")
    restaurant_id = booking.get("restaurant_id")
    customer_name = booking.get("customer_name") or "Guest"
    if not phone or not restaurant_id:
        return False

    payload = await load_prepay_payload(restaurant_id, phone, booking_id)
    total = float((payload or {}).get("total") or 0)
    service_type = booking.get("service_type") or (payload or {}).get("service_type") or "order"

    reason_text = {
        "cancelled": "Your payment was cancelled.",
        "expired": "Your payment link has expired.",
        "failed": "Your payment could not be processed.",
    }.get(reason, "Your payment was not completed.")

    payment_line = ""
    if regenerate_link and total >= 1:
        try:
            description = f"{service_type.replace('_', ' ').title()} — retry payment"
            link = await create_payment_link(
                booking_id, total, customer_name, description, customer_phone=phone,
            )
            if not is_placeholder_payment_link(link):
                payment_line = f"\n\n💳 Tap to pay and confirm your order:\n{link}"
        except Exception as e:
            logger.warning(f"[razorpay] Could not regenerate link for {booking_id}: {e}")

    from tools.whatsapp_tools import send_whatsapp_message

    await send_whatsapp_message(
        phone,
        f"Hi {customer_name}! {reason_text}\n\n"
        f"Your order is still on hold — complete payment to send it to the kitchen."
        f"{payment_line}\n\n"
        f"Reply *pay* anytime to get your payment link again.",
        restaurant_id,
    )
    return True


async def prepare_checkout_page(booking_id: str, token: str) -> dict[str, Any]:
    """Load or create Razorpay order for the hosted /pay checkout page."""
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

    order_status = await resolve_order_payment_status(booking_id, session)
    order_id = session.get("razorpay_order_id")
    description = f"Order {token_label}".strip() or f"Booking {booking_id[:8]}"

    if order_status not in _OPEN_ORDER_STATUSES:
        order_id = await create_razorpay_order(
            booking_id, amount, customer_name, description,
            customer_phone=phone, session_state=session,
        )
    elif not order_id:
        order_id = await create_razorpay_order(
            booking_id, amount, customer_name, description,
            customer_phone=phone, session_state=session,
        )

    if phone and session:
        await save_session_state(restaurant_id, phone, session)

    restaurant_name = "Restaurant"
    try:
        from tools.booking_mechanisms import fetch_restaurant_info
        info = await fetch_restaurant_info(restaurant_id)
        restaurant_name = (info.get("display_name") or info.get("name") or restaurant_name)
    except Exception:
        pass

    contact = _format_contact(phone) or ""
    return {
        "key_id": settings.razorpay_key_id,
        "order_id": order_id,
        "amount_paise": int(round(amount * 100)),
        "restaurant_name": restaurant_name[:120],
        "description": description[:255],
        "customer_name": customer_name[:120],
        "contact": contact.lstrip("+"),
        "booking_id": booking_id,
        "retry_url": build_hosted_checkout_url(booking_id),
        "test_mode": razorpay_status_message() == "enabled_test",
    }


async def resolve_checkout_context(booking_id: str, token: str) -> dict[str, Any]:
    """Load booking and subtotal for method selection (no order creation yet)."""
    if not verify_checkout_token(booking_id, token):
        return {"error": "invalid_token"}

    from tools.db_tools import get_booking_with_customer, get_session_state

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

    subtotal = float(session.get("order_total") or 0)
    if subtotal < 1:
        from tools.prepay_fulfillment import load_prepay_payload
        payload = await load_prepay_payload(restaurant_id, phone, booking_id)
        subtotal = float((payload or {}).get("total") or 0)
    if subtotal < 1:
        return {"error": "amount_missing"}

    return {
        "booking_id": booking_id,
        "token": token,
        "subtotal": round(subtotal, 2),
        "token_label": booking.get("token_number") or "",
        "test_mode": razorpay_status_message() == "enabled_test",
    }


async def create_order_for_method(booking_id: str, token: str, method: str) -> dict[str, Any]:
    """Create a Razorpay order restricted to selected payment method."""
    if not verify_checkout_token(booking_id, token):
        return {"error": "invalid_token"}
    if method not in FEE_RATES:
        return {"error": "invalid_method"}

    from tools.db_tools import (
        get_booking_with_customer,
        get_session_state,
        save_session_state,
        save_booking_payment_meta,
    )

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

    subtotal = float(session.get("order_total") or 0)
    if subtotal < 1:
        from tools.prepay_fulfillment import load_prepay_payload
        payload = await load_prepay_payload(restaurant_id, phone, booking_id)
        subtotal = float((payload or {}).get("total") or 0)
    if subtotal < 1:
        return {"error": "amount_missing"}

    fee = compute_fee_inclusive_total(subtotal, method)

    session.pop("razorpay_order_id", None)
    customer_name = booking.get("customer_name") or session.get("customer_name") or "Guest"
    token_label = booking.get("token_number") or ""
    description = f"Order {token_label}".strip() or f"Booking {booking_id[:8]}"

    order_id = await create_razorpay_order(
        booking_id,
        fee["customer_total"],
        customer_name,
        description,
        customer_phone=phone,
        session_state=session,
        payment_method=method,
        fee_meta=fee,
    )

    if phone and session:
        await save_session_state(restaurant_id, phone, session)

    await save_booking_payment_meta(
        booking_id,
        payment_method=method,
        fee_pct=fee["fee_pct"],
        fee_amount=fee["fee_amount"],
        order_subtotal=fee["subtotal"],
        restaurant_payout=fee["restaurant_payout"],
    )

    restaurant_name = "Restaurant"
    try:
        from tools.booking_mechanisms import fetch_restaurant_info
        info = await fetch_restaurant_info(restaurant_id)
        restaurant_name = (info.get("display_name") or info.get("name") or restaurant_name)
    except Exception:
        pass

    contact = _format_contact(phone) or ""
    return {
        "key_id": settings.razorpay_key_id,
        "order_id": order_id,
        "amount_paise": int(round(fee["customer_total"] * 100)),
        "restaurant_name": restaurant_name[:120],
        "description": description[:255],
        "customer_name": customer_name[:120],
        "contact": contact.lstrip("+"),
        "booking_id": booking_id,
        "method": method,
        "method_config": _RAZORPAY_METHOD_CONFIG[method],
        "test_mode": razorpay_status_message() == "enabled_test",
    }


def render_method_selection_html(ctx: dict[str, Any]) -> str:
    """Render method picker and open Razorpay only after customer chooses a tile."""
    import json

    booking_id = json.dumps(ctx["booking_id"])
    token = json.dumps(ctx["token"])
    subtotal = float(ctx.get("subtotal") or 0)
    amount_display = f"INR {subtotal:.0f}" if subtotal == int(subtotal) else f"INR {subtotal:.2f}"
    token_label = str(ctx.get("token_label") or "").strip()
    token_html = f'<p class="muted">Order {token_label}</p>' if token_label else ""
    retry_url = json.dumps(build_checkout_page_url(str(ctx["booking_id"])))
    test_mode = "true" if ctx.get("test_mode") else "false"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Choose payment method</title>
    <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
    <style>
        :root {{
            --bg-0: #f5f9ff;
            --bg-1: #e9f0ff;
            --ink: #0f172a;
            --muted: #5b6678;
            --line: #dbe7ff;
            --card: #ffffff;
            --brand: #3395ff;
            --brand-ink: #0b72e7;
            --upi-bg: #f3f8ff;
            --upi-line: #8ec5ff;
            --card-bg: #f8fafc;
            --card-line: #cbd5e1;
        }}
        * {{ box-sizing: border-box; }}
        body {{
            font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
            margin: 0;
            min-height: 100vh;
            padding: 20px 14px;
            color: var(--ink);
            background:
                radial-gradient(circle at 10% 10%, rgba(51,149,255,0.14), transparent 46%),
                radial-gradient(circle at 90% 85%, rgba(51,149,255,0.10), transparent 42%),
                linear-gradient(165deg, var(--bg-0), var(--bg-1));
            display: grid;
            align-items: start;
        }}
        .card {{
            width: min(480px, 100%);
            margin: 0 auto;
            background: var(--card);
            border: 1px solid var(--line);
            border-radius: 18px;
            padding: 20px 16px 16px;
            box-shadow: 0 14px 34px rgba(30, 64, 175, 0.12);
            animation: rise 280ms ease-out;
        }}
        @keyframes rise {{
            from {{ opacity: 0; transform: translateY(8px); }}
            to {{ opacity: 1; transform: translateY(0); }}
        }}
        h1 {{ margin: 0 0 4px; font-size: clamp(34px, 8vw, 54px); line-height: 1.02; letter-spacing: -0.03em; }}
        .amount {{ margin: 0 0 6px; font-size: clamp(26px, 6vw, 38px); font-weight: 800; color: var(--brand-ink); }}
        .muted {{ color: var(--muted); font-size: 15px; margin: 0 0 14px; }}
        .tile {{
            width: 100%;
            text-align: left;
            display: block;
            border: 1px solid #e2e8f0;
            border-radius: 14px;
            padding: 14px 14px;
            margin-bottom: 12px;
            background: #fff;
            cursor: pointer;
            transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
        }}
        .tile strong {{ display: block; font-size: 22px; line-height: 1.12; margin-bottom: 5px; letter-spacing: -0.02em; }}
        .tile span {{ display: block; color: #475569; font-size: 14px; }}
        .tile-upi {{ background: var(--upi-bg); border-color: var(--upi-line); }}
        .tile-card {{ background: var(--card-bg); border-color: var(--card-line); }}
        .tile:active {{ transform: translateY(1px); }}
        .tile:hover {{ box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08); border-color: #cbd5e1; }}
        .tile:disabled {{ opacity: 0.58; cursor: not-allowed; box-shadow: none; }}
        .spinner {{ display: none; margin: 6px 0 10px; color: #475569; font-size: 13px; }}
        .legal {{ margin: 4px 0 0; color: #6b7280; font-size: 12px; line-height: 1.45; }}
        .label {{
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-size: 11px;
            color: #0b72e7;
            background: #eff6ff;
            border: 1px solid #b8deff;
            border-radius: 999px;
            padding: 4px 10px;
            margin: 0 0 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.06em;
        }}
        .test-tools {{
            display: none;
            margin-top: 12px;
            padding: 10px 12px;
            border: 1px dashed #8ec5ff;
            border-radius: 12px;
            background: #eff6ff;
        }}
        .test-tools p {{ margin: 0 0 8px; color: #0b72e7; font-size: 12px; line-height: 1.4; }}
        .test-btn {{
            appearance: none;
            border: 0;
            border-radius: 10px;
            padding: 10px 12px;
            background: #3395ff;
            color: #fff;
            font-weight: 700;
            cursor: pointer;
            width: 100%;
            text-align: center;
        }}
    </style>
</head>
<body>
    <main class="card">
        <p class="label">Secure checkout</p>
        <h1>Choose payment method</h1>
        <p class="amount">{amount_display}</p>
        {token_html}

        <button class="tile tile-upi" id="tile-upi" onclick="pay('upi')">
            <strong>Pay via UPI</strong>
            <span>Google Pay, PhonePe, Paytm, BHIM</span>
        </button>

        <button class="tile tile-card" id="tile-card" onclick="pay('card')">
            <strong>Card / Netbanking / Wallet</strong>
            <span>Credit or debit card, netbanking, wallets</span>
        </button>

        <p class="spinner" id="spinner">Preparing secure payment...</p>
        <div class="test-tools" id="testTools">
            <p>Test mode detected. If sandbox rails keep failing, use this button to simulate a successful payment for QA validation.</p>
            <button class="test-btn" id="mockSuccessBtn" type="button">Simulate Test Payment Success</button>
        </div>
        <p class="legal">Processing fee is accounted in merchant settlement: UPI 1% and cards/netbanking/wallets 2.8%. Customer pays the amount shown above.</p>
        <p class="legal">Payment cannot be reversed once completed.</p>
    </main>

    <script>
        var bookingId = {booking_id};
        var token = {token};
        var retryUrl = {retry_url};
        var testMode = {test_mode};

        function lockTiles(lock) {{
            document.getElementById("tile-upi").disabled = lock;
            document.getElementById("tile-card").disabled = lock;
            document.getElementById("spinner").style.display = lock ? "block" : "none";
        }}

        function failBack(reason) {{
            var q = "?status=failed";
            if (bookingId) q += "&booking_id=" + encodeURIComponent(bookingId);
            if (reason) q += "&reason=" + encodeURIComponent(reason);
            if (retryUrl) q += "&retry=" + encodeURIComponent(retryUrl);
            window.location.href = "/payment/complete" + q;
        }}

        function sendFailureEvent(kind, details) {{
            var payload = JSON.stringify({{
                kind: kind,
                booking_id: bookingId,
                details: details || {{}}
            }});
            try {{
                if (navigator && typeof navigator.sendBeacon === "function") {{
                    var blob = new Blob([payload], {{ type: "application/json" }});
                    navigator.sendBeacon("/pay/failure-event", blob);
                    return;
                }}
            }} catch (_e) {{}}
            try {{
                fetch("/pay/failure-event", {{
                    method: "POST",
                    headers: {{ "Content-Type": "application/json" }},
                    body: payload,
                    keepalive: true
                }});
            }} catch (_e) {{}}
        }}

        function pay(method) {{
            lockTiles(true);
            var url = "/pay/" + bookingId + "/create-order?t=" + encodeURIComponent(token) + "&method=" + encodeURIComponent(method);
            fetch(url, {{ method: "POST" }})
            .then(function(r) {{ return r.json(); }})
            .then(function(ctx) {{
                if (ctx.error) {{ lockTiles(false); alert("Could not start payment. Please try again."); return; }}
                if (ctx.already_paid) {{ window.location.href = "/payment/complete?status=paid&booking_id=" + encodeURIComponent(bookingId); return; }}
                openRazorpay(ctx);
            }})
            .catch(function() {{ lockTiles(false); failBack("create_order_failed"); }});
        }}

        function simulateSuccess() {{
            fetch("/pay/mock-success", {{
                method: "POST",
                headers: {{ "Content-Type": "application/json" }},
                body: JSON.stringify({{ booking_id: bookingId }})
            }}).then(function(r) {{ return r.json(); }}).then(function(data) {{
                if (data && data.ok && data.redirect) {{
                    window.location.href = data.redirect;
                    return;
                }}
                failBack((data && data.reason) || "mock_success_failed");
            }}).catch(function() {{
                failBack("mock_success_failed");
            }});
        }}

        function openRazorpay(ctx) {{
            var options = {{
                key: ctx.key_id,
                order_id: ctx.order_id,
                amount: ctx.amount_paise,
                name: ctx.restaurant_name,
                description: ctx.description,
                prefill: {{ name: ctx.customer_name, contact: ctx.contact }},
                method: ctx.method_config,
                theme: {{ color: "#3395ff" }},
                handler: function (response) {{
                    fetch("/pay/verify", {{
                        method: "POST",
                        headers: {{ "Content-Type": "application/json" }},
                        body: JSON.stringify(response)
                    }}).then(function(r) {{ return r.json(); }}).then(function(data) {{
                        window.location.href = data.redirect || ("/payment/complete?status=paid&booking_id=" + encodeURIComponent(bookingId));
                    }}).catch(function() {{
                        window.location.href = "/payment/complete?status=paid&booking_id=" + encodeURIComponent(bookingId);
                    }});
                }},
                modal: {{
                    ondismiss: function() {{
                        sendFailureEvent("checkout_dismissed", {{ source: "modal" }});
                        lockTiles(false);
                        failBack("checkout_dismissed");
                    }}
                }}
            }};

            var rzp = new Razorpay(options);
            rzp.on("payment.failed", function(response) {{
                var err = (response && response.error) || {{}};
                sendFailureEvent("payment_failed", {{
                    code: err.code || "",
                    reason: err.reason || "",
                    source: err.source || "",
                    step: err.step || "",
                    description: err.description || "",
                    metadata: err.metadata || {{}}
                }});
                failBack(err.reason || err.code || "payment_failed");
            }});
            rzp.open();
        }}

        if (testMode) {{
            var testTools = document.getElementById("testTools");
            var mockSuccessBtn = document.getElementById("mockSuccessBtn");
            if (testTools) testTools.style.display = "block";
            if (mockSuccessBtn) mockSuccessBtn.addEventListener("click", simulateSuccess);
        }}
    </script>
</body>
</html>"""


def render_checkout_html(ctx: dict[str, Any]) -> str:
    """Minimal mobile page that auto-opens Razorpay Standard Checkout."""
    import json

    key_id = json.dumps(ctx["key_id"])
    order_id = json.dumps(ctx["order_id"])
    name = json.dumps(ctx["restaurant_name"])
    description = json.dumps(ctx["description"])
    customer_name = json.dumps(ctx["customer_name"])
    contact = json.dumps(ctx.get("contact") or "")
    retry_url = json.dumps(ctx.get("retry_url") or "")
    booking_id = json.dumps(ctx.get("booking_id") or "")
    test_mode = "true" if ctx.get("test_mode") else "false"
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Secure payment</title>
  <style>
    body {{ font-family: system-ui, sans-serif; text-align: center; padding: 2rem; }}
    .muted {{ color: #666; font-size: 0.95rem; }}
  </style>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
</head>
<body>
  <h2>Opening secure payment…</h2>
  <p class="muted">Complete payment to confirm your order.<br/>You can return to WhatsApp after paying.</p>
    <div id="testTools" style="display:none;max-width:28rem;margin:1.25rem auto 0;padding:0.85rem 1rem;border:1px dashed #f59e0b;border-radius:0.85rem;background:#fffbeb;">
        <p class="muted" style="margin:0 0 0.65rem;color:#92400e;"><strong>Test mode</strong>: Razorpay sandbox methods can fail unpredictably. Use the button below to simulate a successful payment for QA.</p>
        <button id="mockSuccessBtn" type="button" style="appearance:none;border:none;border-radius:0.75rem;background:#e36d26;color:#fff;padding:0.8rem 1rem;font-weight:700;cursor:pointer;">Simulate Test Payment Success</button>
    </div>
  <script>
        var retryUrl = {retry_url};
        var bookingId = {booking_id};
                var testMode = {test_mode};

        function sendFailureEvent(kind, details) {{
            var payload = JSON.stringify({{
                kind: kind,
                booking_id: bookingId,
                order_id: {order_id},
                details: details || {{}}
            }});
            try {{
                if (navigator && typeof navigator.sendBeacon === "function") {{
                    var blob = new Blob([payload], {{ type: "application/json" }});
                    navigator.sendBeacon("/pay/failure-event", blob);
                    return;
                }}
            }} catch (_e) {{}}

            try {{
                fetch("/pay/failure-event", {{
                    method: "POST",
                    headers: {{ "Content-Type": "application/json" }},
                    body: payload,
                    keepalive: true
                }});
            }} catch (_e) {{}}
        }}

        function finishRedirect(status, reason) {{
            var q = "?status=" + encodeURIComponent(status || "unknown");
            if (bookingId) q += "&booking_id=" + encodeURIComponent(bookingId);
            if (reason) q += "&reason=" + encodeURIComponent(reason);
            if (retryUrl) q += "&retry=" + encodeURIComponent(retryUrl);
            setTimeout(function() {{
                window.location.href = "/payment/complete" + q;
            }}, 180);
        }}

        function simulateSuccess() {{
            fetch("/pay/mock-success", {{
                method: "POST",
                headers: {{ "Content-Type": "application/json" }},
                body: JSON.stringify({{ booking_id: bookingId, order_id: {order_id} }})
            }}).then(function(r) {{ return r.json(); }}).then(function(data) {{
                if (data && data.ok && data.redirect) {{
                    window.location.href = data.redirect;
                    return;
                }}
                finishRedirect("failed", (data && data.reason) || "mock_success_failed");
            }}).catch(function() {{
                finishRedirect("failed", "mock_success_failed");
            }});
        }}

        if (testMode) {{
            var testTools = document.getElementById("testTools");
            var mockSuccessBtn = document.getElementById("mockSuccessBtn");
            if (testTools) testTools.style.display = "block";
            if (mockSuccessBtn) mockSuccessBtn.addEventListener("click", simulateSuccess);
        }}

    var options = {{
      key: {key_id},
      order_id: {order_id},
      name: {name},
      description: {description},
      prefill: {{ name: {customer_name}, contact: {contact} }},
      theme: {{ color: "#2563eb" }},
      handler: function (response) {{
        fetch("/pay/verify", {{
          method: "POST",
          headers: {{ "Content-Type": "application/json" }},
          body: JSON.stringify(response)
        }}).then(function(r) {{ return r.json(); }}).then(function(data) {{
                    var paidFallback = "/payment/complete?status=paid";
                    if (bookingId) paidFallback += "&booking_id=" + encodeURIComponent(bookingId);
                    window.location.href = data.redirect || paidFallback;
        }}).catch(function() {{
                    var paidFallback = "/payment/complete?status=paid";
                    if (bookingId) paidFallback += "&booking_id=" + encodeURIComponent(bookingId);
                    window.location.href = paidFallback;
        }});
      }},
      modal: {{
        ondismiss: function() {{
                    sendFailureEvent("checkout_dismissed", {{ source: "modal" }});
                    finishRedirect("cancelled", "checkout_dismissed");
        }}
      }}
    }};
    var rzp = new Razorpay(options);
        rzp.on("payment.failed", function(response) {{
            var err = (response && response.error) || {{}};
            var reason = err.reason || err.code || "payment_failed";
            sendFailureEvent("payment_failed", {{
                reason: reason,
                code: err.code || "",
                description: err.description || "",
                source: err.source || "",
                step: err.step || "",
                payment_id: err.metadata && err.metadata.payment_id || "",
                order_id: err.metadata && err.metadata.order_id || ""
            }});
            finishRedirect("failed", reason);
    }});
    rzp.open();
  </script>
</body>
</html>"""


async def verify_checkout_payment(body: dict[str, Any]) -> dict[str, Any]:
    """Verify Razorpay Checkout signature and fulfill the booking."""
    client = _get_client()
    if not client:
        return {"ok": False, "reason": "not_configured"}

    order_id = body.get("razorpay_order_id") or ""
    payment_id = body.get("razorpay_payment_id") or ""
    signature = body.get("razorpay_signature") or ""
    if not (order_id and payment_id and signature):
        return {"ok": False, "reason": "missing_fields"}

    try:
        client.utility.verify_payment_signature({
            "razorpay_order_id": order_id,
            "razorpay_payment_id": payment_id,
            "razorpay_signature": signature,
        })
    except Exception as exc:
        logger.error(f"[razorpay] checkout signature verify failed: {exc}")
        return {"ok": False, "reason": "invalid_signature"}

    booking_id = None
    order_notes: dict[str, Any] = {}
    try:
        order = client.order.fetch(order_id)
        order_notes = order.get("notes") or {}
        booking_id = order_notes.get("booking_id")
    except Exception as exc:
        logger.error(f"[razorpay] fetch order {order_id} after checkout: {exc}")
        return {"ok": False, "reason": "order_fetch_failed"}

    if not booking_id:
        return {"ok": False, "reason": "booking_id_missing"}

    payment_method = str(order_notes.get("payment_method") or "").strip().lower()
    if payment_method in FEE_RATES:
        try:
            from tools.db_tools import save_booking_payment_meta

            subtotal = round((float(order.get("amount") or 0) / 100.0), 2)
            fee_pct = float(order_notes.get("munafe_fee_pct") or FEE_RATES[payment_method])
            fee_amount = float(order_notes.get("munafe_fee_amount") or round(subtotal * fee_pct, 2))
            restaurant_payout = float(order_notes.get("restaurant_payout") or round(subtotal - fee_amount, 2))

            await save_booking_payment_meta(
                str(booking_id),
                payment_method=payment_method,
                fee_pct=fee_pct,
                fee_amount=fee_amount,
                order_subtotal=subtotal,
                restaurant_payout=restaurant_payout,
            )
        except Exception as meta_err:
            logger.warning(f"[razorpay] checkout fee-meta persist failed for {booking_id}: {meta_err}")

    try:
        result = await _mark_paid_and_fulfill(str(booking_id), source="checkout")
        return {
            **result,
            "redirect": (
                f"{settings.chat_public_url.rstrip('/')}/payment/complete"
                f"?status=paid&booking_id={quote(str(booking_id))}"
            ),
        }
    except Exception as exc:
        logger.error(f"[razorpay] checkout fulfillment failed for {booking_id}: {exc}")
        return {"ok": False, "error": str(exc)}


async def mark_test_checkout_paid(booking_id: str, order_id: str) -> dict[str, Any]:
    """Test-mode only: simulate a successful checkout for QA when Razorpay sandbox is flaky."""
    if razorpay_status_message() != "enabled_test":
        return {"ok": False, "reason": "not_test_mode"}
    if not booking_id:
        return {"ok": False, "reason": "missing_booking_id"}

    # Method-picker mock success may not have an order_id yet.
    # In test mode, allow booking-level simulation for QA determinism.
    if not order_id:
        try:
            result = await _mark_paid_and_fulfill(str(booking_id), source="test_checkout")
            return {
                **result,
                "redirect": (
                    f"{settings.chat_public_url.rstrip('/')}/payment/complete"
                    f"?status=paid&booking_id={quote(str(booking_id))}"
                ),
            }
        except Exception as exc:
            logger.error(f"[razorpay] test checkout fulfillment failed for {booking_id}: {exc}")
            return {"ok": False, "reason": "fulfillment_failed", "error": str(exc)}

    client = _get_client()
    if not client:
        return {"ok": False, "reason": "not_configured"}

    try:
        order = client.order.fetch(order_id)
    except Exception as exc:
        logger.error(f"[razorpay] test checkout order fetch failed {order_id}: {exc}")
        return {"ok": False, "reason": "order_fetch_failed"}

    order_booking_id = str((order.get("notes") or {}).get("booking_id") or "")
    if order_booking_id != str(booking_id):
        return {"ok": False, "reason": "booking_order_mismatch"}

    try:
        result = await _mark_paid_and_fulfill(str(booking_id), source="test_checkout")
        return {
            **result,
            "redirect": (
                f"{settings.chat_public_url.rstrip('/')}/payment/complete"
                f"?status=paid&booking_id={quote(str(booking_id))}"
            ),
        }
    except Exception as exc:
        logger.error(f"[razorpay] test checkout fulfillment failed for {booking_id}: {exc}")
        return {"ok": False, "reason": "fulfillment_failed", "error": str(exc)}


async def handle_payment_link_callback(query_params: dict[str, str]) -> dict[str, Any]:
    """Process customer redirect to /payment/complete after Razorpay checkout."""
    status = query_params.get("razorpay_payment_link_status", "")
    link_id = query_params.get("razorpay_payment_link_id", "")

    if status != "paid":
        if status in ("cancelled", "failed", "expired"):
            booking_id = None
            client = _get_client()
            if client and link_id:
                try:
                    plink = client.payment_link.fetch(link_id)
                    booking_id = (plink.get("notes") or {}).get("booking_id")
                except Exception:
                    pass
            if booking_id:
                await notify_customer_payment_failure(
                    str(booking_id), reason=status or "failed",
                )
        return {"ok": False, "reason": "not_paid", "status": status}

    if not await verify_payment_link_callback(query_params):
        return {"ok": False, "reason": "invalid_signature"}

    client = _get_client()
    if not client:
        return {"ok": False, "reason": "not_configured"}

    booking_id = None
    try:
        plink = client.payment_link.fetch(link_id)
        notes = plink.get("notes") or {}
        booking_id = notes.get("booking_id")
    except Exception as e:
        logger.error(f"[razorpay] Failed to fetch payment link {link_id}: {e}")
        return {"ok": False, "reason": "fetch_failed"}

    if not booking_id:
        logger.error(f"[razorpay] No booking_id in payment link {link_id} notes")
        return {"ok": False, "reason": "booking_id_missing"}

    try:
        return await _mark_paid_and_fulfill(str(booking_id), source="callback")
    except Exception as e:
        logger.error(f"[razorpay] Callback fulfillment failed for {booking_id}: {e}")
        return {"ok": False, "error": str(e)}


async def handle_payment_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """Process Razorpay payment_link, payment.captured, and order.paid events."""
    event = payload.get("event", "")
    entity = payload.get("payload", {}).get("payment_link", {}).get("entity", {})
    payment_entity = payload.get("payload", {}).get("payment", {}).get("entity", {})
    order_entity = payload.get("payload", {}).get("order", {}).get("entity", {})
    if not entity and payment_entity:
        entity = payment_entity
    if not entity and order_entity:
        entity = order_entity

    notes = entity.get("notes") or {}
    booking_id = notes.get("booking_id")
    status = entity.get("status", "")

    client = _get_client()
    if not booking_id and client and payment_entity.get("order_id"):
        try:
            order = client.order.fetch(payment_entity["order_id"])
            booking_id = (order.get("notes") or {}).get("booking_id")
        except Exception as exc:
            logger.warning(f"[razorpay] webhook order lookup failed: {exc}")

    logger.info(f"[razorpay] Webhook event={event} status={status} booking_id={booking_id}")

    paid_events = {"payment_link.paid", "payment.captured", "order.paid"}
    if event in paid_events and booking_id:
        if event == "payment.captured" and status not in ("captured", "authorized", ""):
            return {"ok": True, "event": event, "handled": False, "reason": "not_captured"}
        try:
            result = await _mark_paid_and_fulfill(str(booking_id), source="webhook")
            if not result.get("fulfilled"):
                return {"ok": False, **result}
            return result
        except Exception as e:
            logger.error(f"[razorpay] Failed to update booking {booking_id}: {e}")
            return {"ok": False, "error": str(e)}

    failure_events = {
        "payment_link.cancelled": "cancelled",
        "payment_link.expired": "expired",
        "payment.failed": "failed",
    }
    if event in failure_events:
        resolved_id = booking_id or await _resolve_booking_from_payment_entity(entity)
        if resolved_id:
            await notify_customer_payment_failure(
                str(resolved_id), reason=failure_events[event],
            )
            return {"ok": True, "event": event, "handled": True, "booking_id": resolved_id}
        return {"ok": True, "event": event, "handled": False, "reason": "booking_id_missing"}

    return {"ok": True, "event": event, "handled": False}


# Startup log
if razorpay_configured():
    logger.info(f"[razorpay] Ready ({razorpay_status_message()})")
elif RAZORPAY_AVAILABLE:
    logger.warning(
        "[razorpay] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — "
        "orders will show counter payment"
    )
