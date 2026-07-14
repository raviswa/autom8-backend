# chat/agents/supply_agent.py
# ============================================================================
# Munafe Supply — WhatsApp conversation agent
#
# Entry point: handle_supply_message()
# Called by main.py/_process_supply_payload after supplier + client are resolved.
#
# Intents handled:
#   1. PLACE_ORDER  → mint /s/:token webcart link
#   2. BALANCE      → "what's my balance / outstanding / kitna baaki hai"
#   3. PAYMENT      → "paid ₹5000 upi ref 12345 / sent 2000 gpay"
#   4. ORDER_STATUS → text/keyword only (not on the 3-button menu)
#   5. FALLBACK     → main menu buttons
#
# State is stored in supply_conversation_states (same table as supply_agent.py
# referenced in db/queries.py).  State is intentionally minimal — supply chat
# is transactional, not conversational.
#
# FIX (button-reply routing): interactive button taps carry fixed IDs like
# CHECK_BALANCE, ORDER_STATUS, RECORD_PAYMENT (set in _handle_fallback's
# quick-reply menu). These IDs were previously falling through to the
# free-text regex intent matchers (_BALANCE_RE, _ORDER_STATUS_RE, _PAYMENT_RE),
# which use \b word-boundary matching — but underscore is a \w character in
# Python regex, so e.g. \bbalance\b never matches inside "CHECK_BALANCE".
# Every tap was silently missing all three regexes and landing in
# _handle_fallback, which just re-sent the same button menu — looking like
# the bot was doing nothing. These three IDs are now handled explicitly,
# the same way CONFIRM_PAYMENT:*/CANCEL_PAYMENT already were.
# ============================================================================

import logging
import re
from typing import Optional

from db.queries import (
    get_client_by_phone,
    get_supply_session,
    save_supply_session,
    get_client_outstanding,
    create_payment_claim,
    log_supply_notification,
    get_last_supply_order,
    get_supplier_phone,
)
from tools.supply_form_token import build_order_form_url
from tools.supply_whatsapp import send_supply_text, send_supply_buttons

logger = logging.getLogger(__name__)

_MENU_ACTIONS = frozenset({'PLACE_ORDER', 'CHECK_BALANCE', 'ORDER_STATUS', 'RECORD_PAYMENT'})

# ── Intent patterns ───────────────────────────────────────────────────────────

_BALANCE_RE = re.compile(
    r'\b(balance|outstanding|baaki|due|kitna|how much|owe|amount due)\b',
    re.IGNORECASE
)

_ORDER_STATUS_RE = re.compile(
    r'\b(order status|last order|my order|kya order|order hua|delivery status)\b',
    re.IGNORECASE
)

_PLACE_ORDER_RE = re.compile(
    r'\b(place order|order now|order form|want to order|new order|webcart)\b',
    re.IGNORECASE
)

# Payment: "paid 5000", "sent ₹2000", "payment done 1500", "gpay 3000 ref 12345"
_PAYMENT_RE = re.compile(
    r'\b(paid|sent|payment|transfer|gpay|phonepe|upi|neft|bank|cash|bheja|diya)\b',
    re.IGNORECASE
)

# Amount extraction: ₹5000 or 5000 or 5,000
_AMOUNT_RE = re.compile(r'[₹rs\.]*\s*(\d[\d,]*)', re.IGNORECASE)

# UPI/ref number: alphanumeric 8-24 chars that looks like a txn ID
_REF_RE = re.compile(r'\b([A-Z0-9]{8,24})\b')

# Payment method keywords
_METHOD_MAP = {
    'gpay':    'upi', 'google pay': 'upi', 'phonepe': 'upi', 'paytm': 'upi',
    'upi':     'upi', 'neft': 'bank', 'imps': 'bank', 'rtgs': 'bank',
    'bank':    'bank', 'transfer': 'bank', 'cash': 'cash',
    'cheque':  'cheque', 'check': 'cheque',
}

_GREETING_RE = re.compile(r'^(hi|hello|hey|hii|namaste)\b', re.IGNORECASE)
_SUPPLY_KEYWORD_RE = re.compile(r'\bfnb\b', re.IGNORECASE)


def _is_supply_greeting(text: str) -> bool:
    """True for Hi / Hi fnb and other bare supply entry phrases."""
    cleaned = (text or '').strip()
    if not cleaned:
        return False
    lower = cleaned.lower()
    if lower in {'hi', 'hello', 'hey', 'fnb'}:
        return True
    if _GREETING_RE.match(lower):
        return True
    return bool(_SUPPLY_KEYWORD_RE.search(lower))


async def _dispatch_supply_action(
    action: str,
    phone: str,
    supplier_id: str,
    client_id: str,
    session: dict,
    text: str = '',
) -> None:
    action = (action or '').strip().upper()
    if action == 'PLACE_ORDER':
        await _handle_place_order(phone, supplier_id, client_id, session)
    elif action == 'CHECK_BALANCE':
        await _handle_balance(phone, supplier_id, client_id, session)
    elif action == 'ORDER_STATUS':
        await _handle_order_status(phone, supplier_id, client_id, session)
    elif action == 'RECORD_PAYMENT':
        session['_state'] = 'awaiting_payment_details'
        await send_supply_text(
            phone,
            "Please share the payment amount and reference "
            '(e.g. "Paid ₹5000 GPay ref 123456789").',
            supplier_id,
            client_id,
        )
    elif action:
        await _handle_fallback(phone, supplier_id, client_id, session)


# ── Main entry point ──────────────────────────────────────────────────────────

async def handle_supply_message(
    phone:           str,
    supplier_id:     str,
    client_id:       Optional[str],
    message:         str,
    message_type:    str = 'text',
    raw_message_obj: dict = None,
) -> None:
    """
    Route an incoming supply client message to the correct intent handler.
    All DB I/O and WA sends happen here.
    """
    raw_message_obj = raw_message_obj or {}

    # ── Unregistered client ───────────────────────────────────────────────────
    if not client_id or client_id == supplier_id:
        client = await get_client_by_phone(supplier_id, phone)
        if client:
            client_id = client['id']
        else:
            client_id = None

    if not client_id:
        logger.info(f"[supply-agent] Unknown number {phone} for supplier {supplier_id}")
        await send_supply_text(
            phone       = phone,
            message     = "Hi! Your number isn't registered with us yet. "
                          "Please contact your supplier to get set up. 🙏",
            supplier_id = supplier_id,
            client_id   = None,
        )
        # Alert supplier so they can onboard this client
        try:
            supplier_phone = await get_supplier_phone(supplier_id)
            if supplier_phone:
                await send_supply_text(
                    phone=supplier_phone,
                    message=(
                        f"Unregistered WhatsApp number tried to message you:\n"
                        f"*{phone}*\n\n"
                        f"Add them under Clients in the dashboard to onboard."
                    ),
                    supplier_id=supplier_id,
                    client_id=None,
                )
        except Exception as exc:
            logger.warning(f"[supply-agent] supplier notify for unknown phone failed: {exc}")
        return

    # ── Load session ──────────────────────────────────────────────────────────
    session = await get_supply_session(supplier_id, phone)

    # ── Handle button reply IDs from previous message ─────────────────────────
    if message_type == 'interactive':
        reply_id = (
            raw_message_obj.get('interactive', {})
                           .get('button_reply', {})
                           .get('id', '')
        )
        if reply_id.startswith('CONFIRM_PAYMENT:'):
            await _handle_payment_confirmation(
                phone, supplier_id, client_id, session, reply_id
            )
            await save_supply_session(supplier_id, phone, client_id, session)
            return
        if reply_id == 'CANCEL_PAYMENT':
            session['_state'] = 'idle'
            await send_supply_text(
                phone, "Payment claim cancelled. Let us know if you need anything else.",
                supplier_id, client_id
            )
            await save_supply_session(supplier_id, phone, client_id, session)
            return
        if reply_id in _MENU_ACTIONS:
            await _dispatch_supply_action(
                reply_id, phone, supplier_id, client_id, session
            )
            await save_supply_session(supplier_id, phone, client_id, session)
            return

    # ── Intent detection ──────────────────────────────────────────────────────
    text = message.strip()

    if text.upper() in _MENU_ACTIONS:
        await _dispatch_supply_action(text, phone, supplier_id, client_id, session, text)

    elif _is_supply_greeting(text):
        await _handle_fallback(phone, supplier_id, client_id, session)

    elif _PLACE_ORDER_RE.search(text):
        await _handle_place_order(phone, supplier_id, client_id, session)

    elif _BALANCE_RE.search(text):
        await _handle_balance(phone, supplier_id, client_id, session)

    elif session.get('_state') == 'awaiting_payment_details' or _PAYMENT_RE.search(text):
        await _handle_payment(phone, supplier_id, client_id, session, text)

    elif _ORDER_STATUS_RE.search(text):
        await _handle_order_status(phone, supplier_id, client_id, session)

    else:
        await _handle_fallback(phone, supplier_id, client_id, session)

    await save_supply_session(supplier_id, phone, client_id, session)


# ── Intent handlers ───────────────────────────────────────────────────────────

async def _handle_place_order(
    phone: str, supplier_id: str, client_id: str, session: dict
) -> None:
    """Mint a signed /s/:token webcart link and send it over WhatsApp."""
    session['_state'] = 'idle'
    try:
        order_url = await build_order_form_url(supplier_id, client_id)
    except Exception as exc:
        logger.error(f'[supply-agent] place_order token failed: {exc}', exc_info=True)
        await send_supply_text(
            phone,
            "Sorry, we couldn't generate your order link right now. "
            "Please try again in a moment or ask your supplier to resend it.",
            supplier_id,
            client_id,
        )
        return

    await send_supply_text(
        phone,
        "Here's your order form — tap the link to reserve stock for the next delivery:\n\n"
        f"{order_url}\n\n"
        "This link is valid until tonight's ordering cutoff.",
        supplier_id,
        client_id,
    )
    try:
        await log_supply_notification(
            supplier_id=supplier_id,
            client_id=client_id,
            phone=phone,
            template_name='supply_order_link',
            status='sent',
            payload={'order_form_url': order_url, 'source': 'whatsapp_agent'},
        )
    except Exception as exc:
        logger.warning(f'[supply-agent] log_supply_notification failed: {exc}')


async def _handle_balance(
    phone: str, supplier_id: str, client_id: str, session: dict
) -> None:
    """Reply with current outstanding balance from credit ledger."""
    balance = await get_client_outstanding(supplier_id, client_id)
    session['_state'] = 'idle'

    if balance <= 0:
        msg = "✅ Great news — you have no outstanding balance with us right now!"
    else:
        msg = (
            f"Your current outstanding balance is *₹{balance:,.2f}*.\n\n"
            f"To record a payment, just send the amount and payment details "
            f"(e.g. \"Paid ₹5000 GPay ref 123456789\")."
        )

    await send_supply_text(phone, msg, supplier_id, client_id)


async def _handle_payment(
    phone: str, supplier_id: str, client_id: str, session: dict, text: str
) -> None:
    """
    Parse a payment claim from the message text.
    Extracts amount, method, and reference, then asks for confirmation.
    """
    # Extract amount
    amounts = _AMOUNT_RE.findall(text)
    amount  = float(amounts[0].replace(',', '')) if amounts else None

    if not amount or amount <= 0:
        # No amount found — ask
        session['_state'] = 'awaiting_payment_details'
        await send_supply_text(
            phone,
            "Got it — you're recording a payment. "
            "Please share the amount and payment reference "
            "(e.g. \"₹5000 GPay ref 123456789\").",
            supplier_id, client_id,
        )
        return

    # Extract method
    method = 'upi'  # default
    text_lower = text.lower()
    for keyword, mapped in _METHOD_MAP.items():
        if keyword in text_lower:
            method = mapped
            break

    # Extract reference (UPI txn ID, cheque no, etc.)
    # Exclude pure number strings that look like phone numbers or amounts
    refs = [
        r for r in _REF_RE.findall(text.upper())
        if not r.isdigit() and len(r) >= 8
    ]
    reference = refs[0] if refs else None

    # Store pending claim in session for confirmation
    session['_pending_payment'] = {
        'amount':    amount,
        'method':    method,
        'reference': reference,
        'raw':       text,
    }
    session['_state'] = 'awaiting_payment_confirm'

    method_label = {'upi': 'UPI', 'bank': 'Bank transfer', 'cash': 'Cash', 'cheque': 'Cheque'}.get(method, method.upper())
    ref_line     = f"\nRef: `{reference}`" if reference else ""
    confirm_msg  = (
        f"Recording a payment of *₹{amount:,.2f}* via {method_label}.{ref_line}\n\n"
        f"Is this correct?"
    )

    await send_supply_buttons(
        phone       = phone,
        body        = confirm_msg,
        buttons     = [
            {'id': 'CONFIRM_PAYMENT:yes', 'title': '✅ Yes, confirm'},
            {'id': 'CANCEL_PAYMENT',      'title': '❌ Cancel'},
        ],
        supplier_id = supplier_id,
        client_id   = client_id,
    )


async def _handle_payment_confirmation(
    phone: str, supplier_id: str, client_id: str, session: dict, reply_id: str
) -> None:
    """Commit the pending payment claim after client confirms."""
    pending = session.pop('_pending_payment', None)
    session['_state'] = 'idle'

    if not pending:
        await send_supply_text(
            phone, "Couldn't find a pending payment to confirm. Please resend the details.",
            supplier_id, client_id
        )
        return

    claim = await create_payment_claim(
        supplier_id    = supplier_id,
        client_id      = client_id,
        claimed_amount = pending['amount'],
        method         = pending['method'],
        reference      = pending['reference'],
        raw_message    = pending['raw'],
    )

    if claim:
        await send_supply_text(
            phone,
            f"✅ Payment of *₹{pending['amount']:,.2f}* recorded successfully!\n"
            f"Your supplier will verify and update your account shortly.",
            supplier_id, client_id,
        )
        logger.info(
            f"[supply-agent] Payment claim created: {claim.get('id')} "
            f"supplier={supplier_id} client={client_id} amount={pending['amount']}"
        )
    else:
        await send_supply_text(
            phone,
            "Sorry, we couldn't record your payment right now. Please try again "
            "or contact your supplier directly.",
            supplier_id, client_id,
        )


async def _handle_order_status(
    phone: str, supplier_id: str, client_id: str, session: dict
) -> None:
    """Return the last order's status and total."""
    session['_state'] = 'idle'

    try:
        order = await get_last_supply_order(supplier_id, client_id)
    except Exception as e:
        logger.error(f'[supply-agent] order status fetch failed: {e}')
        order = None

    if not order:
        msg = "No recent orders found. Tap *Order* to open your order form."
    else:
        status_labels = {
            'requested':           '⏳ Reservation submitted — pending confirmation',
            'confirmed':           '✅ Confirmed — will be delivered soon',
            'out_for_delivery':    '🚚 Out for delivery',
            'delivered':           '✅ Delivered',
            'partially_delivered': '⚠️ Partially delivered',
        }
        status_label = status_labels.get(order['status'], order['status'].replace('_', ' ').title())
        msg = (
            f"*Order {order['order_number']}*\n"
            f"Delivery: {order['delivery_date']}\n"
            f"Status: {status_label}\n"
            f"Total: ₹{float(order['total_amount'] or 0):,.2f}"
        )

    await send_supply_text(phone, msg, supplier_id, client_id)


async def _handle_fallback(
    phone: str, supplier_id: str, client_id: str, session: dict
) -> None:
    """
    Catch-all: send quick-reply buttons for the most common actions.
    Keeps the bot useful even when intent detection doesn't match.
    """
    session['_state'] = 'idle'

    await send_supply_buttons(
        phone   = phone,
        body    = "Hi! Welcome to Munafe Supply. How can I help you today?",
        buttons = [
            {'id': 'PLACE_ORDER',     'title': '📦 Order'},
            {'id': 'CHECK_BALANCE',   'title': '💰 My Balance'},
            {'id': 'RECORD_PAYMENT',  'title': '💳 Record Payment'},
        ],
        supplier_id = supplier_id,
        client_id   = client_id,
        footer      = "Reply with your question or tap an option above.",
    )
