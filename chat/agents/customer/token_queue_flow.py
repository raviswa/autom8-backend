"""Token / Queue flow — party size → portal token → handoff. No ordering."""

from __future__ import annotations

import logging
from typing import Any, Dict

from tools.whatsapp_tools import send_whatsapp_message
from tools.booking_mechanisms import sync_token_to_portal
from agents.customer.booking_helpers import (
    parse_party_size,
    mark_session_visit_complete,
)
from locales.customer import reply, session_lang

logger = logging.getLogger(__name__)


def _outlet_label(restaurant: Dict[str, Any] | None) -> str:
    if not restaurant:
        return "us"
    name = str(restaurant.get("display_name") or restaurant.get("name") or "").strip()
    city = str(restaurant.get("city") or "").strip()
    if name and city:
        return f"{name}, {city}"
    return name or "us"


async def handle_token_queue_flow(
    restaurant_id: str,
    customer_id: str,
    customer_name: str,
    customer_phone: str,
    manager_phone: str,
    message: str,
    session_state: Dict[str, Any],
    table_number: int | None = None,
) -> Dict[str, Any]:
    """
    Entry mirrors dine-in's party-size step, then stops after token assignment.
    Does not allocate tables, open a cart, or start payment/receipt.
    """
    booking_step = session_state.get("booking_step")
    lang = session_lang(session_state)

    # First entry from service selection — ask party size
    if booking_step != "awaiting_party_size":
        await send_whatsapp_message(
            customer_phone,
            reply(lang, "party_size_ask_queue"),
            restaurant_id,
        )
        session_state["booking_step"] = "awaiting_party_size"
        session_state["service_type"] = "token_management"
        session_state["last_service_type"] = "token_management"
        return {"status": "awaiting_party_size"}

    # ── awaiting_party_size ───────────────────────────────────────────────────
    try:
        party_size = parse_party_size(message)
    except Exception:
        await send_whatsapp_message(
            customer_phone,
            reply(lang, "party_size_invalid"),
            restaurant_id,
        )
        return {"status": "awaiting_party_size"}

    session_state["party_size"] = party_size

    portal_token_id = await sync_token_to_portal(
        customer_name=customer_name,
        customer_phone=customer_phone,
        token_type="queue",
        pax=party_size,
        restaurant_id=restaurant_id,
    )

    outlet = "us"
    try:
        from tools.db_tools import get_restaurant_by_id
        restaurant = await get_restaurant_by_id(restaurant_id)
        outlet = _outlet_label(restaurant)
    except Exception as err:
        logger.warning("[token-queue] restaurant lookup failed: %s", err)

    if not portal_token_id:
        logger.error(
            "[token-queue] Portal token sync failed for %s (restaurant=%s)",
            customer_phone,
            restaurant_id,
        )
        await send_whatsapp_message(
            customer_phone,
            reply(lang, "queue_joined_noted", outlet=outlet, n=party_size),
            restaurant_id,
        )
        if manager_phone:
            await send_whatsapp_message(
                manager_phone,
                f"⚠️ *Queue token sync failed — add manually*\n"
                f"👤 {customer_name} · {party_size} "
                f"{'guest' if party_size == 1 else 'guests'}\n"
                f"📱 {customer_phone}",
                restaurant_id,
            )
        mark_session_visit_complete(session_state)
        return {"status": "visit_complete"}

    display_token = portal_token_id
    try:
        from tools.db_tools import get_walk_in_token_by_id
        token_row = await get_walk_in_token_by_id(restaurant_id, portal_token_id)
        if token_row and token_row.get("id"):
            display_token = token_row["id"]
    except Exception as err:
        logger.warning("[token-queue] token lookup failed: %s", err)

    session_state["token_number"] = portal_token_id
    session_state["display_token"] = display_token

    await send_whatsapp_message(
        customer_phone,
        reply(
            lang,
            "queue_joined",
            outlet=outlet,
            token=display_token,
            n=party_size,
        ),
        restaurant_id,
    )

    # End the visit — no table assignment / cart / payment steps.
    mark_session_visit_complete(session_state)
    return {"status": "visit_complete"}
