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
#   5. NLP_ORDER    → free-text order parse (feature-flagged per supplier)
#   6. FALLBACK     → main menu buttons
#
# Language: preferred_language on supply_clients (en/hi/bn/mr/te/ta). Detected
# from Unicode script on free-text; replies/buttons come from locales/supply.
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

import base64
import json
import logging
import re
import uuid
from typing import Optional

from db.queries import (
    get_client_by_phone,
    get_client_preferred_language,
    get_supply_session,
    save_supply_session,
    get_client_outstanding,
    create_payment_claim,
    log_supply_notification,
    get_last_supply_order,
    get_supplier_phone,
    update_client_preferred_language,
)
from locales.supply import reply
from tools.supply_form_token import build_order_form_url
from tools.supply_language import resolve_language
from tools.supply_whatsapp import send_supply_text, send_supply_buttons

logger = logging.getLogger(__name__)

_MENU_ACTIONS = frozenset({'PLACE_ORDER', 'CHECK_BALANCE', 'ORDER_STATUS', 'RECORD_PAYMENT'})
_NLP_EDIT_CANCEL = frozenset({'EDIT_ORDER', 'CANCEL_ORDER'})

# ── Intent patterns (English / transliteration + native scripts) ──────────────

_BALANCE_RE = re.compile(
    r'(?i)\b(balance|outstanding|baaki|due|kitna|how much|owe|amount due)\b'
    '|\u092c\u093e\u0915\u0940|\u092c\u0915\u093e\u092f\u093e|\u0915\u093f\u0924\u0928\u093e|\u0915\u093f\u0924\u0928\u0947|\u09ac\u09be\u0995\u09bf|\u09ac\u09cd\u09af\u09be\u09b2\u09c7\u09a8\u09cd\u09b8|\u0995\u09a4|\u09ac\u0995\u09c7\u09df\u09be|\u0915\u093f\u0924\u0940|\u0925\u0915\u092c\u093e\u0915\u0940|\u092c\u0950\u0932\u0928\u094d\u0938|\u0c2c\u0c4d\u0c2f\u0c3e\u0c32\u0c46\u0c28\u0c4d\u0c38\u0c4d|\u0c2c\u0c3e\u0c15\u0c40|\u0c0e\u0c02\u0c24|\u0bae\u0bc0\u0ba4\u0bbf|\u0baa\u0bc7\u0bb2\u0ba9\u0bcd\u0bb8\u0bcd|\u0b8e\u0bb5\u0bcd\u0bb5\u0bb3\u0bb5\u0bc1|\u0ba8\u0bbf\u0bb2\u0bc1\u0bb5\u0bc8'
)

_ORDER_STATUS_RE = re.compile(
    r'(?i)\b(order status|last order|my order|kya order|order hua|delivery status)\b'
    '|\u0911\u0930\u094d\u0921\u0930 \u0938\u094d\u091f\u0947\u091f\u0938|\u0906\u0916\u093f\u0930\u0940 \u0911\u0930\u094d\u0921\u0930|\u0921\u093f\u0932\u0940\u0935\u0930\u0940 \u0938\u094d\u091f\u0947\u091f\u0938|\u0911\u0930\u094d\u0921\u0930 \u0915\u0939\u093e\u0901|\u0985\u09b0\u09cd\u09a1\u09be\u09b0 \u09b8\u09cd\u099f\u09cd\u09af\u09be\u099f\u09be\u09b8|\u09a1\u09c7\u09b2\u09bf\u09ad\u09be\u09b0\u09bf \u09b8\u09cd\u099f\u09cd\u09af\u09be\u099f\u09be\u09b8|\u09b6\u09c7\u09b7 \u0985\u09b0\u09cd\u09a1\u09be\u09b0|\u0911\u0930\u094d\u0921\u0930 \u0938\u094d\u0925\u093f\u0924\u0940|\u0936\u0947\u0935\u091f\u091a\u093e \u0911\u0930\u094d\u0921\u0930|\u0921\u093f\u0932\u093f\u0935\u094d\u0939\u0930\u0940 \u0938\u094d\u0925\u093f\u0924\u0940|\u0c06\u0c30\u0c4d\u0c21\u0c30\u0c4d \u0c38\u0c4d\u0c1f\u0c47\u0c1f\u0c38\u0c4d|\u0c21\u0c46\u0c32\u0c3f\u0c35\u0c30\u0c40 \u0c38\u0c4d\u0c1f\u0c47\u0c1f\u0c38\u0c4d|\u0c1a\u0c3f\u0c35\u0c30\u0c3f \u0c06\u0c30\u0c4d\u0c21\u0c30\u0c4d|\u0b86\u0bb0\u0bcd\u0b9f\u0bb0\u0bcd \u0ba8\u0bbf\u0bb2\u0bc8|\u0b9f\u0bc6\u0bb2\u0bbf\u0bb5\u0bb0\u0bbf \u0ba8\u0bbf\u0bb2\u0bc8|\u0b95\u0b9f\u0bc8\u0b9a\u0bbf \u0b86\u0bb0\u0bcd\u0b9f\u0bb0\u0bcd'
)

_PLACE_ORDER_RE = re.compile(
    r'(?i)\b(place order|order now|order form|want to order|new order|webcart)\b'
    r'|नया ऑर्डर|ऑर्डर फॉर्म|ऑर्डर करना'
    r'|নতুন অর্ডার|অর্ডার ফর্ম|অর্ডার করতে'
    r'|नवीन ऑर्डर|ऑर्डर फॉर्म|ऑर्डर करायच'
    r'|కొత్త ఆర్డర్|ఆర్డర్ ఫారం|ఆర్డర్ చేయాలి'
    r'|புதிய ஆர்டர்|ஆர்டர் படிவம்|ஆர்டர் செய்ய'
)

# Payment: "paid 5000", "sent ₹2000", "payment done 1500", "gpay 3000 ref 12345"
_PAYMENT_RE = re.compile(
    r'(?i)\b(paid|sent|payment|transfer|gpay|phonepe|upi|neft|bank|cash|bheja|diya)\b'
    r'|भुगतान|पेमेंट|भेजा|दिया|भेज दिया|पे किया'
    r'|পেমেন্ট|পাঠিয়েছি|দিয়েছি|টাকা পাঠা'
    r'|पेमेंट|पाठवले|दिले|भरले'
    r'|పేమెంట్|చెల్లించా|పంపాను|బదిలీ'
    r'|பேமெண்ட்|அனுப்பினேன்|செலுத்தினேன்|பணம் அனுப்பி'
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

_GREETING_RE = re.compile(
    r'(?i)^(hi|hello|hey|hii|namaste|namaskar)\b'
    r'|^नमस्ते|^नमस्कार|^নমস্কার|^হ্যালো|^నమస్కారం|^వందనం|^வணக்கம்'
)
_SUPPLY_KEYWORD_RE = re.compile(r'(?i)\bfnb\b')


def _lang(session: dict) -> str:
    return session.get('lang') or 'en'


def _fmt_money(value: float) -> str:
    return f'{float(value):,.2f}'


def _method_label(lang: str, method: str) -> str:
    key = {
        'upi': 'method_upi',
        'bank': 'method_bank',
        'cash': 'method_cash',
        'cheque': 'method_cheque',
    }.get(method, 'method_upi')
    return reply(lang, key)


def _is_supply_greeting(text: str) -> bool:
    """True for Hi / Hi fnb and other bare supply entry phrases."""
    cleaned = (text or '').strip()
    if not cleaned:
        return False
    lower = cleaned.lower()
    if lower in {'hi', 'hello', 'hey', 'fnb'}:
        return True
    if _GREETING_RE.match(cleaned):
        return True
    return bool(_SUPPLY_KEYWORD_RE.search(lower))


async def _resolve_client_lang(
    session: dict,
    client_id: str,
    text: str,
    *,
    detect: bool,
) -> str:
    """
    Resolve reply language for this turn; persist overrides on the client row.
    Button taps pass detect=False (no script signal).
    """
    stored = session.get('lang')
    if not stored:
        stored = await get_client_preferred_language(client_id)

    if detect:
        lang, changed = resolve_language(stored, text)
    else:
        from tools.supply_language import normalize_lang
        lang, changed = normalize_lang(stored), False

    session['lang'] = lang
    if changed:
        await update_client_preferred_language(client_id, lang)
    return lang


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
            reply(_lang(session), 'ask_payment_details'),
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
            message     = reply('en', 'unregistered'),
            supplier_id = supplier_id,
            client_id   = None,
        )
        # Alert supplier so they can onboard this client (always English)
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
        await _resolve_client_lang(session, client_id, '', detect=False)
        if reply_id.startswith('CONFIRM_PAYMENT:'):
            await _handle_payment_confirmation(
                phone, supplier_id, client_id, session, reply_id
            )
            await save_supply_session(supplier_id, phone, client_id, session)
            return
        if reply_id == 'CANCEL_PAYMENT':
            session['_state'] = 'idle'
            await send_supply_text(
                phone, reply(_lang(session), 'payment_cancelled'),
                supplier_id, client_id
            )
            await save_supply_session(supplier_id, phone, client_id, session)
            return
        if reply_id.startswith('CONFIRM_NLP_ORDER:'):
            await _handle_nlp_order_confirmation(
                phone, supplier_id, client_id, session, reply_id
            )
            await save_supply_session(supplier_id, phone, client_id, session)
            return
        if reply_id in _NLP_EDIT_CANCEL:
            await _handle_nlp_order_edit_or_cancel(
                phone, supplier_id, client_id, session, reply_id
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
    await _resolve_client_lang(session, client_id, text, detect=True)

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

    elif await _try_handle_nlp_order(phone, supplier_id, client_id, session, text):
        pass  # handled

    else:
        await _handle_fallback(phone, supplier_id, client_id, session)

    await save_supply_session(supplier_id, phone, client_id, session)


# ── Intent handlers ───────────────────────────────────────────────────────────

async def _handle_place_order(
    phone: str, supplier_id: str, client_id: str, session: dict
) -> None:
    """Mint a signed /s/:token webcart link and send it over WhatsApp."""
    session['_state'] = 'idle'
    lang = _lang(session)
    try:
        order_url = await build_order_form_url(supplier_id, client_id)
    except Exception as exc:
        logger.error(f'[supply-agent] place_order token failed: {exc}', exc_info=True)
        await send_supply_text(
            phone,
            reply(lang, 'order_link_error'),
            supplier_id,
            client_id,
        )
        return

    await send_supply_text(
        phone,
        reply(lang, 'order_link', order_url=order_url),
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
    lang = _lang(session)

    if balance <= 0:
        msg = reply(lang, 'balance_zero')
    else:
        msg = reply(lang, 'balance_due', balance=_fmt_money(balance))

    await send_supply_text(phone, msg, supplier_id, client_id)


async def _handle_payment(
    phone: str, supplier_id: str, client_id: str, session: dict, text: str
) -> None:
    """
    Parse a payment claim from the message text.
    Extracts amount, method, and reference, then asks for confirmation.
    """
    lang = _lang(session)

    # Extract amount
    amounts = _AMOUNT_RE.findall(text)
    amount  = float(amounts[0].replace(',', '')) if amounts else None

    if not amount or amount <= 0:
        # No amount found — ask
        session['_state'] = 'awaiting_payment_details'
        await send_supply_text(
            phone,
            reply(lang, 'ask_payment_details_got_it'),
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

    # Store pending claim in session AND encode in the button id so confirm
    # still works if supply_conversation_states upsert fails / returns a stale row.
    pending = {
        'amount':    amount,
        'method':    method,
        'reference': reference,
        'raw':       text,
    }
    session['_pending_payment'] = pending
    session['_state'] = 'awaiting_payment_confirm'

    method_label = _method_label(lang, method)
    ref_line     = f"\nRef: `{reference}`" if reference else ""
    confirm_msg  = reply(
        lang,
        'payment_confirm_body',
        amount=_fmt_money(amount),
        method_label=method_label,
        ref_line=ref_line,
    )

    await send_supply_buttons(
        phone       = phone,
        body        = confirm_msg,
        buttons     = [
            {
                'id': _encode_payment_confirm_id(pending),
                'title': reply(lang, 'btn_confirm_yes'),
            },
            {'id': 'CANCEL_PAYMENT', 'title': reply(lang, 'btn_confirm_cancel')},
        ],
        supplier_id = supplier_id,
        client_id   = client_id,
    )


def _encode_payment_confirm_id(pending: dict) -> str:
    """Pack claim fields into the WhatsApp button id (max 256 chars)."""
    payload = {
        'a': pending.get('amount'),
        'm': pending.get('method') or 'upi',
        'r': pending.get('reference'),
        'raw': (pending.get('raw') or '')[:80],
    }
    token = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(',', ':')).encode('utf-8')
    ).decode('ascii').rstrip('=')
    return f'CONFIRM_PAYMENT:{token}'[:256]


def _decode_payment_confirm_id(reply_id: str) -> Optional[dict]:
    """Recover pending payment from CONFIRM_PAYMENT:* button id."""
    if not reply_id or not reply_id.startswith('CONFIRM_PAYMENT:'):
        return None
    token = reply_id[len('CONFIRM_PAYMENT:'):].strip()
    if not token or token.lower() == 'yes':
        return None
    try:
        pad = '=' * (-len(token) % 4)
        data = json.loads(base64.urlsafe_b64decode(token + pad).decode('utf-8'))
        amount = float(data.get('a'))
        if amount <= 0:
            return None
        return {
            'amount':    amount,
            'method':    (data.get('m') or 'upi'),
            'reference': data.get('r') or None,
            'raw':       data.get('raw') or f'confirmed:{amount}',
        }
    except Exception as exc:
        logger.warning(f'[supply-agent] bad CONFIRM_PAYMENT token: {exc}')
        return None


async def _handle_payment_confirmation(
    phone: str, supplier_id: str, client_id: str, session: dict, reply_id: str
) -> None:
    """Commit the pending payment claim after client confirms."""
    pending = session.pop('_pending_payment', None) or _decode_payment_confirm_id(reply_id)
    session['_state'] = 'idle'
    lang = _lang(session)

    if not pending:
        await send_supply_text(
            phone, reply(lang, 'payment_no_pending'),
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
            reply(lang, 'payment_recorded', amount=_fmt_money(pending['amount'])),
            supplier_id, client_id,
        )
        logger.info(
            f"[supply-agent] Payment claim created: {claim.get('id')} "
            f"supplier={supplier_id} client={client_id} amount={pending['amount']}"
        )
    else:
        await send_supply_text(
            phone,
            reply(lang, 'payment_record_error'),
            supplier_id, client_id,
        )


async def _handle_order_status(
    phone: str, supplier_id: str, client_id: str, session: dict
) -> None:
    """Return the last order's status and total."""
    session['_state'] = 'idle'
    lang = _lang(session)

    try:
        order = await get_last_supply_order(supplier_id, client_id)
    except Exception as e:
        logger.error(f'[supply-agent] order status fetch failed: {e}')
        order = None

    if not order:
        msg = reply(lang, 'order_none')
    else:
        status_key = f"status_{order['status']}"
        status_label = reply(lang, status_key)
        if status_label == status_key:
            status_label = order['status'].replace('_', ' ').title()
        msg = reply(
            lang,
            'order_status_line',
            order_number=order['order_number'],
            delivery_date=order['delivery_date'],
            status_label=status_label,
            total_amount=_fmt_money(float(order['total_amount'] or 0)),
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
    lang = _lang(session)

    await send_supply_buttons(
        phone   = phone,
        body    = reply(lang, 'menu_body'),
        buttons = [
            {'id': 'PLACE_ORDER',     'title': reply(lang, 'btn_order')},
            {'id': 'CHECK_BALANCE',   'title': reply(lang, 'btn_balance')},
            {'id': 'RECORD_PAYMENT',  'title': reply(lang, 'btn_payment')},
        ],
        supplier_id = supplier_id,
        client_id   = client_id,
        footer      = reply(lang, 'menu_footer'),
    )


# ── Free-text NLP order (feature-flagged, B2B Supply only) ────────────────────

async def _try_handle_nlp_order(
    phone: str,
    supplier_id: str,
    client_id: str,
    session: dict,
    text: str,
) -> bool:
    """
    Attempt free-text order parse. Returns True if this path handled the
    message (including partial/no-match replies). Returns False so the
    caller can fall through to _handle_fallback when the feature is off
    or the message does not look like an order.
    """
    from agents.supply.nlp_order_parser import (
        is_nlp_order_enabled,
        looks_like_order,
        parse_supply_order_text,
    )
    from agents.supply.nlp_api import log_nlp_parse, preview_nlp_prices

    if not await is_nlp_order_enabled(supplier_id):
        return False
    if not looks_like_order(text):
        return False

    lang = _lang(session)
    parse_result = await parse_supply_order_text(text, supplier_id, client_id)
    draft_id = uuid.uuid4().hex[:12]

    await log_nlp_parse(
        supplier_id,
        client_id,
        raw_text=text,
        parsed_output=parse_result.to_dict(),
        unmatched=parse_result.unmatched,
        confidence_avg=parse_result.avg_confidence,
        outcome='parsed' if parse_result.all_high_confidence else (
            'partial' if parse_result.matched else 'no_match'
        ),
        draft_id=draft_id,
        phone=phone,
    )
    try:
        await log_supply_notification(
            supplier_id=supplier_id,
            client_id=client_id,
            phone=phone,
            template_name='nlp_order_parse',
            status='logged',
            payload={
                'draft_id': draft_id,
                'raw_text': text,
                'parsed': parse_result.to_dict(),
                'avg_confidence': parse_result.avg_confidence,
            },
        )
    except Exception as exc:
        logger.warning('[supply-agent] nlp parse notification log failed: %s', exc)

    # Partial / unmatched → explain + webcart fallback (do not force broken order)
    if not parse_result.all_high_confidence:
        understood_lines = []
        for m in parse_result.matched:
            understood_lines.append(
                f"• {m.quantity:g} {m.unit or ''} {m.matched_name or m.raw_segment}".strip()
            )
        unclear = list(parse_result.unmatched)
        for amb in parse_result.ambiguous:
            names = ', '.join(
                c.get('name') or c.get('id') for c in (amb.get('candidates') or [])[:3]
            )
            unclear.append(f"{amb.get('segment')} → {names}")

        understood_block = (
            '\n'.join(understood_lines)
            if understood_lines
            else reply(lang, 'nlp_none_understood')
        )
        unclear_block = (
            '\n'.join(f"• {u}" for u in unclear)
            if unclear
            else reply(lang, 'nlp_none_unclear')
        )

        try:
            order_url = await build_order_form_url(supplier_id, client_id)
        except Exception as exc:
            logger.error('[supply-agent] nlp partial webcart link failed: %s', exc)
            order_url = ''

        body = reply(
            lang,
            'nlp_partial_body',
            understood=understood_block,
            unclear=unclear_block,
            order_url=order_url or '—',
        )
        await send_supply_text(phone, body, supplier_id, client_id)
        session['_state'] = 'idle'
        return True

    # High-confidence full match → price via resolvePrice (Node) + confirm buttons
    price_items = [
        {'item_id': m.catalog_item_id, 'qty': m.quantity}
        for m in parse_result.matched
    ]
    priced = await preview_nlp_prices(supplier_id, client_id, price_items)
    if not priced or not priced.get('lines'):
        await send_supply_text(
            phone, reply(lang, 'nlp_price_error'), supplier_id, client_id
        )
        session['_state'] = 'idle'
        return True

    bad = [ln for ln in priced['lines'] if ln.get('error')]
    good = [ln for ln in priced['lines'] if not ln.get('error')]
    if bad or not good:
        await send_supply_text(
            phone, reply(lang, 'nlp_price_error'), supplier_id, client_id
        )
        session['_state'] = 'idle'
        return True

    line_text = '\n'.join(
        f"• {ln['qty']:g} {ln['unit']} {ln['name']} — ₹{_fmt_money(ln['line_total'])}"
        for ln in good
    )
    confirm_body = reply(
        lang,
        'nlp_confirm_body',
        lines=line_text,
        total=_fmt_money(float(priced.get('total_amount') or 0)),
    )

    session['_pending_nlp_order'] = {
        'draft_id': draft_id,
        'raw_text': text,
        'items': [
            {'item_id': ln['item_id'], 'qty': ln['qty']}
            for ln in good
        ],
        'total_amount': float(priced.get('total_amount') or 0),
        'lines': good,
    }
    session['_state'] = 'awaiting_nlp_order_confirm'

    await send_supply_buttons(
        phone=phone,
        body=confirm_body,
        buttons=[
            {
                'id': f'CONFIRM_NLP_ORDER:{draft_id}',
                'title': reply(lang, 'btn_nlp_confirm'),
            },
            {'id': 'EDIT_ORDER', 'title': reply(lang, 'btn_nlp_edit')},
            {'id': 'CANCEL_ORDER', 'title': reply(lang, 'btn_nlp_cancel')},
        ],
        supplier_id=supplier_id,
        client_id=client_id,
    )
    return True


async def _handle_nlp_order_confirmation(
    phone: str,
    supplier_id: str,
    client_id: str,
    session: dict,
    reply_id: str,
) -> None:
    """Commit pending NLP draft after explicit CONFIRM_NLP_ORDER:<draft_id>."""
    from agents.supply.nlp_api import confirm_nlp_order, log_nlp_parse

    lang = _lang(session)
    pending = session.pop('_pending_nlp_order', None)
    session['_state'] = 'idle'

    draft_from_btn = reply_id.split(':', 1)[1] if ':' in reply_id else ''
    if not pending or (draft_from_btn and pending.get('draft_id') != draft_from_btn):
        await send_supply_text(
            phone, reply(lang, 'nlp_no_pending'), supplier_id, client_id
        )
        return

    result = await confirm_nlp_order(
        supplier_id,
        client_id,
        pending['items'],
        draft_id=pending.get('draft_id'),
        notes='whatsapp_nlp',
    )

    if not result or result.get('_error'):
        await log_nlp_parse(
            supplier_id,
            client_id,
            raw_text=pending.get('raw_text') or '',
            parsed_output={'items': pending.get('items')},
            unmatched=[],
            confidence_avg=1.0,
            outcome='confirm_failed',
            draft_id=pending.get('draft_id'),
            phone=phone,
        )
        err = (result or {}).get('error') or reply(lang, 'nlp_confirm_failed')
        if (result or {}).get('code') == 'CREDIT_LIMIT_EXCEEDED':
            err = reply(lang, 'nlp_credit_blocked')
        await send_supply_text(phone, err, supplier_id, client_id)
        return

    order = result.get('order') or {}
    await log_nlp_parse(
        supplier_id,
        client_id,
        raw_text=pending.get('raw_text') or '',
        parsed_output={'items': pending.get('items'), 'order': order},
        unmatched=[],
        confidence_avg=1.0,
        outcome='confirmed',
        draft_id=pending.get('draft_id'),
        phone=phone,
        order_id=order.get('id'),
    )
    try:
        await log_supply_notification(
            supplier_id=supplier_id,
            client_id=client_id,
            phone=phone,
            template_name='nlp_order_confirmed',
            status='sent',
            payload={
                'draft_id': pending.get('draft_id'),
                'order_id': order.get('id'),
                'order_number': order.get('order_number'),
            },
        )
    except Exception as exc:
        logger.warning('[supply-agent] nlp confirm notification log failed: %s', exc)

    await send_supply_text(
        phone,
        reply(
            lang,
            'nlp_order_placed',
            order_number=order.get('order_number') or '—',
            delivery_date=order.get('delivery_date') or '—',
            total=_fmt_money(float(order.get('total_amount') or pending.get('total_amount') or 0)),
        ),
        supplier_id,
        client_id,
    )


async def _handle_nlp_order_edit_or_cancel(
    phone: str,
    supplier_id: str,
    client_id: str,
    session: dict,
    reply_id: str,
) -> None:
    from agents.supply.nlp_api import log_nlp_parse

    lang = _lang(session)
    pending = session.pop('_pending_nlp_order', None)
    session['_state'] = 'idle'
    outcome = 'edited' if reply_id == 'EDIT_ORDER' else 'cancelled'

    if pending:
        await log_nlp_parse(
            supplier_id,
            client_id,
            raw_text=pending.get('raw_text') or '',
            parsed_output={'items': pending.get('items')},
            unmatched=[],
            confidence_avg=1.0,
            outcome=outcome,
            draft_id=pending.get('draft_id'),
            phone=phone,
        )

    if reply_id == 'EDIT_ORDER':
        await send_supply_text(
            phone, reply(lang, 'nlp_edit_hint'), supplier_id, client_id
        )
        await _handle_place_order(phone, supplier_id, client_id, session)
        return

    await send_supply_text(
        phone, reply(lang, 'nlp_cancelled'), supplier_id, client_id
    )
