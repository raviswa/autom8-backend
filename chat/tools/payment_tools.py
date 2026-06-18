"""Payment tools - Razorpay UPI payment integration (restaurant flows)."""

from __future__ import annotations

import logging
import re
from typing import Any

from config.settings import settings

logger = logging.getLogger(__name__)

_PLACEHOLDER_URL = "https://payment-placeholder.com"

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


async def create_payment_link(
    booking_id: str,
    amount: float,
    customer_name: str,
    description: str,
    *,
    customer_phone: str | None = None,
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
        logger.info(f"[razorpay] Payment link created: {link_id} for booking {booking_id}")
        return short_url

    except Exception as e:
        logger.error(f"[razorpay] Failed to create payment link: {e}")
        raise


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

    try:
        link = await create_payment_link(
            booking_id, amount, customer_name, description,
            customer_phone=customer_phone,
        )
        if is_placeholder_payment_link(link):
            logger.warning(
                f"[razorpay] Placeholder link for booking {booking_id} "
                f"(status={razorpay_status_message()})"
            )
            return counter_fallback if service_type != "delivery" else delivery_fallback
        session_state["payment_link"] = link
        return f"💳 Pay here to confirm your order:\n{link}"
    except Exception as e:
        logger.warning(f"[payment] build_payment_line failed for {booking_id}: {e}")
        return counter_fallback if service_type != "delivery" else delivery_fallback


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


async def handle_payment_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """Process Razorpay payment_link.paid events."""
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
            from tools.db_tools import update_booking_payment_status
            from tools.prepay_fulfillment import fulfill_takeaway_from_webhook

            await update_booking_payment_status(str(booking_id), "paid")
            fulfilled = await fulfill_takeaway_from_webhook(str(booking_id))
            logger.info(
                f"[razorpay] Booking {booking_id} payment_status=paid "
                f"takeaway_fulfilled={fulfilled}"
            )
            return {
                "ok": True,
                "booking_id": booking_id,
                "event": event,
                "takeaway_fulfilled": fulfilled,
            }
        except Exception as e:
            logger.error(f"[razorpay] Failed to update booking {booking_id}: {e}")
            return {"ok": False, "error": str(e)}

    return {"ok": True, "event": event, "handled": False}


# Startup log
if razorpay_configured():
    logger.info(f"[razorpay] Ready ({razorpay_status_message()})")
elif RAZORPAY_AVAILABLE:
    logger.warning(
        "[razorpay] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — "
        "orders will show counter payment"
    )
