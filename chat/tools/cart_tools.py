"""
cart_tools.py
─────────────────────────────────────────────────────────────────────────────
WhatsApp interactive cart experience.

Replaces free-text order entry with a 3-phase flow:
  Phase 1 — send_category_list()        -> customer picks a category
  Phase 2 — send_item_list()            -> customer picks items (repeatable)
  Phase 3 — send_cart_summary_buttons() -> customer confirms / adds more / clears

Cart state lives entirely in session_state under the key "cart":
  {
    "M003": {"title": "Masala Dosa",  "qty": 2, "unit_price": 60},
    "E001": {"title": "Bajji (4 pcs)","qty": 1, "unit_price": 30},
  }

Session keys used:
  session_state["cart"]               — dict[item_id -> cart_line]
  session_state["booking_step"]       — booking step managed by booking_agent
  session_state["pending_item"]       — item awaiting quantity confirmation
  session_state["pending_item_queue"] — remaining items when multi-select used
  session_state["token_number"]       — token for confirmed order (set by booking flows)
  session_state["order_confirmed_summary"] — human-readable summary for guard message

WhatsApp interactive message limits (as of API v20):
  - list message: max 10 sections, max 10 rows per section (total <= 10 rows in
    a single section). We split across sections when > 10 items per category.
  - button message: max 3 buttons
  - All button IDs must be <= 256 bytes, unique per message.
  - Row description: max 72 characters (enforced by _truncate_desc helper)

Environment variables (same as catalog_tools):
  META_GRAPH_API_TOKEN
  WABA_PHONE_NUMBER_ID
  META_GRAPH_VERSION

FIX LOG
-------
  Bug 1 — "Add more items" button sent a plain-text fallback instead of the
           interactive category list.
           Fix: handle_cart_action() now explicitly calls send_category_list()
           for CART:ADD_MORE and returns immediately.

  Bug 2 — Numbered-text replies (e.g. "2" for Vada) skipped the quantity
           prompt and defaulted to qty=1.
           Fix: parse_numbered_order path now calls send_quantity_prompt(),
           storing the item in session_state["pending_item"] and setting
           booking_step = "awaiting_quantity". A new confirm_pending_item()
           helper completes the cart add when the quantity reply arrives.
           Multi-item replies (e.g. "1 2") queue remaining items in
           session_state["pending_item_queue"] and prompt one at a time.

  Bug 3 — Stale button taps (CART:ADD_MORE, CART:CLEAR) after order is
           confirmed (booking_step = "awaiting_payment") were re-opening the
           menu and creating duplicate bookings.
           Fix: handle_incoming_message() checks booking_step == "awaiting_payment"
           before processing CART:ADD_MORE and CART:CLEAR, and sends the
           confirmed order summary with a "New Place New Order" button instead.

  Bug 4 — WhatsApp API returned HTTP 400: "Row description is too long.
           Max length is 72" when a cart note (e.g. " (in cart: 2)") was
           appended to the price + item description in send_item_list().
           The [:60] slice on item["description"] alone was insufficient
           because the full assembled string (price + cart note + description)
           could still exceed 72 chars.
           Fix: _truncate_desc() caps the ENTIRE assembled description string
           to 72 characters, truncating with "..." if needed. Applied to every
           row built in send_item_list().

  Bug 6 — Stale-button guard in handle_incoming_message() was using _send_text()
           for the "order confirmed" message, inconsistent with the same guard in
           booking_agent. Replaced with _send_interactive() so the customer sees
           a tappable "New Place New Order" button rather than having to type text.

  Bug 7 — Quantity prompt used plain text "Reply with a number e.g. 1, 2, 3 ..."
           requiring the customer to type. Replaced with send_quantity_buttons()
           which sends 3 quick-reply buttons for the most common quantities
           (1, 2, 3) plus a "Other qty" escape hatch that drops into free-text.

           Button IDs: QTY:1, QTY:2, QTY:3, QTY:OTHER
           Step guard:  session_state["pending_qty_button_step"] = "awaiting_quantity"
           Stale-tap safety: _resolve_qty_input() checks the step matches before
           trusting any QTY: button reply (same pattern as identity_agent).

  Bug 8 — "DONE" in awaiting_item_selection / awaiting_numbered_order required
           the customer to type the word. Replaced with send_done_or_more_buttons()
           which appends a 2-button message after each item-selection confirmation:
             [Done — see cart]  [Add more items]
           Button IDs: CART:SHOW_SUMMARY  CART:ADD_MORE
           These are handled at the top of the interactive-reply branch in
           handle_incoming_message() before the existing CAT:/ITEM:/CART: routing.

  Bug 9 — No upper bound on quantity input. Customer could type any number
           (e.g. 1000000000000000000000) resulting in absurd cart totals and
           display corruption.
           Fix: _resolve_qty_input() now validates that the parsed quantity is
           between MIN_QTY (1) and MAX_QTY (20) inclusive.
           - Values < 1 -> returns None (caller sends error prompt)
           - Values > 20 -> returns None (caller sends error prompt)
           - Non-integer text -> returns None
           confirm_pending_item() also enforces the same bounds as a
           second safety layer before writing to the cart.
           send_quantity_buttons() footer text updated to hint at the limit.
           A dedicated _qty_error_message() helper sends a consistent,
           friendly rejection to the customer.

  Fix (menu source) — MENU_ITEMS was a static hardcoded list in catalog_tools.py.
            send_category_list() now calls fetch_menu_items() at the start so the
            cache is always warm before building the menu. All other functions that
            read MENU_ITEMS will automatically see live data since MENU_ITEMS is
            the same list object that the cache mutates in-place.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import httpx

from tools.catalog_tools import MENU_ITEMS, items_for_category, fetch_menu_items

# Lazy import to avoid circular import at module load time.
# whatsapp_tools._get_http_client() returns the module-level shared AsyncClient.
def _shared_http_client() -> httpx.AsyncClient:
    from tools.whatsapp_tools import _get_http_client
    return _get_http_client()


logger = logging.getLogger(__name__)

_TOKEN    = os.getenv("META_GRAPH_API_TOKEN", "")
_PHONE_ID = os.getenv("WABA_PHONE_NUMBER_ID", "")
_API_VER  = os.getenv("META_GRAPH_VERSION", "v20.0")
_BASE_URL = f"https://graph.facebook.com/{_API_VER}"

# WhatsApp API hard limit for list-row description field
_MAX_ROW_DESC = 72

# ── Quantity validation bounds ────────────────────────────────────────────────
MIN_QTY = 1
MAX_QTY = 20

# ── Description truncation helper ─────────────────────────────────────────────

def _truncate_desc(text: str, max_len: int = _MAX_ROW_DESC) -> str:
    """
    Truncate *text* to at most *max_len* characters.

    WhatsApp rejects list-row descriptions longer than 72 chars with HTTP 400.
    We cap the entire assembled description string here rather than trying to
    pre-calculate how many characters are left for each component.
    """
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"


# ── Cart helpers ──────────────────────────────────────────────────────────────

def get_cart(session_state: dict[str, Any]) -> dict[str, Any]:
    """Return the cart dict from session_state, creating it if absent."""
    if "cart" not in session_state:
        session_state["cart"] = {}
    return session_state["cart"]


def cart_total(cart: dict[str, Any]) -> float:
    """Sum of (qty x unit_price) for all items in the cart."""
    return sum(line["qty"] * line["unit_price"] for line in cart.values())


def cart_summary_text(
    cart: dict[str, Any],
    session_state: dict[str, Any] | None = None,
) -> str:
    """Human-readable cart summary with optional parcel/GST estimate for takeaway/delivery."""
    if not cart:
        return "Your cart is empty."

    from tools.order_pricing import compute_order_totals, format_order_total_lines

    lines = ["🛒 *Your cart:*\n"]
    for line in cart.values():
        subtotal = line["qty"] * line["unit_price"]
        lines.append(f"• {line['qty']}x {line['title']} — ₹{subtotal:.0f}")

    service_type = (session_state or {}).get("service_type", "")
    parcel_rate = float((session_state or {}).get("parcel_charge_per_item") or 0)

    if service_type in ("takeaway", "delivery") and (parcel_rate > 0 or service_type == "delivery"):
        from tools.order_pricing import resolve_delivery_charge
        deli = resolve_delivery_charge(session_state) if service_type == "delivery" else 0
        totals = compute_order_totals(
            cart,
            service_type,
            parcel_per_item=parcel_rate,
            delivery_charge=deli,
        )
        lines.append("")
        lines.append(format_order_total_lines(totals, session_state=session_state))
    else:
        lines.append(f"\n*Total: ₹{cart_total(cart):.0f}*")

    return "\n".join(lines)


def add_to_cart(
    session_state: dict[str, Any],
    item_id: str,
    title: str,
    unit_price: float,
    qty: int = 1,
) -> None:
    """Add or increment an item in the cart."""
    cart = get_cart(session_state)
    if item_id in cart:
        cart[item_id]["qty"] += qty
    else:
        cart[item_id] = {"title": title, "qty": qty, "unit_price": unit_price}


def clear_cart(session_state: dict[str, Any]) -> None:
    session_state["cart"] = {}


def _looks_like_retailer_sku(text: str) -> bool:
    """True when title is a Meta/catalog retailer id (e.g. E003, D007)."""
    return bool(re.match(r"^[A-Z]\d{2,}$", (text or "").strip()))


async def enrich_cart_titles(cart: dict[str, Any], restaurant_id: str) -> None:
    """Replace SKU-only cart titles with human-readable menu names."""
    if not cart or not restaurant_id:
        return

    items = await fetch_menu_items(restaurant_id)
    by_id: dict[str, str] = {}
    for item in items:
        rid = (item.get("id") or "").strip()
        name = (item.get("title") or "").strip()
        if rid and name:
            by_id[rid] = name
            by_id[rid.upper()] = name
            by_id[rid.lower()] = name

    unresolved: list[str] = []
    for item_id, line in cart.items():
        rid = (item_id or "").strip()
        current = (line.get("title") or "").strip()
        resolved = by_id.get(rid) or by_id.get(rid.upper()) or by_id.get(current)
        if resolved and (
            not current
            or current == rid
            or _looks_like_retailer_sku(current)
        ):
            line["title"] = resolved
        elif _looks_like_retailer_sku(current) or current == rid:
            unresolved.append(rid or current)

    if unresolved:
        from tools.db_tools import lookup_menu_names_by_retailer_ids
        extra = await lookup_menu_names_by_retailer_ids(restaurant_id, unresolved)
        for item_id, line in cart.items():
            rid = (item_id or "").strip()
            current = (line.get("title") or "").strip()
            resolved = extra.get(rid) or extra.get(rid.upper()) or extra.get(current)
            if resolved and (
                not current
                or current == rid
                or _looks_like_retailer_sku(current)
            ):
                line["title"] = resolved


def cart_to_order_text(cart: dict[str, Any]) -> str:
    """Convert cart to the order string expected by booking_agent."""
    parts = [f"{line['qty']}x {line['title']}" for line in cart.values()]
    return ", ".join(parts)


# ── Low-level senders ─────────────────────────────────────────────────────────

async def _send_interactive(
    customer_phone: str,
    payload: dict[str, Any],
    restaurant_id: str | None = None,
) -> bool:
    """POST an interactive message to the WhatsApp Cloud API."""
    from tools.restaurant_config import get_whatsapp_credentials

    creds = await get_whatsapp_credentials(restaurant_id)
    if not creds:
        logger.warning(
            f"No WhatsApp credentials for restaurant {restaurant_id} — skipping interactive msg"
        )
        return False

    api_endpoint = creds["api_endpoint"].rstrip("/")
    url = f"{api_endpoint}/{creds['phone_number_id']}/messages"
    headers = {
        "Authorization": f"Bearer {creds['access_token']}",
        "Content-Type":  "application/json",
    }

    client = _shared_http_client()
    resp = await client.post(url, headers=headers, json={
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                customer_phone,
        "type":              "interactive",
        **payload,
    })

    if resp.status_code == 200:
        return True
    else:
        logger.error(
            f"Interactive message failed ({resp.status_code}): {resp.text[:300]}"
        )
        return False


async def _send_text(
    customer_phone: str,
    text: str,
    restaurant_id: str | None = None,
) -> bool:
    """POST a plain-text message to the WhatsApp Cloud API."""
    from tools.restaurant_config import get_whatsapp_credentials

    creds = await get_whatsapp_credentials(restaurant_id)
    if not creds:
        logger.warning(
            f"No WhatsApp credentials for restaurant {restaurant_id} — skipping text msg"
        )
        return False

    api_endpoint = creds["api_endpoint"].rstrip("/")
    url = f"{api_endpoint}/{creds['phone_number_id']}/messages"
    headers = {
        "Authorization": f"Bearer {creds['access_token']}",
        "Content-Type":  "application/json",
    }

    client = _shared_http_client()
    resp = await client.post(url, headers=headers, json={
        "messaging_product": "whatsapp",
        "recipient_type":    "individual",
        "to":                customer_phone,
        "type":              "text",
        "text":              {"body": text},
    })

    if resp.status_code == 200:
        return True
    else:
        logger.error(f"Text message failed ({resp.status_code}): {resp.text[:300]}")
        return False


# ── Quantity error helper ─────────────────────────────────────────────────────

async def _qty_error_message(
    customer_phone: str,
    item_title: str,
    restaurant_id: str | None = None,
) -> None:
    """
    Send a friendly, consistent rejection when quantity is out of bounds.
    Bug 9 fix: single place to update the error wording if limits change.
    """
    await _send_text(
        customer_phone,
        f"Please enter a quantity between {MIN_QTY} and {MAX_QTY} for "
        f"*{item_title}* (e.g. tap 1, 2, or 3, or type a number).",
        restaurant_id=restaurant_id,
    )


# ── Phase 1: Category picker ──────────────────────────────────────────────────

async def send_category_list(
    customer_phone: str,
    session_state: dict[str, Any],
    restaurant_id: str | None = None,
) -> bool:
    """
    Send a WhatsApp list message showing available menu categories.
    Customer taps one to browse items in that category.

    Returns True on API success.
    """
    rid = restaurant_id or session_state.get("restaurant_id")
    if rid:
        session_state["restaurant_id"] = rid
    await fetch_menu_items(rid)

    from tools.catalog_tools import _get_restaurant_label
    menu_label = await _get_restaurant_label(rid)

    available = [i for i in MENU_ITEMS if i.get("is_available", True)]
    categories = list(dict.fromkeys(
        i.get("category", "General") for i in available
    ))

    if not categories:
        logger.error(
            f"[cart] No menu categories for {customer_phone} (restaurant={rid}) — "
            "kitchen may be closed or menu cache empty; skipping empty list"
        )
        return False

    rows = []
    for cat in categories[:10]:
        count = sum(1 for i in available if i.get("category", "General") == cat)
        rows.append({
            "id":          f"CAT:{cat}",
            "title":       cat[:24],
            "description": _truncate_desc(f"{count} items"),
        })

    payload = {
        "interactive": {
            "type": "list",
            "header": {"type": "text", "text": f"🍽️ {menu_label} Menu"},
            "body": {
                "text": (
                    "What would you like to eat? 🍽️\n\n"
                    "Tap a category to browse items.\n\n"
                    "Add items one by one to your cart 🛒\n\n"
                    "When you're done, you can:\n"
                    "🎯 Confirm Order — to place your order & pay the bill\n"
                    "➕ Add More — to keep browsing / adding\n"
                    "🗑️ Clear Cart — to start over\n\n"
                    "Take your time and add as many items as you like!"
                )
            },
            "footer": {"text": "Tap a category above to get started"},
            "action": {
                "button": "Browse menu",
                "sections": [{"title": "Menu categories", "rows": rows}],
            },
        }
    }

    ok = await _send_interactive(customer_phone, payload, session_state.get("restaurant_id"))
    if ok:
        session_state["booking_step"] = "awaiting_category_selection"
    return ok


# ── Phase 2: Item picker ──────────────────────────────────────────────────────

async def send_item_list(
    customer_phone: str,
    category: str,
    session_state: dict[str, Any],
) -> bool:
    """
    Send a WhatsApp list message showing items in the chosen category.
    Each row ID encodes the item ID so we can parse it on reply.

    FIX (Bug 4): The entire assembled description string is passed through
    _truncate_desc() to guarantee it never exceeds 72 characters, which
    previously caused HTTP 400 "Row description is too long" errors from the
    WhatsApp API — especially when a cart note was appended.
    """
    await fetch_menu_items(session_state.get("restaurant_id"))
    items = items_for_category(category)
    if not items:
        return False

    cart  = get_cart(session_state)

    rows = []
    for item in items[:10]:
        price_inr = item["price"] // 100
        in_cart   = cart.get(item["id"])
        cart_note = f" (in cart: {in_cart['qty']})" if in_cart else ""

        # Build title — WhatsApp list row title max is 24 chars
        title = item["title"][:22] + ".." if len(item["title"]) > 24 else item["title"]

        # Build description and hard-cap at 72 chars (WhatsApp API limit).
        raw_desc    = f"₹{price_inr}{cart_note} — {item['description']}"
        description = _truncate_desc(raw_desc)

        rows.append({
            "id":          f"ITEM:{item['id']}",
            "title":       title,
            "description": description,
        })

    footer = (
        f"Cart total: ₹{cart_total(cart):.0f}"
        if cart
        else "Tap an item to add it to your cart"
    )

    payload = {
        "interactive": {
            "type": "list",
            "header": {"type": "text", "text": f"🍽️ {category}"},
            "body": {
                "text": (
                    "Tap an item to add it to your cart.\n"
                    "You can add more items or confirm your order after."
                )
            },
            "footer": {"text": footer},
            "action": {
                "button": "Pick item",
                "sections": [{"title": category[:24], "rows": rows}],
            },
        }
    }

    ok = await _send_interactive(customer_phone, payload, session_state.get("restaurant_id"))
    if ok:
        session_state["booking_step"]     = "awaiting_item_selection"
        session_state["current_category"] = category
    return ok


# ── Phase 3: Cart action buttons ──────────────────────────────────────────────

async def send_cart_summary_buttons(
    customer_phone: str,
    session_state: dict[str, Any],
    added_item_title: str | None = None,
) -> bool:
    """
    Send a button message showing the current cart with 3 action buttons:
      1. 🎯 Confirm order
      2. ➕ Add more items
      3. 🗑️ Clear cart

    Returns True on API success.
    """
    cart    = get_cart(session_state)
    summary = cart_summary_text(cart, session_state)
    header  = f"Added: {added_item_title}" if added_item_title else "Your cart"

    body_text = summary
    if not cart:
        body_text = "Your cart is empty. Browse the menu to add items."

    payload = {
        "interactive": {
            "type": "button",
            "header": {"type": "text", "text": header},
            "body":   {"text": body_text},
            "footer": {"text": "What would you like to do?"},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {"id": "CART:CONFIRM",  "title": "🎯 Confirm order"}},
                    {"type": "reply", "reply": {"id": "CART:ADD_MORE", "title": "➕ Add more items"}},
                    {"type": "reply", "reply": {"id": "CART:CLEAR",    "title": "🗑️ Clear cart"}},
                ]
            },
        }
    }

    ok = await _send_interactive(customer_phone, payload, session_state.get("restaurant_id"))
    if ok:
        session_state["booking_step"] = "awaiting_cart_action"
    return ok


# ── Quantity prompt helpers ───────────────────────────────────────────────────

_QTY_BUTTON_STEP_KEY = "pending_qty_button_step"


async def send_quantity_buttons(
    customer_phone: str,
    item: dict[str, Any],
    session_state: dict[str, Any],
) -> bool:
    """
    Ask how many of a single item the customer wants using tappable buttons.

    Sends interactive button message with QTY:1, QTY:2, QTY:3.
    Follows up with plain text allowing any other number (1-20).
    Stores the item in session_state["pending_item"] and sets
    booking_step = "awaiting_quantity".

    Bug 9 fix: footer and follow-up text now mention the 1-20 limit.
    """
    price_inr = (
        item["price"] // 100
        if item.get("price", 0) > 100
        else item.get("unit_price", item.get("price", 0))
    )

    session_state["pending_item"] = {
        "id":         item["id"],
        "title":      item["title"],
        "unit_price": price_inr,
    }
    session_state["booking_step"]       = "awaiting_quantity"
    session_state[_QTY_BUTTON_STEP_KEY] = "awaiting_quantity"

    item_title_short = item["title"][:24] if len(item["title"]) > 24 else item["title"]

    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "button",
            "header": {"type": "text", "text": item_title_short},
            "body": {
                "text": f"₹{price_inr} each\n\nHow many would you like?"
            },
            "footer": {"text": f"Tap a qty or type 1–{MAX_QTY}"},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {"id": "QTY:1", "title": "1️⃣  Qty: 1"}},
                    {"type": "reply", "reply": {"id": "QTY:2", "title": "2️⃣  Qty: 2"}},
                    {"type": "reply", "reply": {"id": "QTY:3", "title": "3️⃣  Qty: 3"}},
                ]
            },
        }
    }, session_state.get("restaurant_id"))

    await _send_text(
        customer_phone,
        f"Or reply with any number from *1 to {MAX_QTY}* e.g. *4*, *5* …",
        restaurant_id=session_state.get("restaurant_id"),
    )

    return ok


async def send_quantity_prompt(
    customer_phone: str,
    item: dict[str, Any],
    session_state: dict[str, Any],
) -> bool:
    """
    Plain-text quantity prompt — used only by the numbered-order fallback path.
    Interactive path uses send_quantity_buttons() instead (Fix Bug 7).

    Bug 9 fix: prompt text now mentions the 1-20 limit.
    """
    price_inr = (
        item["price"] // 100
        if item.get("price", 0) > 100
        else item.get("unit_price", item.get("price", 0))
    )

    session_state["pending_item"] = {
        "id":         item["id"],
        "title":      item["title"],
        "unit_price": price_inr,
    }
    session_state["booking_step"] = "awaiting_quantity"

    text = (
        f"*{item['title']}* (₹{price_inr} each)\n\n"
        f"How many would you like?\n"
        f"Reply with a number from *1 to {MAX_QTY}*"
    )
    return await _send_text(customer_phone, text, restaurant_id=session_state.get("restaurant_id"))


def _resolve_qty_input(
    message_obj: dict[str, Any] | None,
    session_state: dict[str, Any],
) -> int | None:
    """
    Try to extract a validated quantity from a button reply (QTY:N) or
    free-text number.

    Returns the integer quantity if valid (MIN_QTY <= qty <= MAX_QTY),
    or None if the message can't be resolved or is out of range.

    Bug 9 fix: added MIN_QTY / MAX_QTY bounds check on both the button
    and free-text paths. Previously any integer — including astronomically
    large numbers like 1e22 — passed through unchecked.

    Safety: QTY: button IDs are only trusted when
    session_state["pending_qty_button_step"] == "awaiting_quantity",
    guarding against stale cached button taps from a previous item prompt.
    """
    raw_qty: int | None = None

    # ── Button reply path ──────────────────────────────────────────────────
    if message_obj and message_obj.get("type") == "interactive":
        interactive = message_obj.get("interactive", {})
        if interactive.get("type") == "button_reply":
            btn_id = interactive.get("button_reply", {}).get("id", "")
            if btn_id.startswith("QTY:"):
                # Step guard — reject stale taps
                if session_state.get(_QTY_BUTTON_STEP_KEY) != "awaiting_quantity":
                    logger.warning(
                        "Stale QTY button tap ignored: btn_id=%s session_step=%s",
                        btn_id,
                        session_state.get(_QTY_BUTTON_STEP_KEY),
                    )
                    return None
                try:
                    raw_qty = int(btn_id.split(":", 1)[1])
                except (ValueError, IndexError):
                    return None

    # ── Free-text path ─────────────────────────────────────────────────────
    if raw_qty is None:
        body = ""
        if isinstance(message_obj, dict):
            body = (message_obj.get("text") or {}).get("body", "")
        if not body and isinstance(message_obj, str):
            body = message_obj

        nums = re.findall(r"\d+", str(body))
        if nums:
            try:
                # Use the first number found; guard against Python's arbitrary
                # precision integers by checking string length first.
                num_str = nums[0]
                if len(num_str) > 4:
                    # Any number with more than 4 digits is definitely > MAX_QTY
                    return None
                raw_qty = int(num_str)
            except ValueError:
                return None

    # ── Bounds validation (Bug 9 fix) ──────────────────────────────────────
    if raw_qty is None:
        return None

    if raw_qty < MIN_QTY or raw_qty > MAX_QTY:
        logger.info(
            "Quantity %d rejected: out of range [%d, %d]",
            raw_qty, MIN_QTY, MAX_QTY,
        )
        return None

    return raw_qty


def confirm_pending_item(
    session_state: dict[str, Any],
    qty: int,
) -> str | None:
    """
    Complete the pending add-to-cart with the supplied quantity.

    Pops session_state["pending_item"], calls add_to_cart(), and returns the
    item title on success. Returns None if there was no pending item.
    Clears the qty button step guard.

    Bug 9 fix: enforces MIN_QTY / MAX_QTY bounds as a second safety layer
    before writing to the cart, so a qty that somehow bypassed
    _resolve_qty_input() cannot corrupt cart totals.
    """
    # Second-layer bounds check
    if qty < MIN_QTY or qty > MAX_QTY:
        logger.warning(
            "confirm_pending_item: qty %d out of range [%d, %d] — rejected",
            qty, MIN_QTY, MAX_QTY,
        )
        return None

    pending = session_state.pop("pending_item", None)
    session_state.pop(_QTY_BUTTON_STEP_KEY, None)
    if not pending:
        return None

    add_to_cart(
        session_state,
        item_id    = pending["id"],
        title      = pending["title"],
        unit_price = pending["unit_price"],
        qty        = qty,
    )
    return pending["title"]


# ── Post-add "Done or more?" buttons ──────────────────────────────────────────

async def send_done_or_more_buttons(
    customer_phone: str,
    added_item_title: str,
    cart: dict[str, Any],
    restaurant_id: str | None = None,
) -> bool:
    """
    After an item is confirmed into the cart, offer two quick-action buttons:
      [Done — see cart]  [Add more items]
    """
    total       = cart_total(cart)
    items_count = sum(line["qty"] for line in cart.values())

    return await _send_interactive(customer_phone, {
        "interactive": {
            "type": "button",
            "header": {"type": "text", "text": f"✅ Added: {added_item_title[:30]}"},
            "body": {
                "text": (
                    f"Cart: {items_count} item(s) — ₹{total:.0f} total\n\n"
                    f"What would you like to do?"
                )
            },
            "footer": {"text": "You can keep adding or confirm your order"},
            "action": {
                "buttons": [
                    {"type": "reply", "reply": {"id": "CART:SHOW_SUMMARY", "title": "✅ Done — see cart"}},
                    {"type": "reply", "reply": {"id": "CART:ADD_MORE",     "title": "➕ Add more items"}},
                ]
            },
        }
    }, restaurant_id)


# ── Incoming message parser ───────────────────────────────────────────────────

def parse_interactive_reply(message: dict[str, Any]) -> tuple[str, str] | None:
    """
    Parse an incoming WhatsApp interactive reply.
    Returns (reply_id, reply_title) or None if not an interactive reply.
    """
    if message.get("type") != "interactive":
        return None

    interactive = message.get("interactive", {})
    itype = interactive.get("type")

    if itype == "list_reply":
        r = interactive.get("list_reply", {})
        return r.get("id", ""), r.get("title", "")
    elif itype == "button_reply":
        r = interactive.get("button_reply", {})
        return r.get("id", ""), r.get("title", "")

    return None


# ── Central message router ────────────────────────────────────────────────────

async def handle_incoming_message(
    customer_phone: str,
    message: dict[str, Any],
    session_state: dict[str, Any],
) -> bool:
    """
    Central router for all cart-related incoming messages.

    Call this from your webhook handler BEFORE falling through to the
    booking_agent. Returns True if the message was handled here (no further
    processing needed), False if the caller should handle it.

    Routing order:
      1. awaiting_payment guard — stale button taps after confirmed order
      2. Interactive reply      — route by reply_id prefix (including new
                                  QTY:, CART:SHOW_SUMMARY buttons)
      3. awaiting_quantity      — quantity capture (button or free-text)
      4. awaiting_item_selection + numbered text — item pick
      5. Anything else          — return False (let booking_agent handle it)
    """
    current_step = session_state.get("booking_step", "")

    # ── 0. Stale-button guard ─────────────────────────────────────────────────
    if current_step == "awaiting_payment":
        parsed = parse_interactive_reply(message)
        if parsed:
            reply_id, _ = parsed
            if reply_id in (
                "CART:ADD_MORE", "CART:CLEAR", "CART:CONFIRM",
                "CART:SHOW_SUMMARY", "QTY:1", "QTY:2", "QTY:3",
            ):
                summary = session_state.get(
                    "order_confirmed_summary",
                    f"Token *#{session_state.get('token_number', '')}*",
                )
                await _send_interactive(
                    customer_phone,
                    {
                        "interactive": {
                            "type": "button",
                            "body": {
                                "text": (
                                    f"✅ Your order is confirmed and being prepared!\n"
                                    f"_{summary}_"
                                )
                            },
                            "footer": {"text": "Want to order something else?"},
                            "action": {
                                "buttons": [
                                    {
                                        "type":  "reply",
                                        "reply": {"id": "NEW ORDER", "title": "🆕 Place New Order"},
                                    },
                                ]
                            },
                        }
                    },
                    session_state.get("restaurant_id"),
                )
                return True
        return False

    # ── 1. Interactive reply ──────────────────────────────────────────────────
    parsed = parse_interactive_reply(message)
    if parsed:
        reply_id, reply_title = parsed

        # "Done — see cart" quick button -> show full cart summary
        if reply_id == "CART:SHOW_SUMMARY":
            await send_cart_summary_buttons(customer_phone, session_state)
            return True

        # Quantity quick buttons (QTY:1, QTY:2, QTY:3)
        if reply_id.startswith("QTY:"):
            qty = _resolve_qty_input(message, session_state)
            if qty is None:
                pending = session_state.get("pending_item", {})
                await _qty_error_message(
                    customer_phone, pending.get("title", "item"),
                    restaurant_id=session_state.get("restaurant_id"),
                )
                return True

            title = confirm_pending_item(session_state, qty)
            if title is None:
                # confirm_pending_item bounds check rejected it
                pending = session_state.get("pending_item", {})
                await _qty_error_message(
                    customer_phone, pending.get("title", "item"),
                    restaurant_id=session_state.get("restaurant_id"),
                )
                return True

            queue = session_state.get("pending_item_queue", [])
            if queue:
                next_item = queue.pop(0)
                session_state["pending_item_queue"] = queue
                await send_quantity_buttons(customer_phone, next_item, session_state)
            else:
                cart = get_cart(session_state)
                await send_done_or_more_buttons(
                    customer_phone, title, cart, session_state.get("restaurant_id"),
                )
            return True

        if reply_id.startswith("CAT:"):
            category = reply_id.split(":", 1)[1]
            await send_item_list(customer_phone, category, session_state)
            return True

        # Item tapped from list -> ask quantity via buttons
        if reply_id.startswith("ITEM:"):
            item_id = reply_id.split(":", 1)[1]
            item    = next((i for i in MENU_ITEMS if i["id"] == item_id), None)
            if item:
                await send_quantity_buttons(customer_phone, item, session_state)
            return True

        # Cart action buttons
        if reply_id == "CART:CONFIRM":
            session_state["booking_step"] = "confirming_order"
            return False

        if reply_id == "CART:ADD_MORE":
            await send_category_list(customer_phone, session_state)
            return True

        if reply_id == "CART:CLEAR":
            clear_cart(session_state)
            await send_cart_summary_buttons(customer_phone, session_state)
            return True

    # ── 2. Quantity reply (awaiting_quantity) ─────────────────────────────────
    if current_step == "awaiting_quantity":
        qty = _resolve_qty_input(message, session_state)

        if qty is not None:
            title = confirm_pending_item(session_state, qty)
            if title is None:
                # Bounds check in confirm_pending_item rejected it
                pending = session_state.get("pending_item", {})
                await _qty_error_message(
                    customer_phone, pending.get("title", "item"),
                    restaurant_id=session_state.get("restaurant_id"),
                )
                return True

            queue = session_state.get("pending_item_queue", [])
            if queue:
                next_item = queue.pop(0)
                session_state["pending_item_queue"] = queue
                await send_quantity_buttons(customer_phone, next_item, session_state)
            else:
                cart = get_cart(session_state)
                await send_done_or_more_buttons(
                    customer_phone, title, cart, session_state.get("restaurant_id"),
                )
            return True

        else:
            # qty is None — either unparseable or out of range
            pending = session_state.get("pending_item", {})
            await _qty_error_message(
                customer_phone, pending.get("title", "item"),
                restaurant_id=session_state.get("restaurant_id"),
            )
            return True

    # ── 3. Numbered-text reply while browsing items ───────────────────────────
    if current_step == "awaiting_item_selection":
        text = (message.get("text") or {}).get("body", "").strip()

        if text.upper() == "DONE":
            await send_cart_summary_buttons(customer_phone, session_state)
            return True

        category = session_state.get("current_category")
        matched  = parse_numbered_order(text, category=category)

        if matched:
            if len(matched) == 1:
                await send_quantity_buttons(customer_phone, matched[0], session_state)
            else:
                session_state["pending_item_queue"] = [
                    {"id": i["id"], "title": i["title"], "price": i["price"]}
                    for i in matched[1:]
                ]
                await send_quantity_buttons(customer_phone, matched[0], session_state)
            return True

    # ── 4. Not handled here ───────────────────────────────────────────────────
    return False


# ── Fallback: plain-text cart flow ────────────────────────────────────────────

def plain_text_menu(category: str | None = None) -> str:
    """
    Plain-text menu for when interactive messages are unavailable.
    Numbered so customer can reply '1', '2' etc. instead of typing item names.
    """
    items = items_for_category(category)
    if not items:
        items = [i for i in MENU_ITEMS if i.get("is_available", True)]

    label = category or "Menu"
    lines = [f"🍽️ *{label}* — reply with item number(s)\n"]
    for i, item in enumerate(items, 1):
        price_inr = item["price"] // 100
        lines.append(f"{i}. {item['title']} — ₹{price_inr}")
    lines.append(f"\nExample: reply *1 2* to order items 1 and 2")
    lines.append("Reply *DONE* when finished adding items")
    return "\n".join(lines)


def parse_numbered_order(
    text: str,
    category: str | None = None,
    session_state: dict[str, Any] | None = None,
) -> list[dict[str, Any]] | None:
    """
    Parse a numbered reply like '1 3' or '2, 4' against the current category menu.
    Returns list of matched items, or None if nothing parsed.
    """
    items = items_for_category(category) or [
        i for i in MENU_ITEMS if i.get("is_available", True)
    ]

    numbers = [int(n) for n in re.findall(r"\d+", text)]
    matched = []
    for n in numbers:
        if 1 <= n <= len(items):
            matched.append(items[n - 1])

    return matched if matched else None
