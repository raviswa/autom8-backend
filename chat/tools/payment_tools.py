"""Payment tools - Razorpay UPI payment integration."""

from typing import Dict, Any
import logging

try:
    import razorpay
    RAZORPAY_AVAILABLE = True
except ImportError:
    RAZORPAY_AVAILABLE = False
    logger = logging.getLogger(__name__)
    logger.warning("Razorpay not available, payment features disabled")

from config.settings import settings

logger = logging.getLogger(__name__)


# Razorpay client
if RAZORPAY_AVAILABLE and settings.razorpay_key_id and settings.razorpay_key_secret:
    razorpay_client = razorpay.Client(
        auth=(settings.razorpay_key_id, settings.razorpay_key_secret)
    )
else:
    razorpay_client = None


async def create_payment_link(
    booking_id: str, amount: float, customer_name: str, description: str
) -> str:
    """Create Razorpay UPI payment link, return URL."""
    if not RAZORPAY_AVAILABLE or not razorpay_client:
        if settings.environment == "production":
            raise RuntimeError("Razorpay is not configured in production")
        logger.warning("Razorpay not available, returning placeholder URL")
        return "https://payment-placeholder.com"
    
    try:
        # Amount in paise (multiply by 100)
        amount_paise = int(amount * 100)
        
        payload = {
            "amount": amount_paise,
            "currency": "INR",
            "accept_partial": False,
            "first_min_partial_amount": int(amount_paise * 0.5),  # Minimum 50% for partial payment
            "description": description,
            "customer_notify": 1,
            "reminder_enable": True,
            "notes": {
                "booking_id": booking_id,
                "customer_name": customer_name,
            },
            "callback_url": "https://yourdomain.com/webhook/razorpay",
            "callback_method": "get",
        }
        
        # Create payment link using Razorpay SDK
        response = razorpay_client.payment_link.create(data=payload)
        
        logger.info(f"Payment link created: {response.get('id')}")
        
        return response.get("short_url", response.get("url", ""))
    
    except Exception as e:
        logger.error(f"Failed to create payment link: {e}")
        raise


async def verify_payment(razorpay_order_id: str) -> bool:
    """Check if Razorpay payment is completed."""
    if not RAZORPAY_AVAILABLE or not razorpay_client:
        logger.warning("Razorpay not available, assuming payment verified")
        return True
    
    try:
        # Razorpay sends payment_id in webhook, which we verify against order_id
        # In webhook handler, we receive payment details
        
        # This function verifies a specific payment
        order = razorpay_client.order.fetch(razorpay_order_id)
        
        if order.get("status") == "paid":
            logger.info(f"Payment verified for order {razorpay_order_id}")
            return True
        
        logger.warning(f"Payment not yet completed for order {razorpay_order_id}")
        return False
    
    except Exception as e:
        logger.error(f"Failed to verify payment: {e}")
        return False


async def initiate_refund(razorpay_order_id: str, amount: float) -> bool:
    """Initiate refund for cancelled reservation advance."""
    if not RAZORPAY_AVAILABLE or not razorpay_client:
        logger.warning("Razorpay not available, refund not processed")
        return False
    
    try:
        amount_paise = int(amount * 100)
        
        # Get payment details first
        order = razorpay_client.order.fetch(razorpay_order_id)
        payments = razorpay_client.order.payments(razorpay_order_id)
        
        if not payments.get("items"):
            logger.warning(f"No payments found for order {razorpay_order_id}")
            return False
        
        payment_id = payments["items"][0]["id"]
        
        # Create refund
        refund_data = {
            "amount": amount_paise,
            "notes": {
                "order_id": razorpay_order_id,
                "reason": "Reservation cancelled",
            },
        }
        
        refund_response = razorpay_client.payment.refund(payment_id, data=refund_data)
        
        logger.info(f"Refund initiated: {refund_response.get('id')}")
        return refund_response.get("status") == "processed" or refund_response.get("status") == "initiated"
    
    except Exception as e:
        logger.error(f"Failed to initiate refund: {e}")
        return False


async def verify_webhook_signature(body: str, signature: str) -> bool:
    """Verify Razorpay webhook signature for security."""
    if not RAZORPAY_AVAILABLE or not razorpay_client or not settings.razorpay_key_secret:
        if settings.environment == "production":
            logger.error("Razorpay webhook received but Razorpay is not configured in production")
            return False
        logger.warning("Razorpay not available, skipping webhook signature verification")
        return True
    
    try:
        return razorpay_client.utility.verify_webhook_signature(
            body=body,
            signature=signature,
            secret=settings.razorpay_key_secret,
        )
    except Exception as e:
        logger.error(f"Webhook signature verification failed: {e}")
        return False
