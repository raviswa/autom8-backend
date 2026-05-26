"""
booking_mechanisms.py
─────────────────────────────────────────────────────────────────────────────
Unified booking mechanism with primary (WhatsApp Catalog) and fallback (Cart).

Strategy:
  - PRIMARY: send_whatsapp_catalog_message()
    Customer browses items with images/prices, adds to native basket, sends order
  
  - FALLBACK: send_category_list() → send_item_list() → send_quantity_buttons()
    Interactive list/buttons when catalog is unavailable
  
  - BRIDGE: parse_incoming_catalog_order() converts catalog 'order' type messages
    into cart state (session_state["cart"]) for unified downstream processing

Configuration:
  BOOKING_MECHANISM_CONFIG = {
    "primary": "catalog",          # First attempt
    "fallback": "cart",            # If catalog fails
    "timeout_seconds": 30,         # Fallback after timeout
    "log_mechanism": True,         # Track which path was used
  }
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from tools.catalog_tools import (
    send_whatsapp_catalog_message,
    parse_whatsapp_order,
)
from tools.cart_tools import (
    send_category_list,
    plain_text_menu,
)
from tools.whatsapp_tools import send_whatsapp_message

logger = logging.getLogger(__name__)

# ── Booking mechanism configuration ────────────────────────────────────────

BOOKING_MECHANISM_CONFIG = {
    "primary": "catalog",          # WhatsApp Catalog (native shopping)
    "fallback": "cart",            # Interactive cart (fallback)
    "timeout_seconds": 30,         # Fallback after timeout (future use)
    "log_mechanism": True,         # Track mechanism usage
}


# ── Mechanism types ──────────────────────────────────────────────────────────

MechanismType = Literal["catalog", "cart", "none"]


# ─────────────────────────────────────────────────────────────────────────────
# PRIMARY: WHATSAPP CATALOG BOOKING
# ─────────────────────────────────────────────────────────────────────────────

async def send_catalog_booking(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> bool:
    """
    Send WhatsApp Catalog as PRIMARY booking mechanism.
    
    Returns True if successful, False on failure (triggers fallback).
    """
    try:
        success = await send_whatsapp_catalog_message(customer_phone, restaurant_id)
        if success:
            session_state["booking_mechanism"] = "catalog"
            logger.info(f"[BOOKING] {customer_phone} → PRIMARY: Catalog sent")
            return True
        else:
            logger.warning(f"[BOOKING] {customer_phone} → Catalog send failed")
            return False
    except Exception as e:
        logger.error(f"[BOOKING] {customer_phone} → Catalog error: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────────
# FALLBACK: INTERACTIVE CART BOOKING
# ─────────────────────────────────────────────────────────────────────────────

async def send_cart_booking(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> bool:
    """
    Send interactive cart as FALLBACK booking mechanism.
    
    Returns True if successful, False if both mechanisms fail.
    """
    try:
        success = await send_category_list(customer_phone, session_state)
        if success:
            session_state["booking_mechanism"] = "cart"
            logger.info(f"[BOOKING] {customer_phone} → FALLBACK: Cart (interactive list) sent")
            return True
        else:
            logger.warning(f"[BOOKING] {customer_phone} → Cart interactive list failed")
            return False
    except Exception as e:
        logger.error(f"[BOOKING] {customer_phone} → Cart error: {e}")
        return False


async def send_cart_fallback_text(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> bool:
    """
    Last-resort plain-text menu when both catalog and interactive fail.
    """
    try:
        menu_text = plain_text_menu()
        await send_whatsapp_message(customer_phone, menu_text, restaurant_id)
        session_state["booking_mechanism"] = "cart_text"
        logger.info(f"[BOOKING] {customer_phone} → FALLBACK: Cart (plain text) sent")
        session_state["booking_step"] = "awaiting_numbered_order"
        return True
    except Exception as e:
        logger.error(f"[BOOKING] {customer_phone} → Plain-text menu error: {e}")
        return False


# ─────────────────────────────────────────────────────────────────────────────
# UNIFIED BOOKING MECHANISM (Primary + Fallback)
# ─────────────────────────────────────────────────────────────────────────────

async def send_unified_booking_menu(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> MechanismType:
    """
    Send booking menu with primary (catalog) → fallback (cart) strategy.
    
    1. Tries WhatsApp Catalog (native, rich experience)
    2. Falls back to interactive cart (category list)
    3. Falls back to plain-text menu
    
    Returns which mechanism was successfully used: "catalog", "cart", "cart_text", or "none".
    """
    
    # Attempt 1: Primary — WhatsApp Catalog
    if await send_catalog_booking(customer_phone, restaurant_id, session_state):
        return "catalog"
    
    # Attempt 2: Fallback — Interactive Cart
    if await send_cart_booking(customer_phone, restaurant_id, session_state):
        return "cart"
    
    # Attempt 3: Last resort — Plain text menu
    if await send_cart_fallback_text(customer_phone, restaurant_id, session_state):
        return "cart_text"
    
    # All mechanisms failed
    logger.error(f"[BOOKING] {customer_phone} → ALL mechanisms failed")
    try:
        await send_whatsapp_message(
            customer_phone,
            "Our menu is loading — please ask our staff or try again in a moment!",
            restaurant_id,
        )
    except Exception as e:
        logger.error(f"[BOOKING] Error sending fallback message: {e}")
    
    return "none"


# ─────────────────────────────────────────────────────────────────────────────
# BRIDGE: CONVERT INCOMING CATALOG ORDERS TO CART STATE
# ─────────────────────────────────────────────────────────────────────────────

def bridge_catalog_order_to_cart(
    webhook_message: dict[str, Any],
    session_state: dict[str, Any],
) -> bool:
    """
    Parse incoming WhatsApp catalog 'order' message and populate session cart.
    
    Converts:
      webhook_message["order"]["product_items"] → session_state["cart"]
    
    This allows downstream booking logic to handle both catalog and cart
    orders identically (both result in session_state["cart"] being populated).
    
    Returns True if successfully parsed and populated, False otherwise.
    """
    
    parsed_order = parse_whatsapp_order(webhook_message)
    if parsed_order is None:
        logger.debug("Message is not a catalog order")
        return False
    
    items = parsed_order.get("items", [])
    total = parsed_order.get("total", 0.0)
    
    if not items:
        logger.warning("Catalog order has no items")
        return False
    
    # Populate session cart from catalog order
    cart = {}
    for item_line in items:
        item_id = item_line["id"]
        cart[item_id] = {
            "title": item_line["title"],
            "qty": item_line["qty"],
            "unit_price": item_line["unit_price"],
        }
    
    session_state["cart"] = cart
    session_state["booking_mechanism_order_source"] = "catalog"
    session_state["booking_step"] = "confirming_order"
    
    logger.info(f"Catalog order bridged to cart: {len(items)} items, total ₹{total:.0f}")
    return True


# ─────────────────────────────────────────────────────────────────────────────
# DETECTION: Is this message a catalog order?
# ─────────────────────────────────────────────────────────────────────────────

def is_catalog_order(webhook_message: dict[str, Any]) -> bool:
    """
    Check if the incoming message is a WhatsApp catalog order ('order' type).
    """
    return webhook_message.get("type") == "order"


# ─────────────────────────────────────────────────────────────────────────────
# LOGGING & ANALYTICS
# ─────────────────────────────────────────────────────────────────────────────

def log_booking_mechanism_used(
    customer_phone: str,
    mechanism: MechanismType,
    session_state: dict[str, Any],
) -> None:
    """
    Log which booking mechanism was used for analytics/debugging.
    """
    if not BOOKING_MECHANISM_CONFIG.get("log_mechanism"):
        return
    
    booking_step = session_state.get("booking_step", "unknown")
    service_type = session_state.get("service_type", "unknown")
    
    logger.info(
        f"[BOOKING_ANALYTICS] {customer_phone} | "
        f"mechanism={mechanism} | service={service_type} | step={booking_step}"
    )
