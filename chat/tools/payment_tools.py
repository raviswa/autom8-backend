"""Payment tools - Razorpay UPI payment integration (restaurant flows)."""

from __future__ import annotations

import json
import logging
from typing import Any

from config.settings import settings

logger = logging.getLogger(__name__)

try:
    import razorpay
    RAZORPAY_AVAILABLE = True
except ImportError:
    razorpay = None  # type: ignore
    RAZORPAY_AVAILABLE = False
    logger.warning(
        "[razorpay] Python package not installed — run: pip install razorpay"
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


# Razorpay client — created when keys are present
razorpay_client = None
if razorpay_configured():
    razorpay_client = razorpay.Client(
        auth=(settings.razorpay_key_id, settings.razorpay_key_secret)
    )
    logger.info(f"[razorpay] Client ready ({razorpay_status_message()})")
elif RAZORPAY_AVAILABLE:
    logger.warning(
        "[razorpay] RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not set — "
        "payment links will use placeholder URLs"
    )


def _callback_url() -> str:
    if settings.razorpay_callback_url:
        return settings.razorpay_callback_url
    return f"{settings.chat_public_url.rstrip('/')}/payment/complete"


async def create_payment_link(
    booking_id: str, amount: float, customer_name: str, description: str
) -> str:
    """Create Razorpay payment link and return the short URL."""
    if not razorpay_configured() or not razorpay_client:
        if settings.environment == "production":
            raise RuntimeError("Razorpay is not configured in production")
        logger.warning("[razorpay] Not configured — returning placeholder URL")
        return "https://payment-placeholder.com"

    try:
        amount_paise = int(round(amount * 100))
        if amount_paise < 100:
            raise ValueError(f"Amount too small for Razorpay: ₹{amount}")

        payload: dict[str, Any] = {
            "amount": amount_paise,
            "currency": "INR",
            "accept_partial": False,
            "description": description[:255],
            "customer": {"name": customer_name[:120]},
            "notify": {"sms": False, "email": False},
            "reminder_enable": True,
            "notes": {
                "booking_id": str(booking_id),
                "customer_name": customer_name[:120],
            },
            "callback_url": _callback_url(),
            "callback_method": "get",
        }

        response = razorpay_client.payment_link.create(data=payload)
        link_id = response.get("id", "")
        short_url = response.get("short_url") or response.get("url", "")
        logger.info(f"[razorpay] Payment link created: {link_id} for booking {booking_id}")
        return short_url

    except Exception as e:
        logger.error(f"[razorpay] Failed to create payment link: {e}")
        raise


async def verify_payment(razorpay_order_id: str) -> bool:
    """Check if a Razorpay order is paid."""
    if not razorpay_configured() or not razorpay_client:
        logger.warning("[razorpay] Not configured — skipping payment verification")
        return False

    try:
        order = razorpay_client.order.fetch(razorpay_order_id)
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
    if not razorpay_configured() or not razorpay_client:
        logger.warning("[razorpay] Not configured — refund not processed")
        return False

    try:
        amount_paise = int(round(amount * 100))
        payments = razorpay_client.order.payments(razorpay_order_id)
        if not payments.get("items"):
            logger.warning(f"[razorpay] No payments found for order {razorpay_order_id}")
            return False

        payment_id = payments["items"][0]["id"]
        refund_response = razorpay_client.payment.refund(
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
    secret = _webhook_signing_secret()
    if not razorpay_configured() or not razorpay_client or not secret:
        if settings.environment == "production":
            logger.error("[razorpay] Webhook received but signing secret is not configured")
            return False
        logger.warning("[razorpay] Skipping webhook signature verification (dev)")
        return True

    try:
        return razorpay_client.utility.verify_webhook_signature(
            body=body,
            signature=signature,
            secret=secret,
        )
    except Exception as e:
        logger.error(f"[razorpay] Webhook signature verification failed: {e}")
        return False


async def handle_payment_webhook(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Process Razorpay payment_link.paid (and related) events.
    Updates booking status when notes.booking_id is present.
    """
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
            from tools.db_tools import update_booking_status
            await update_booking_status(str(booking_id), "paid")
            logger.info(f"[razorpay] Booking {booking_id} marked paid")
            return {"ok": True, "booking_id": booking_id, "event": event}
        except Exception as e:
            logger.error(f"[razorpay] Failed to update booking {booking_id}: {e}")
            return {"ok": False, "error": str(e)}

    return {"ok": True, "event": event, "handled": False}
