"""Payment tools - Razorpay UPI payment integration (restaurant flows)."""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from config.settings import settings

logger = logging.getLogger(__name__)

_PLACEHOLDER_URL = "https://payment-placeholder.com"

RAZORPAY_NON_REFUND_NOTICE = (
    "⚠️ *Please note:* Payment cannot be reversed once completed. "
    "Cancellations or amendments are *not* possible after payment."
)


def format_razorpay_payment_line(
    link: str,
    *,
    label: str = "💳 Pay here to confirm your order:",
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
    return "placeholder" in link.lower() or link == _PLACEHOLDER_URL


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
    """Create Razorpay payment link and return the short URL."""
    client = _get_client()
    if not client:
        reason = razorpay_status_message()
        logger.error(f"[razorpay] Cannot create link — status={reason}")
        if settings.environment == "production":
            raise RuntimeError(f"Razorpay not configured ({reason})")
        return _PLACEHOLDER_URL

    try:
        amount_paise = int(round(amount * 100))
        if amount_paise < 100:
            raise ValueError(f"Amount too small for Razorpay: ₹{amount}")

        contact = _format_contact(customer_phone)
        customer: dict[str, str] = {"name": (customer_name or "Guest")[:120]}
        if contact:
            customer["contact"] = contact

        payload: dict[str, Any] = {
            "amount": amount_paise,
            "currency": "INR",
            "accept_partial": False,
            "description": description[:255],
            "reference_id": str(reference_id or booking_id)[:40],
            "customer": customer,
            "notify": {"sms": False, "email": False},
            "reminder_enable": True,
            "notes": {
                "booking_id": str(booking_id),
                "customer_name": customer_name[:120],
            },
            "callback_url": _callback_url(),
            "callback_method": "get",
        }

        response = client.payment_link.create(data=payload)
        link_id = response.get("id", "")
        short_url = response.get("short_url") or response.get("url", "")
        if not short_url:
            raise RuntimeError(f"Razorpay returned no URL: {response}")
        if session_state is not None:
            session_state["payment_link"] = short_url
            session_state["razorpay_payment_link_id"] = link_id
        logger.info(f"[razorpay] Payment link created: {link_id} for booking {booking_id}")
        return short_url

    except Exception as e:
        logger.error(f"[razorpay] Failed to create payment link: {e}")
        raise


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
    """Customer-facing text when Razorpay link creation fails."""
    if str(settings.razorpay_key_id or "").startswith("rzp_test_"):
        return (
            "⚠️ *Payment link unavailable*\n"
            "Razorpay test mode only allows 30 active payment links — the limit is reached.\n\n"
            "Please ask the restaurant to either:\n"
            "• delete old test links in the Razorpay dashboard, or\n"
            "• switch to *live* Razorpay keys for production.\n\n"
            "Reply *PAY* to retry once this is fixed."
        )
    return (
        "We couldn't generate your payment link just now. "
        "Please reply *PAY* in a moment to receive it."
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


async def resolve_payment_link_status(
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

    link_status = await resolve_payment_link_status(booking_id, session_state)
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
    Return a Razorpay short URL for prepay, reusing an open link when possible.
    Returns None when Razorpay is unavailable or link creation fails.
    """
    if not booking_id:
        return None
    if not razorpay_configured():
        logger.error(
            f"[razorpay] ensure_prepay_payment_link unavailable for {booking_id} "
            f"(status={razorpay_status_message()})"
        )
        return None

    existing = _reusable_payment_link(session_state)
    if existing:
        return existing

    link_status = await resolve_payment_link_status(str(booking_id), session_state)
    if link_status == "paid":
        return _reusable_payment_link(session_state)
    if link_status in _OPEN_PAYMENT_LINK_STATUSES:
        existing = _reusable_payment_link(session_state)
        if existing:
            logger.info(f"[razorpay] Reusing open link for booking {booking_id}")
            return existing

    try:
        link = await create_payment_link(
            str(booking_id), amount, customer_name, description,
            customer_phone=customer_phone,
            session_state=session_state,
        )
        if is_placeholder_payment_link(link):
            return None
        return link
    except Exception as exc:
        logger.warning(f"[razorpay] ensure_prepay_payment_link failed for {booking_id}: {exc}")
        existing = _reusable_payment_link(session_state)
        if existing:
            return existing
        await resolve_payment_link_status(str(booking_id), session_state)
        existing = _reusable_payment_link(session_state)
        if existing:
            logger.info(f"[razorpay] Recovered open link after create failure for {booking_id}")
            return existing
        if _is_payment_link_quota_error(exc):
            logger.error(
                f"[razorpay] payment_link quota exhausted for {booking_id} "
                f"(status={razorpay_status_message()})"
            )
            return None
        suffix = str(int(time.time()))[-6:]
        ref_id = f"{booking_id}-{suffix}"[:40]
        try:
            link = await create_payment_link(
                str(booking_id), amount, customer_name, description,
                customer_phone=customer_phone,
                session_state=session_state,
                reference_id=ref_id,
            )
            if is_placeholder_payment_link(link):
                return None
            return link
        except Exception as retry_exc:
            logger.error(
                f"[razorpay] ensure_prepay_payment_link retry failed for {booking_id}: {retry_exc}"
            )
            if not _is_payment_link_quota_error(retry_exc):
                await resolve_payment_link_status(str(booking_id), session_state)
                return _reusable_payment_link(session_state)
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

    fulfilled = await fulfill_from_webhook(booking_id)
    if not fulfilled:
        logger.error(
            f"[razorpay] Fulfillment failed for booking {booking_id} source={source} — "
            "payment_status NOT updated"
        )
        return {
            "ok": False,
            "booking_id": booking_id,
            "fulfilled": False,
            "source": source,
            "reason": "fulfillment_failed",
        }

    await update_booking_payment_status(booking_id, "paid")
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
    """Process Razorpay payment_link and payment events."""
    event = payload.get("event", "")
    entity = payload.get("payload", {}).get("payment_link", {}).get("entity", {})
    if not entity and payload.get("payload", {}).get("payment", {}):
        entity = payload["payload"]["payment"].get("entity", {})

    notes = entity.get("notes") or {}
    booking_id = notes.get("booking_id")
    status = entity.get("status", "")

    logger.info(f"[razorpay] Webhook event={event} status={status} booking_id={booking_id}")

    if event == "payment_link.paid" and booking_id:
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
