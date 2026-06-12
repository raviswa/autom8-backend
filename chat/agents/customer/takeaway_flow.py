"""
agents/customer/takeaway_flow.py
──────────────────────────────────
Takeaway booking flow extracted from booking_agent.py.

Fix 38 — awaiting_order: booking_step now transitions to visit_complete
          (was awaiting_payment). On the customer's next message (even the
          following day) their session is treated as a fresh visit rather
          than showing the stale "Place New Order" prompt. Feedback queue
          call added to match dine-in behaviour. Return status updated.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, Any

import aiohttp

from tools.db_tools import get_next_token_number, create_booking, update_booking_status
from tools.payment_tools import create_payment_link
from tools.whatsapp_tools import send_whatsapp_message
from tools.cart_tools import cart_to_order_text, cart_total, clear_cart
from tools.booking_mechanisms import (
    RECEIPT_AVAILABLE,
    _generate_receipt,
    _ReceiptData,
    _LineItem,
    KDS_SECRET,
    get_http,
    notify_kds,
    sync_token_to_portal,
    fetch_restaurant_info,
    upload_and_send_receipt,
    receipt_qr_url,
    AUTOM8_KDS_URL,
)
from agents.customer.booking_helpers import (
    MANAGER_PORTAL_URL,
    _HOME_HINT,
    now_display,
    is_placeholder_payment_link,
    send_catalog_with_fallback,
)
from agents.customer.conversation_helpers import safe_build_order_suggestion

logger = logging.getLogger(__name__)


async def handle_takeaway_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    if booking_step == "awaiting_order":
        order_text = message.strip()
        if order_text.upper() == "MENU":
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart = session_state.get("cart", {})

        if not cart and len(order_text) < 3:
            logger.info(f"[takeaway] empty cart + short message '{order_text}' — re-sending catalog")
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        try:
            cart_snapshot = dict(cart)
            total         = cart_total(cart) if cart else 0.0
            session_state["order_total"] = total

            token, portal_token_id, suggestion = await asyncio.gather(
                get_next_token_number(restaurant_id),
                sync_token_to_portal(
                    customer_name=customer_name, customer_phone=customer_phone,
                    token_type="takeaway", pax=1, restaurant_id=restaurant_id,
                ),
                safe_build_order_suggestion(customer_id, restaurant_id),
            )
            booking_time  = now_display()
            session_state["token_number"] = token
            display_token = portal_token_id or token
            session_state["display_token"] = display_token

            # Manager walk-in alert
            try:
                await send_whatsapp_message(
                    manager_phone,
                    f"🛍️ *New Walk-in* — Token *{display_token}*\n"
                    f"👤 {customer_name}\n📦 Takeaway\n🕐 {booking_time}\n\n"
                    f"Open portal to manage:\n{MANAGER_PORTAL_URL}",
                    restaurant_id,
                )
            except Exception as _mw:
                logger.warning(f"[takeaway] manager walk-in notify failed (non-fatal): {_mw}")

            booking    = await create_booking(restaurant_id, customer_id, "takeaway", token_number=token)
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            try:
                payment_link = await create_payment_link(booking_id, total, customer_name, f"Takeaway {token}")
            except Exception as _pl:
                logger.warning(f"[payment] create_payment_link failed (non-fatal): {_pl}")
                payment_link = "placeholder"
            payment_line = ("💳 Payment can be made at the counter."
                            if is_placeholder_payment_link(payment_link)
                            else f"Pay here: {payment_link}")

            confirmation = (
                f"Your order has been placed! 🎉\n────────────────────\n"
                f"Token: {display_token}\nBooking Time: {booking_time}\n"
                f"Order: {order_text}\n────────────────────\n"
                f"Total: ₹{total:.0f}\n\n{payment_line}"
            )
            if suggestion:
                confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            # Manager order details
            try:
                await send_whatsapp_message(
                    manager_phone,
                    f"📋 Order Details — Takeaway\n────────────────────\n"
                    f"Token: {display_token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                    f"Booking Time: {booking_time}\nOrder: {order_text}\nTotal: ₹{total:.0f}\n"
                    f"────────────────────",
                    restaurant_id,
                )
            except Exception as _md:
                logger.warning(f"[takeaway] manager order details notify failed (non-fatal): {_md}")

            session_state["order_confirmed_summary"] = (
                f"Takeaway Token *{display_token}* — {order_text} (₹{total:.0f})"
            )
            _first_item = order_text.split(",")[0].strip()[:40]
            session_state["last_order_summary"]    = _first_item
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = session_state.get("visit_count", 0) + 1

            # Fix 38: transition to visit_complete so next-day "Hi" starts fresh
            session_state["booking_step"] = "visit_complete"
            clear_cart(session_state)

            await notify_kds(
                customer_name=customer_name, customer_phone=customer_phone,
                order_text=order_text, cart=cart_snapshot, table_number=None,
                token_number=display_token, service_type="takeaway",
                restaurant_id=restaurant_id,
            )

            # Fix 38: feedback queue — mirrors dine-in behaviour
            try:
                await get_http().post(
                    "https://api.autom8.works/api/feedback/queue",
                    json={
                        "restaurant_id":  restaurant_id,
                        "customer_phone": customer_phone,
                        "customer_name":  customer_name,
                        "token_number":   display_token,
                        "table_number":   None,
                    },
                    headers={"Authorization": f"Bearer {KDS_SECRET}"},
                    timeout=aiohttp.ClientTimeout(total=5),
                )
            except Exception as fb_err:
                logger.warning(f"[feedback-queue] Non-fatal: {fb_err}")

            if RECEIPT_AVAILABLE:
                try:
                    r_info = await fetch_restaurant_info(restaurant_id)
                    receipt_data = _ReceiptData(
                        restaurant_name=r_info.get("name", ""),
                        restaurant_address=r_info.get("address", ""),
                        restaurant_phone=r_info.get("phone", ""),
                        restaurant_gstin=r_info.get("gstin", ""),
                        restaurant_wa_number=r_info.get("whatsapp_number", ""),
                        restaurant_website=r_info.get("website", ""),
                        receipt_url=receipt_qr_url(display_token),
                        token_number=display_token,
                        service_type="takeaway",
                        customer_name=customer_name,
                        customer_phone=customer_phone,
                        items=_LineItem.from_cart(cart_snapshot),
                        gst_rate=5.0,
                        gst_inclusive=False,
                        payment_mode=session_state.get("payment_mode", "Cash"),
                    )
                    receipt_path = _generate_receipt(receipt_data)
                    logger.info(f"[receipt] Takeaway receipt saved: {receipt_path}")
                    asyncio.create_task(
                        upload_and_send_receipt(receipt_path, customer_phone, restaurant_id, display_token)
                    )
                    await update_booking_status(booking_id, "confirmed")
                    logger.info(f"[receipt] Booking {booking_id} marked confirmed")
                except Exception as _re:
                    import traceback as _tb
                    logger.warning(f"[receipt] Generation failed (non-fatal): {_re}\n{_tb.format_exc()}")

            return {"status": "visit_complete", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create takeaway booking: {e}")
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was an error processing your order. Please try again." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "error"}

    return {"status": "error"}
