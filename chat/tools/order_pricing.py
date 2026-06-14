"""
Order pricing — parcel charges, delivery fee, GST (takeaway / delivery).
Parcel is per cart line quantity (qty × rate per item), added before GST.
"""

from __future__ import annotations

from typing import Any

from tools.cart_tools import cart_total

DEFAULT_GST_RATE = 5.0
DEFAULT_DELIVERY_CHARGE = 40.0


def parcel_charge_total(cart: dict[str, Any], rate_per_item: float) -> float:
    """Sum of qty × parcel rate for each cart line."""
    if not cart or not rate_per_item or rate_per_item <= 0:
        return 0.0
    return round(sum(line["qty"] * rate_per_item for line in cart.values()), 2)


def compute_order_totals(
    cart: dict[str, Any],
    service_type: str,
    *,
    parcel_per_item: float = 0,
    delivery_charge: float = DEFAULT_DELIVERY_CHARGE,
    gst_rate: float = DEFAULT_GST_RATE,
) -> dict[str, float]:
    """
    Items + parcel (+ delivery for delivery) → GST on combined pre-tax total → grand total.
    Dine-in: no parcel charge.
    """
    items_subtotal = round(cart_total(cart) if cart else 0.0, 2)
    st = (service_type or "").replace("-", "_").lower()

    parcel = 0.0
    if st in ("takeaway", "delivery"):
        parcel = parcel_charge_total(cart, parcel_per_item)

    deli = round(delivery_charge, 2) if st == "delivery" else 0.0
    pre_gst = round(items_subtotal + parcel + deli, 2)
    gst_amount = round(pre_gst * gst_rate / 100, 2)
    grand_total = round(pre_gst + gst_amount, 2)

    return {
        "items_subtotal": items_subtotal,
        "parcel_charge": parcel,
        "delivery_charge": deli,
        "pre_gst_total": pre_gst,
        "gst_amount": gst_amount,
        "gst_rate": gst_rate,
        "grand_total": grand_total,
    }


def format_order_total_lines(totals: dict[str, float], *, compact: bool = False) -> str:
    """Human-readable price breakdown for WhatsApp messages."""
    lines = [f"Items: ₹{totals['items_subtotal']:.0f}"]
    if totals.get("parcel_charge", 0) > 0:
        lines.append(f"Parcel/packaging: ₹{totals['parcel_charge']:.0f}")
    if totals.get("delivery_charge", 0) > 0:
        lines.append(f"Delivery charge: ₹{totals['delivery_charge']:.0f}")
    if not compact:
        lines.append(f"GST ({totals.get('gst_rate', DEFAULT_GST_RATE):.0f}%): ₹{totals['gst_amount']:.0f}")
    lines.append(f"*Total: ₹{totals['grand_total']:.0f}*")
    return "\n".join(lines)
