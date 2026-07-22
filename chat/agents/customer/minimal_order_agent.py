"""
Minimal-message WhatsApp agent for psl, food_products, and retail.

The bot is an entry point only: one webcart-link message per inbound turn
(plus REPEAT → payment link). Browsing and customization happen on webcart.
"""

from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime
from typing import Any
from uuid import uuid4

from agents.customer.minimal_message_templates import (
    build_repeat_confirm_body,
    build_repeat_unavailable_message,
    build_short_redirect_message,
    build_welcome_message,
)
from agents.customer.booking_helpers import touch_session_activity
from tools.booking_mechanisms import (
    _build_web_menu_url,
    _normalize_phone_digits,
    _slugify_subdomain,
)
from tools.db_tools import (
    create_booking,
    create_customer,
    create_menu_link_token,
    create_walk_in_token_direct,
    get_active_walk_in_token,
    get_customer,
    get_last_paid_booking_for_customer,
    get_next_token_number,
    get_restaurant_by_id,
)
from tools.prepay_fulfillment import build_prepay_payload, persist_prepay_payload
from tools.payment_tools import ensure_prepay_payment_link, checkout_gateway_label
from tools.whatsapp_tools import send_whatsapp_cta_url, send_whatsapp_message

logger = logging.getLogger(__name__)

_REPEAT_RE = re.compile(r"\b(REPEAT|REORDER|SAME\s*ORDER|LAST\s*ORDER)\b", re.IGNORECASE)
_GREETING_RE = re.compile(
    r"^(hi|hello|hey|hola|namaste|start|order|menu|shop|browse)\b",
    re.IGNORECASE,
)


def is_repeat_keyword(message: str) -> bool:
    return bool(_REPEAT_RE.search((message or "").strip()))


def _is_fresh_contact(message: str, session_state: dict[str, Any]) -> bool:
    """True when we should send the full webcart welcome (not a short redirect)."""
    body = (message or "").strip()
    if not body:
        return True
    if is_repeat_keyword(body):
        return False
    if _GREETING_RE.match(body):
        return True
    step = str(session_state.get("minimal_step") or "")
    if step in ("", "welcome"):
        return True
    return False


async def _ensure_customer(
    restaurant_id: str,
    phone: str,
    profile_name: str,
) -> tuple[dict[str, Any], bool]:
    """Return (customer, is_new_customer)."""
    phone_candidates = _phone_variants(phone)
    for ph in phone_candidates:
        customer = await get_customer(restaurant_id, ph)
        if customer:
            return customer, False
    canonical = phone_candidates[0] if phone_candidates else phone
    name = (profile_name or "").strip() or "Guest"
    created = await create_customer(
        restaurant_id,
        canonical,
        name,
        profile_name=name,
    )
    return created, True


def _phone_variants(phone: str) -> list[str]:
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    candidates = [p for p in [phone, digits] if p and p.strip()]
    if len(digits) == 10:
        candidates.append(f"91{digits}")
    if len(digits) == 12 and digits.startswith("91"):
        candidates.append(digits[2:])
    return list(dict.fromkeys(candidates))


async def _mint_webcart_url(
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
) -> str | None:
    """Reuse restaurant web-menu token pattern — opaque session_token + menu_tokens row."""
    restaurant = await get_restaurant_by_id(restaurant_id)
    slug = _slugify_subdomain((restaurant or {}).get("name") or "")
    phone_digits = _normalize_phone_digits(customer_phone)

    token_id = (
        session_state.get("menu_session_token")
        or session_state.get("token_number")
        or session_state.get("display_token")
    )
    token_id_is_real = bool(token_id)
    if not token_id:
        walk = await get_active_walk_in_token(restaurant_id, customer_phone)
        if walk and walk.get("id"):
            token_id = str(walk.get("id"))
            token_id_is_real = True

    if not token_id:
        restaurant_lob = str((restaurant or {}).get("lob_type") or "").strip().lower()
        shipped = restaurant_lob in ("food_products", "retail", "psl", "b2b")
        created_id = await create_walk_in_token_direct(
            restaurant_id=restaurant_id,
            name=session_state.get("customer_name") or "WhatsApp Guest",
            phone=customer_phone,
            token_type="delivery" if shipped else "takeaway",
            pax=1,
            meta={"source": "minimal_webcart_link", "service_type": "delivery" if shipped else "takeaway"},
        )
        if created_id:
            token_id = created_id
            token_id_is_real = True
        else:
            token_id = uuid4().hex
            token_id_is_real = False

    url_token = session_state.get("menu_url_session_token")
    if not url_token:
        url_token = secrets.token_urlsafe(16)
        session_state["menu_url_session_token"] = url_token

    walk_token_id = str(token_id) if token_id_is_real else None
    await create_menu_link_token(
        restaurant_id=restaurant_id,
        customer_phone=phone_digits or customer_phone,
        session_token=url_token,
        walk_in_token_id=walk_token_id,
        expires_in_hours=24,
    )
    if token_id_is_real:
        session_state["menu_session_token"] = str(token_id)

    if not phone_digits:
        return None
    return _build_web_menu_url(slug, url_token, phone_digits)


async def send_minimal_webcart_link(
    *,
    lob_type: str,
    customer_phone: str,
    restaurant_id: str,
    session_state: dict[str, Any],
    store_name: str,
    customer_name: str,
    is_returning: bool,
    can_repeat: bool,
) -> bool:
    url = await _mint_webcart_url(customer_phone, restaurant_id, session_state)
    if not url:
        await send_whatsapp_message(
            customer_phone,
            "Sorry, we couldn't open the menu right now. Please try again in a moment. 🙏",
            restaurant_id,
        )
        return False

    timezone = (session_state.get("_restaurant_timezone") or "Asia/Kolkata")
    body_text, header_text, button_text = build_welcome_message(
        lob_type=lob_type,
        store_name=store_name,
        customer_name=customer_name,
        is_returning=is_returning,
        can_repeat=can_repeat,
        timezone=timezone,
    )

    sent = await send_whatsapp_cta_url(
        customer_phone,
        restaurant_id,
        body_text=body_text,
        button_text=button_text,
        url=url,
        header_text=header_text,
        footer_text="Secure checkout on our online menu",
    )
    if not sent:
        fallback = f"{body_text}\n\n👉 {button_text}\n{url}"
        sent = await send_whatsapp_message(customer_phone, fallback, restaurant_id)

    if sent:
        session_state["minimal_step"] = "awaiting_webcart"
        session_state["booking_mechanism"] = "web_cart"
        session_state["booking_mechanism_order_source"] = "web_cart"
        session_state["service_type"] = "takeaway"
        session_state["lob_type"] = lob_type
        logger.info("[minimal-order] webcart link sent to %s (%s)", customer_phone, lob_type)
    return sent


def _cart_lines_from_payload(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize prepay cart_snapshot into webcart-style item rows."""
    cart = payload.get("cart_snapshot") or {}
    lines: list[dict[str, Any]] = []
    if isinstance(cart, dict):
        for item_id, row in cart.items():
            if not isinstance(row, dict):
                continue
            qty = int(row.get("qty") or 0)
            if qty <= 0:
                continue
            name = str(row.get("title") or row.get("name") or "Item").strip()
            price = float(row.get("unit_price") or row.get("price") or 0)
            lines.append({
                "id": str(item_id),
                "name": name,
                "qty": qty,
                "price": price,
            })
    return lines


async def _handle_repeat_order(
    *,
    restaurant: dict,
    phone: str,
    session_state: dict[str, Any],
    customer: dict[str, Any],
) -> None:
    restaurant_id = str(restaurant["id"])
    store_name = (restaurant.get("name") or "our store").strip()
    customer_id = str(customer.get("id") or "")
    customer_name = str(customer.get("name") or "Guest").strip() or "Guest"

    if not customer_id:
        await send_whatsapp_message(
            phone,
            build_repeat_unavailable_message(store_name),
            restaurant_id,
        )
        return

    last = await get_last_paid_booking_for_customer(restaurant_id, customer_id)
    if not last:
        await send_whatsapp_message(
            phone,
            build_repeat_unavailable_message(store_name),
            restaurant_id,
        )
        return

    payload = last.get("payload") or {}
    items = _cart_lines_from_payload(payload)
    if not items:
        await send_whatsapp_message(
            phone,
            build_repeat_unavailable_message(store_name),
            restaurant_id,
        )
        return

    service_type = str(last.get("service_type") or payload.get("service_type") or "takeaway")
    if service_type not in ("takeaway", "delivery", "dine_in"):
        service_type = "takeaway"

    total = float(payload.get("totals", {}).get("total") or payload.get("order_total") or 0)
    if total < 1:
        total = sum(float(r["price"]) * int(r["qty"]) for r in items)

    token_number = await get_next_token_number(restaurant_id)
    booking = await create_booking(
        restaurant_id,
        customer_id,
        service_type,
        token_number=token_number,
    )
    booking_id = str(booking.get("id") or "")
    if not booking_id:
        await send_whatsapp_message(
            phone,
            "Sorry, we couldn't start your repeat order. Please use the menu link instead. 🙏",
            restaurant_id,
        )
        return

    cart_snapshot = {}
    order_text_lines = []
    for row in items:
        cart_snapshot[row["id"]] = {
            "title": row["name"],
            "name": row["name"],
            "qty": row["qty"],
            "unit_price": row["price"],
        }
        order_text_lines.append(f"{row['qty']}x {row['name']}")
    order_text_display = ", ".join(order_text_lines)

    pay_session: dict[str, Any] = {
        "payment_mode": "prepay",
        "service_type": service_type,
        "order_total": total,
        "lob_type": session_state.get("lob_type"),
    }
    payment_link = await ensure_prepay_payment_link(
        booking_id,
        total,
        customer_name,
        f"Repeat {service_type.replace('_', ' ')} order",
        customer_phone=phone,
        session_state=pay_session,
    )
    if not payment_link:
        await send_whatsapp_message(
            phone,
            "Sorry, payment isn't available right now. Please try the menu link instead. 🙏",
            restaurant_id,
        )
        return

    prepay_payload = build_prepay_payload(
        service_type=service_type,
        session_state=pay_session,
        restaurant_id=restaurant_id,
        customer_id=customer_id,
        customer_name=customer_name,
        customer_phone=phone,
        booking_id=booking_id,
        token=str(token_number),
        total=total,
        booking_time=datetime.utcnow().isoformat(),
        order_text_display=order_text_display,
        cart_snapshot=cart_snapshot,
        totals={"total": total},
    )
    await persist_prepay_payload(booking_id, prepay_payload)
    session_state.update(pay_session)
    session_state["minimal_step"] = "awaiting_repeat_payment"
    session_state["last_order_summary"] = order_text_display

    preview_lines = [f"- {r['qty']}x {r['name']}" for r in items[:6]]
    if len(items) > 6:
        preview_lines.append(f"- +{len(items) - 6} more item(s)")

    gateway_label = checkout_gateway_label(pay_session.get("payment_gateway") or "phonepe")
    body_text = build_repeat_confirm_body(
        order_ref=booking_id[-8:],
        token_label=str(token_number),
        total=total,
        preview_lines=preview_lines,
        gateway_label=gateway_label,
    )

    sent = await send_whatsapp_cta_url(
        phone,
        restaurant_id,
        body_text=body_text,
        button_text="Confirm & Pay",
        url=str(payment_link),
        header_text="Repeat Your Order",
        footer_text=f"Secure payment powered by {gateway_label}",
    )
    if not sent:
        fallback = f"{body_text}\n\nConfirm & Pay:\n{payment_link}"
        await send_whatsapp_message(phone, fallback, restaurant_id)

    logger.info("[minimal-order] REPEAT payment link sent to %s booking=%s", phone, booking_id)


async def handle_minimal_order_flow(
    *,
    restaurant: dict,
    phone: str,
    message_body: str,
    session_state: dict[str, Any],
    profile_name: str = "",
) -> None:
    """
    Single-message webcart entry for psl / food_products / retail tenants.
    Called under customer_lock from main.py.
    """
    restaurant_id = str(restaurant["id"])
    lob_type = str(restaurant.get("lob_type") or "retail").strip().lower()
    if lob_type not in ("psl", "food_products", "retail"):
        lob_type = "retail"

    session_state["lob_type"] = lob_type
    session_state.setdefault("_restaurant_timezone", restaurant.get("timezone") or "Asia/Kolkata")

    customer, is_new = await _ensure_customer(restaurant_id, phone, profile_name)
    session_state["customer_id"] = str(customer.get("id") or "")
    session_state["customer_name"] = str(customer.get("name") or profile_name or "Guest")
    is_returning = not is_new
    session_state["is_new_customer"] = is_new
    session_state["is_returning_customer"] = is_returning

    can_repeat = False
    if session_state.get("customer_id"):
        last = await get_last_paid_booking_for_customer(
            restaurant_id,
            str(session_state["customer_id"]),
        )
        can_repeat = bool(last and _cart_lines_from_payload(last.get("payload") or {}))

    touch_session_activity(session_state)

    if is_repeat_keyword(message_body):
        await _handle_repeat_order(
            restaurant=restaurant,
            phone=phone,
            session_state=session_state,
            customer=customer,
        )
        return

    store_name = (restaurant.get("name") or "our store").strip()

    if _is_fresh_contact(message_body, session_state):
        await send_minimal_webcart_link(
            lob_type=lob_type,
            customer_phone=phone,
            restaurant_id=restaurant_id,
            session_state=session_state,
            store_name=store_name,
            customer_name=session_state["customer_name"],
            is_returning=is_returning,
            can_repeat=can_repeat,
        )
        return

    await send_whatsapp_message(
        phone,
        build_short_redirect_message(can_repeat),
        restaurant_id,
    )
