"""Rule-based Munafe Supply WhatsApp agent (B2B — form ordering, no chat catalog)."""

from __future__ import annotations

import logging
import re
from typing import Any

from tools.supply_api import fetch_b2b_context, log_payment_claim, send_supply_whatsapp

logger = logging.getLogger(__name__)

_GREETINGS = frozenset({
    "hi", "hello", "hey", "vanakkam", "namaste", "good morning", "good evening",
})
_ORDER_TRIGGERS = frozenset({
    "1", "order", "place order", "want to order", "order pannum", "items venum",
    "supply venum", "order kodu", "today's order", "tomorrow order", "list",
    "what's available",
})
_BALANCE_TRIGGERS = frozenset({
    "2", "balance", "outstanding", "how much", "eppavadu", "kadan", "amount",
    "pending payment", "dues", "credit",
})
_STATUS_TRIGGERS = frozenset({
    "3", "status", "order status", "where is my order", "delivery status",
    "eppo varum", "delivered?", "track",
})
_PAYMENT_TRIGGERS = frozenset({
    "4", "paid", "i paid", "payment done", "transferred", "sent money",
    "paymentu panniten", "gpay panniten", "upi panni", "cash kotu", "i've paid",
    "ive paid",
})
_SUPPLIER_TRIGGERS = frozenset({
    "5", "talk", "call", "speak", "contact", "help", "problem", "issue", "owner", "manager",
})


def _norm(text: str) -> str:
    return (text or "").strip().lower()


def _is_trigger(text: str, triggers: frozenset[str]) -> bool:
    t = _norm(text)
    if t in triggers:
        return True
    return any(t.startswith(x + " ") or t.endswith(" " + x) for x in triggers if len(x) > 2)


def _looks_like_item_order(text: str) -> bool:
    """Detect 'tomatoes 5kg' style — redirect to form."""
    t = _norm(text)
    if re.search(r"\d+\s*(kg|g|ltr|l|pc|pcs|box|bag)", t):
        return True
    if re.search(r"(tomato|onion|potato|rice|dal|oil|milk)\s+\d", t):
        return True
    return False


def _parse_payment_details(text: str) -> tuple[float | None, str | None, str | None]:
    amount = None
    method = None
    reference = None
    m = re.search(r"₹?\s*([\d,]+(?:\.\d+)?)", text)
    if m:
        amount = float(m.group(1).replace(",", ""))
    lower = text.lower()
    for kw, label in (
        ("gpay", "UPI"), ("google pay", "UPI"), ("upi", "UPI"), ("phonepe", "UPI"),
        ("paytm", "UPI"), ("cash", "Cash"), ("cheque", "Cheque"), ("check", "Cheque"),
        ("bank", "Bank transfer"), ("neft", "Bank transfer"), ("imps", "Bank transfer"),
    ):
        if kw in lower:
            method = label
            break
    ref_m = re.search(r"(?:ref|reference|utr|txn)[:\s#-]*([A-Za-z0-9]{6,})", text, re.I)
    if ref_m:
        reference = ref_m.group(1)
    elif re.search(r"\bT\d{10,}\b", text):
        reference = re.search(r"\bT\d{10,}\b", text).group(0)
    return amount, method, reference


async def _send(to: str, body: str, wa: dict[str, Any]) -> None:
    await send_supply_whatsapp(
        to,
        body,
        wa.get("whatsapp_phone_number_id", ""),
        wa.get("whatsapp_access_token", ""),
    )


def _main_menu(ctx: dict[str, Any]) -> str:
    return (
        f"Vanakkam {ctx['client_name']}! 🙏\n"
        f"*{ctx['supplier_name']}*\n\n"
        f"Next delivery: {ctx['next_delivery_date']}\n"
        f"Outstanding:   ₹{ctx['outstanding_balance']}\n\n"
        "What can I help you with?\n"
        "1️⃣  Place order\n"
        "2️⃣  Check balance\n"
        "3️⃣  Order status\n"
        "4️⃣  I've made a payment\n"
        f"5️⃣  Speak to {ctx['supplier_name']}"
    )


async def _handle_order(ctx: dict[str, Any], to: str, wa: dict[str, Any]) -> dict[str, Any]:
    if not ctx.get("is_ordering_open"):
        await _send(
            to,
            f"Orders for {ctx['next_delivery_date']} are closed.\n"
            f"Ordering opens at {ctx.get('ordering_open_time', '6:00 PM')} and closes at "
            f"{ctx['ordering_cutoff']} daily.\n"
            "Message us after ordering opens to place your order. 🙏",
            wa,
        )
        return {"status": "ordering_closed"}

    util = ctx.get("credit_utilisation_pct", 0)
    auto_block = ctx.get("credit_auto_block", True)

    if util >= 100 and auto_block:
        await _send(
            to,
            f"⚠️ *Orders paused — {ctx['client_name']}*\n\n"
            f"Outstanding: ₹{ctx['outstanding_balance']}\n"
            f"Credit limit: ₹{ctx['credit_limit']}\n\n"
            "New orders are on hold until payment is received.\n\n"
            "To inform us of a payment: reply *4* or *I've paid*\n"
            f"Urgent: {ctx['supplier_phone']}",
            wa,
        )
        return {"status": "credit_blocked"}

    prefix = ""
    if util >= 100:
        prefix = (
            f"⚠️ Your credit limit of ₹{ctx['credit_limit']} is fully utilised.\n"
            f"{ctx['supplier_name']} will review your order.\n\n"
        )
    elif util >= 90:
        prefix = f"⚠️ Credit running low: ₹{ctx['credit_available']} remaining.\nPlease arrange payment soon.\n\n"
    elif util >= 80:
        prefix = f"ℹ️ Credit note: ₹{ctx['credit_available']} of ₹{ctx['credit_limit']} remaining.\n\n"

    await _send(
        to,
        prefix
        + f"📦 *{ctx['supplier_name']} — Order Form*\n"
        f"Delivery: {ctx['next_delivery_date']}\n\n"
        "Tap to open your order form 👇\n"
        f"{ctx['order_form_url']}\n\n"
        "Fill quantities and tap Submit.\n"
        "Your personalised prices are pre-loaded.\n\n"
        f"Form valid until: {ctx['ordering_cutoff']} tonight\n"
        f"Questions? Reply *5* to reach {ctx['supplier_name']}.",
        wa,
    )
    return {"status": "order_form_sent"}


async def _handle_balance(ctx: dict[str, Any], to: str, wa: dict[str, Any]) -> dict[str, Any]:
    await _send(
        to,
        f"💳 *Account Balance — {ctx['client_name']}*\n"
        f"{ctx['supplier_name']}\n\n"
        f"Outstanding:   ₹{ctx['outstanding_balance']}\n"
        f"Credit limit:  ₹{ctx['credit_limit']}\n"
        f"Available:     ₹{ctx['credit_available']}\n\n"
        f"Payment queries: {ctx['supplier_phone']}",
        wa,
    )
    return {"status": "balance_sent"}


async def _handle_status(ctx: dict[str, Any], to: str, wa: dict[str, Any]) -> dict[str, Any]:
    pending = ctx.get("pending_orders") or []
    if not pending:
        last = ctx.get("last_order_summary")
        msg = "No pending deliveries."
        if last:
            msg += f" Last order: {last}."
        msg += "\nReady to order? Reply *1*"
        await _send(to, msg, wa)
        return {"status": "no_pending"}

    lines = ["🚚 *Delivery Status — {name}*\n".format(name=ctx["client_name"])]
    labels = {
        "confirmed": "⏳ Confirmed — being prepared",
        "out_for_delivery": "🚚 Out for delivery",
        "delivered": "✅ Delivered",
        "partial": "⚠️ Partially delivered — contact supplier",
        "cancelled": "❌ Cancelled",
    }
    for o in pending[:5]:
        lines.append(
            f"#{o.get('order_number')} · ₹{o.get('total_amount')}\n"
            f"Status: {labels.get(o.get('status'), o.get('status'))}\n───"
        )
    await _send(to, "\n".join(lines), wa)
    return {"status": "status_sent"}


async def handle_supply_flow(
    customer_phone: str,
    message: str,
    supplier_id: str,
    wa_credentials: dict[str, Any],
    session_state: dict[str, Any],
) -> dict[str, Any]:
    ctx = await fetch_b2b_context(customer_phone, supplier_id)

    if not ctx.get("is_known_client"):
        name = ctx.get("supplier_name", "your supplier")
        phone = ctx.get("supplier_phone", "")
        await _send(
            customer_phone,
            f"Hello! This number isn't registered with {name}.\n\n"
            f"Ask {name} to add your WhatsApp number to your account.\n"
            f"For new supplier enquiries: {phone}",
            wa_credentials,
        )
        return {"status": "unknown_client"}

    text = (message or "").strip()
    step = session_state.get("supply_step")

    # Payment claim multi-step
    if step == "awaiting_payment_details":
        amount, method, reference = _parse_payment_details(text)
        result = await log_payment_claim(
            ctx["client_id"],
            amount,
            method,
            reference,
            text,
        )
        session_state.pop("supply_step", None)
        await _send(
            customer_phone,
            "Got it! Here's what I've noted:\n\n"
            f"Amount:    ₹{amount or '—'}\n"
            f"Method:    {method or '—'}\n"
            f"Reference: {reference or '—'}\n\n"
            f"This has been sent to {ctx['supplier_name']} for confirmation.\n"
            f"Current outstanding: ₹{ctx['outstanding_balance']}\n"
            f"Urgent queries: {ctx['supplier_phone']}",
            wa_credentials,
        )
        return {"status": "payment_claim_logged", "claim": result}

    if _is_trigger(text, _PAYMENT_TRIGGERS):
        session_state["supply_step"] = "awaiting_payment_details"
        await _send(
            customer_phone,
            f"Thank you for letting us know! 🙏\n\n"
            f"To help {ctx['supplier_name']} match your payment, please share:\n"
            "1. Amount paid (₹)\n"
            "2. How you paid (Cash / UPI / Bank transfer / Cheque)\n"
            "3. Reference number if available\n\n"
            "Example: ₹15,000 via GPay, ref T250617123456",
            wa_credentials,
        )
        return {"status": "awaiting_payment_details"}

    if _is_trigger(text, _ORDER_TRIGGERS) or _looks_like_item_order(text):
        if _looks_like_item_order(text) and not _is_trigger(text, _ORDER_TRIGGERS):
            await _send(
                customer_phone,
                "Orders are placed through our form, not by typing here.\n\n"
                "Tap to open your order form 👇\n"
                f"{ctx['order_form_url']}\n\n"
                "Fill in quantities and submit — takes less than 2 minutes! 📦",
                wa_credentials,
            )
            return {"status": "redirect_to_form"}
        return await _handle_order(ctx, customer_phone, wa_credentials)

    if _is_trigger(text, _BALANCE_TRIGGERS):
        return await _handle_balance(ctx, customer_phone, wa_credentials)

    if _is_trigger(text, _STATUS_TRIGGERS):
        return await _handle_status(ctx, customer_phone, wa_credentials)

    if _is_trigger(text, _SUPPLIER_TRIGGERS):
        await _send(
            customer_phone,
            f"I'll let {ctx['supplier_name']} know. They'll call you shortly.\n"
            f"Urgent: {ctx['supplier_phone']}",
            wa_credentials,
        )
        return {"status": "supplier_callback"}

    if _norm(text) in _GREETINGS or not text:
        await _send(customer_phone, _main_menu(ctx), wa_credentials)
        return {"status": "main_menu"}

    await _send(
        customer_phone,
        "Sorry, I didn't get that.\n\n"
        "1️⃣  Place order\n"
        "2️⃣  Check balance\n"
        "3️⃣  Order status\n"
        "4️⃣  I've made a payment\n"
        f"5️⃣  Speak to {ctx['supplier_name']}\n\n"
        f"Or call directly: {ctx['supplier_phone']}",
        wa_credentials,
    )
    return {"status": "unrecognised"}
