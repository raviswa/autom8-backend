"""LOB-aware customer WhatsApp copy (restaurant vs shipped catalog stores)."""

from __future__ import annotations

from typing import Any

SHIPPED_LOBS = frozenset({"food_products", "retail", "psl", "b2b"})


def normalize_lob(lob_type: Any) -> str:
    return str(lob_type or "restaurant").strip().lower() or "restaurant"


def is_shipped_lob(lob_type: Any) -> bool:
    return normalize_lob(lob_type) in SHIPPED_LOBS


def resolve_lob_from_payload(payload: dict[str, Any] | None) -> str:
    payload = payload or {}
    hints = payload.get("session_hints") or {}
    return normalize_lob(
        hints.get("lob_type")
        or payload.get("lob_type")
        or "restaurant"
    )


def prepay_pending_footer(lob_type: Any = None, lang: str | None = None) -> str:
    from locales.customer import reply

    if is_shipped_lob(lob_type):
        return reply(lang, "prepay_footer_shipped")
    return reply(lang, "prepay_footer_kitchen")


def order_confirmed_line(
    *,
    lob_type: Any = None,
    service_type: str,
    dispatched: bool = True,
    deferred: bool = False,
    lang: str | None = None,
) -> str:
    """Customer-facing paid-order confirmation line (no staff/KDS jargon).

    Localized via chat locales.
    """
    from locales.customer import reply

    service = str(service_type or "order").strip().lower()
    shipped = is_shipped_lob(lob_type)

    if service in ("delivery", "scheduled_delivery"):
        label = "delivery"
    elif service in ("takeaway", "scheduled_takeaway"):
        label = "takeaway"
    elif service in ("dine_in", "dinein"):
        label = "dine_in"
    else:
        label = "order"

    if deferred:
        key = {
            "delivery": "confirmed_delivery_deferred",
            "takeaway": "confirmed_takeaway_deferred",
        }.get(label, "confirmed_generic_deferred")
        return reply(lang, key)

    if shipped:
        if dispatched:
            key = {
                "delivery": "confirmed_delivery_dispatch",
                "takeaway": "confirmed_takeaway_pickup_prep",
            }.get(label, "confirmed_generic_prep")
            return reply(lang, key)
        if label == "delivery":
            return reply(lang, "confirmed_help_delivery")
        return reply(lang, "confirmed_help_generic")

    # Restaurant LOB — keep kitchen wording
    if dispatched:
        key = {
            "delivery": "confirmed_kitchen_delivery",
            "takeaway": "confirmed_kitchen_takeaway",
            "dine_in": "confirmed_kitchen_dinein",
        }.get(label, "confirmed_kitchen_generic")
        return reply(lang, key)
    # Soft fallback — no KDS / kitchen-display jargon for customers
    if label == "delivery":
        return reply(lang, "confirmed_help_delivery")
    return reply(lang, "confirmed_help_generic")
