"""
agents/customer/delivery_flow.py
──────────────────────────────────
Delivery booking flow extracted from booking_agent.py.

Fix 38 — awaiting_order: booking_step now transitions to visit_complete
          (was awaiting_payment). Same reasoning as takeaway_flow.py.
          Feedback queue call added. Return status updated.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Dict, Any

import aiohttp

from tools.db_tools import get_next_token_number, create_booking, update_booking_status
from tools.payment_tools import create_payment_link
from tools.whatsapp_tools import send_whatsapp_message, send_location_request
from tools.cart_tools import cart_to_order_text, cart_total, clear_cart
from tools.order_pricing import compute_order_totals, format_order_total_lines, DEFAULT_DELIVERY_CHARGE
from tools.order_timing import ready_time_note_from_session
from tools.booking_mechanisms import (
    RECEIPT_AVAILABLE,
    _generate_receipt,
    _ReceiptData,
    _LineItem,
    KDS_SECRET,
    get_http,
    notify_kds,
    fetch_restaurant_info,
    upload_and_send_receipt,
    receipt_qr_url,
    cache_restaurant_pricing,
)
from agents.customer.booking_helpers import (
    _HOME_HINT,
    now_display,
    is_placeholder_payment_link,
    send_catalog_with_fallback,
    strip_order_quantity,
    gate_ordering_service,
)
from agents.customer.conversation_helpers import safe_build_order_suggestion

logger = logging.getLogger(__name__)

DELIVERY_CHARGE = 40.00


async def handle_delivery_flow(
    restaurant_id: str, customer_id: str, customer_name: str,
    customer_phone: str, manager_phone: str, message: str,
    session_state: Dict[str, Any],
) -> Dict[str, Any]:

    booking_step = session_state.get("booking_step")

    # ── awaiting_address ──────────────────────────────────────────────────────
    if booking_step == "awaiting_address":
        raw = message.strip()
        if raw.startswith("LOCATION:"):
            try:
                coords_part, label = raw[len("LOCATION:"):].split("|", 1)
                lat, lng = coords_part.split(",", 1)
                maps_link = f"https://maps.google.com/?q={lat.strip()},{lng.strip()}"
                delivery_address = f"{label.strip()} ({maps_link})"
            except Exception:
                delivery_address = raw
        else:
            delivery_address = raw

        session_state["delivery_address"] = delivery_address
        await cache_restaurant_pricing(session_state, restaurant_id)
        from tools.kitchen_hours import is_kitchen_open
        if not is_kitchen_open():
            if await gate_ordering_service(
                customer_phone, restaurant_id, session_state, "delivery",
            ):
                return {"status": "awaiting_service_selection"}

        await send_whatsapp_message(
            customer_phone,
            "Thank you! Browse today's menu below and add items to your basket 🛒",
            restaurant_id,
        )
        clear_cart(session_state)
        session_state["booking_step"] = "awaiting_order"
        await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
        return {"status": session_state["booking_step"]}

    # ── awaiting_order ────────────────────────────────────────────────────────
    elif booking_step == "awaiting_order":
        order_text = message.strip()
        if order_text.upper() == "MENU":
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        cart = session_state.get("cart", {})

        if not cart and len(order_text) < 3:
            logger.info(f"[delivery] empty cart + short message '{order_text}' — re-sending catalog")
            await send_catalog_with_fallback(customer_phone, restaurant_id, session_state)
            return {"status": session_state.get("booking_step", "awaiting_order")}

        try:
            await cache_restaurant_pricing(session_state, restaurant_id)
            cart_snapshot = dict(cart)
            parcel_rate   = float(session_state.get("parcel_charge_per_item") or 0)
            totals        = compute_order_totals(
                cart, "delivery",
                parcel_per_item=parcel_rate,
                delivery_charge=DELIVERY_CHARGE,
            )
            total         = totals["grand_total"]
            items_total   = totals["items_subtotal"]
            session_state["order_total"] = total
            session_state["order_totals"] = totals

            token, suggestion = await asyncio.gather(
                get_next_token_number(restaurant_id),
                safe_build_order_suggestion(customer_id, restaurant_id),
            )
            booking_time  = now_display()
            session_state["token_number"] = token

            booking = await create_booking(
                restaurant_id, customer_id, "delivery",
                delivery_address=session_state.get("delivery_address"),
                token_number=token,
            )
            booking_id = booking["id"]
            session_state["booking_id"] = booking_id

            try:
                payment_link = await create_payment_link(
                    booking_id, total, customer_name, f"Delivery {token}"
                )
            except Exception as _pl:
                logger.warning(f"[payment] create_payment_link failed (non-fatal): {_pl}")
                payment_link = "placeholder"
            payment_line = ("💳 Payment can be made on delivery."
                            if is_placeholder_payment_link(payment_link)
                            else f"Pay here: {payment_link}")

            confirmation = (
                f"Your order has been placed! 🎉\n────────────────────\n"
                f"Token: {token}\nBooking Time: {booking_time}\nOrder: {order_text}\n"
                f"────────────────────\n"
                f"{format_order_total_lines(totals)}\n\n{payment_line}"
            )
            timing_note = ready_time_note_from_session(session_state, "delivery")
            if timing_note:
                confirmation += f"\n\n{timing_note}"
            if suggestion:
                confirmation += f"\n\n{suggestion}"
            await send_whatsapp_message(customer_phone, confirmation, restaurant_id)

            try:
                await send_whatsapp_message(
                    manager_phone,
                    f"🛵 New Delivery Order\n────────────────────\n"
                    f"Token: {token}\nCustomer: {customer_name}\nPhone: {customer_phone}\n"
                    f"Address: {session_state.get('delivery_address')}\nBooking Time: {booking_time}\n"
                    f"Order: {order_text}\nTotal: ₹{total:.0f} (incl. ₹{DELIVERY_CHARGE:.0f} delivery)\n"
                    f"────────────────────",
                    restaurant_id,
                )
            except Exception as _md:
                logger.warning(f"[delivery] manager order notify failed (non-fatal): {_md}")

            session_state["order_confirmed_summary"] = (
                f"Delivery Token *{token}* — {order_text} "
                f"to {session_state.get('delivery_address', '')[:40]} (₹{total:.0f})"
            )
            _first_item = strip_order_quantity(order_text.split(",")[0].strip())[:40]
            session_state["last_order_summary"]    = _first_item
            session_state["is_returning_customer"] = True
            session_state["visit_count"]           = session_state.get("visit_count", 0) + 1

            # Fix 38: transition to visit_complete so next-day "Hi" starts fresh
            session_state["booking_step"] = "visit_complete"
            clear_cart(session_state)

            await notify_kds(
                customer_name=customer_name, customer_phone=customer_phone,
                order_text=order_text, cart=cart_snapshot, table_number=None,
                token_number=token, service_type="delivery",
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
                        "token_number":   token,
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
                        receipt_url=receipt_qr_url(token),
                        token_number=token,
                        service_type="delivery",
                        customer_name=customer_name,
                        customer_phone=customer_phone,
                        delivery_address=session_state.get("delivery_address", ""),
                        items=_LineItem.from_cart(cart_snapshot),
                        gst_rate=5.0,
                        gst_inclusive=False,
                        delivery_charge=totals.get("delivery_charge", DELIVERY_CHARGE),
                        parcel_charge=totals.get("parcel_charge", 0),
                        payment_mode=session_state.get("payment_mode", "Cash"),
                    )
                    receipt_path = _generate_receipt(receipt_data)
                    logger.info(f"[receipt] Delivery receipt saved: {receipt_path}")
                    asyncio.create_task(
                        upload_and_send_receipt(receipt_path, customer_phone, restaurant_id, token)
                    )
                    await update_booking_status(booking_id, "confirmed")
                    logger.info(f"[receipt] Booking {booking_id} marked confirmed")
                except Exception as _re:
                    import traceback as _tb
                    logger.warning(f"[receipt] Generation failed (non-fatal): {_re}\n{_tb.format_exc()}")

            return {"status": "visit_complete", "booking_id": booking_id, "total": total}

        except Exception as e:
            logger.error(f"Failed to create delivery booking: {e}")
            await send_whatsapp_message(
                customer_phone,
                "Sorry, there was an error processing your order. Please try again." + _HOME_HINT,
                restaurant_id,
            )
            return {"status": "error"}

    return {"status": "error"}
