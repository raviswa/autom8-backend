"""Shared WhatsApp shipment notification — used by Shiprocket webhooks and manual AWB entry."""

from __future__ import annotations

import logging
from typing import Optional

from tools.whatsapp_tools import send_whatsapp_message

logger = logging.getLogger(__name__)


def _format_shipment_message(
    *,
    order_ref: str,
    courier_name: str,
    awb: str,
    status: str,
) -> str:
    lines = [
        f"📦 Shipment update for order *{order_ref}*",
        f"Status: *{status}*",
    ]
    if courier_name:
        lines.append(f"Courier: {courier_name}")
    if awb:
        lines.append(f"AWB / tracking: *{awb}*")
    lines.append("Reply if you need help with this delivery.")
    return "\n".join(lines)


async def notify_shipment_update(
    *,
    restaurant_id: str,
    customer_phone: str,
    order_ref: str,
    courier_name: str = "",
    awb: str = "",
    status: str = "Shipped",
) -> bool:
    """Send the single canonical WhatsApp shipment message for any fulfillment path."""
    phone = str(customer_phone or "").strip()
    ref = str(order_ref or "").strip()
    if not restaurant_id or not phone or not ref:
        logger.warning("[shipment_notify] missing restaurant_id, phone, or order_ref")
        return False

    body = _format_shipment_message(
        order_ref=ref,
        courier_name=str(courier_name or "").strip(),
        awb=str(awb or "").strip(),
        status=str(status or "Shipped").strip(),
    )
    ok = await send_whatsapp_message(phone, body, restaurant_id)
    if not ok:
        logger.warning("[shipment_notify] WhatsApp send failed for %s order %s", phone, ref)
    return bool(ok)
