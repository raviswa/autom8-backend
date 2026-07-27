# chat/locales/customer/__init__.py
# Localized reply strings for the customer WhatsApp ordering agent.
# Add a language by creating <code>.py with a REPLIES dict and registering it below.
#
# Tone rules (see glossary.py): warm, contemporary, e-commerce-friendly.
# Keep placeholders, bot commands (REPEAT/Home/Hi), and Confirm & Pay intact.
# Webcart HTML UI i18n is deferred to a future build.

from __future__ import annotations

import re

from . import bn, en, gu, hi, kn, ml, mr, ta, te
from .glossary import SERVICE_TYPE_LABELS_EN, STORAGE_LANGUAGE, SUPPORTED_LOCALES

_CATALOGS: dict[str, dict[str, str]] = {
    "en": en.REPLIES,
    "hi": hi.REPLIES,
    "ta": ta.REPLIES,
    "te": te.REPLIES,
    "kn": kn.REPLIES,
    "mr": mr.REPLIES,
    "ml": ml.REPLIES,
    "gu": gu.REPLIES,
    "bn": bn.REPLIES,
}

# Map conversation_intelligence language labels → locale codes.
_LANG_ALIASES: dict[str, str] = {
    "english": "en",
    "en": "en",
    "hindi": "hi",
    "hi": "hi",
    "hinglish": "hi",
    "tamil": "ta",
    "ta": "ta",
    "telugu": "te",
    "te": "te",
    "kannada": "kn",
    "kn": "kn",
    "marathi": "mr",
    "mr": "mr",
    "malayalam": "ml",
    "ml": "ml",
    "gujarati": "gu",
    "gujarathi": "gu",
    "gu": "gu",
    "bengali": "bn",
    "bangla": "bn",
    "bn": "bn",
    # Mixed / unknown stay English until a script latch or confident label arrives.
    "mixed": "en",
}

# Unique Indic scripts → locale. Devanagari defaults to Hindi (Marathi needs
# Gemini / explicit preference — both share the same script).
_SCRIPT_LATCH: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"[\u0B80-\u0BFF]"), "ta"),  # Tamil
    (re.compile(r"[\u0C00-\u0C7F]"), "te"),  # Telugu
    (re.compile(r"[\u0C80-\u0CFF]"), "kn"),  # Kannada
    (re.compile(r"[\u0D00-\u0D7F]"), "ml"),  # Malayalam
    (re.compile(r"[\u0A80-\u0AFF]"), "gu"),  # Gujarati
    (re.compile(r"[\u0980-\u09FF]"), "bn"),  # Bengali
    (re.compile(r"[\u0900-\u097F]"), "hi"),  # Devanagari → Hindi
]


def normalize_lang(lang: str | None) -> str:
    raw = str(lang or "en").strip().lower()
    mapped = _LANG_ALIASES.get(raw)
    if mapped:
        return mapped
    if raw in _CATALOGS:
        return raw
    return "en"


def reply(lang: str | None, key: str, **kwargs) -> str:
    """Look up a reply template and format kwargs. Falls back to English, then key.

    For customer-facing WhatsApp only. Never write reply() output into bookings,
    orders, KDS, or other persisted order-detail fields — those stay English
    (see STORAGE_LANGUAGE / reply_en / system_service_label).
    """
    code = normalize_lang(lang)
    catalog = _CATALOGS.get(code) or _CATALOGS["en"]
    template = catalog.get(key) or _CATALOGS["en"].get(key) or key
    if not kwargs:
        return template
    try:
        return template.format(**kwargs)
    except (KeyError, ValueError):
        return template


def reply_en(key: str, **kwargs) -> str:
    """Always resolve a template in English (storage / staff / system copy)."""
    return reply(STORAGE_LANGUAGE, key, **kwargs)


def system_service_label(service_type: str | None) -> str:
    """English display label for a service_type code (safe for DB / staff alerts)."""
    raw = str(service_type or "").strip().lower()
    if raw in SERVICE_TYPE_LABELS_EN:
        return SERVICE_TYPE_LABELS_EN[raw]
    if not raw:
        return "Order"
    return raw.replace("_", " ").strip().title() or "Order"


def customer_service_label(lang: str | None, service_type: str | None) -> str:
    """Localized display label for a service_type — customer WhatsApp copy only.

    Persisted fields must keep using system_service_label (English).
    """
    raw = str(service_type or "").strip().lower()
    key = f"svc_{raw}" if raw else "svc_order"
    code = normalize_lang(lang)
    catalog = _CATALOGS.get(code) or _CATALOGS["en"]
    if key in catalog:
        return catalog[key]
    return system_service_label(service_type)


def has_lang(lang: str | None) -> bool:
    return normalize_lang(lang) in _CATALOGS


def supported_locales() -> tuple[str, ...]:
    return SUPPORTED_LOCALES


def storage_language() -> str:
    """Canonical language for persisted order details."""
    return STORAGE_LANGUAGE


def session_lang(session_state: dict | None) -> str:
    """Preferred language from session context (defaults to en)."""
    if not isinstance(session_state, dict):
        return "en"
    return normalize_lang(session_state.get("preferred_language"))


def detect_script_locale(text: str | None) -> str | None:
    """Return a locale code when inbound text contains a known Indic script."""
    sample = text or ""
    for pattern, code in _SCRIPT_LATCH:
        if pattern.search(sample):
            return code
    return None


def contains_tamil_script(text: str | None) -> bool:
    """True when the message includes any Tamil Unicode letter/mark."""
    return detect_script_locale(text) == "ta"


# Latin openers that mean "switch back to English" on a *new* booking only.
_LATIN_LANG_SWITCH_RE = re.compile(
    r"^(?:"
    r"hi|hello|hey|hii|helo|hola|namaste|namaskar|vanakkam|vanakam|vankkam"
    r"|english|eng"
    r")\b",
    re.IGNORECASE,
)

# After receipt / visit end, the next customer message may pick a new language.
_LANGUAGE_RESET_STEPS = frozenset({
    None,
    "",
    "visit_complete",
    "awaiting_payment",
})


def is_latin_language_switch(text: str | None) -> bool:
    """True for Latin greetings / explicit English requests with no Indic script."""
    raw = (text or "").strip()
    if not raw or detect_script_locale(raw):
        return False
    normalized = re.sub(r"\s+", " ", raw.lower())
    match = _LATIN_LANG_SWITCH_RE.match(normalized)
    if not match:
        return False
    remainder = normalized[match.end():].strip()
    return len(remainder.split()) <= 2


def language_reset_allowed(session_state: dict | None) -> bool:
    """True when preferred_language may change (new booking / post-receipt).

    Mid-flow (menu → order → receipt) stays sticky so Hi/OK do not flip
    language until the current visit completes.
    """
    if not isinstance(session_state, dict):
        return True
    if not session_state.get("preferred_language"):
        return True
    step = session_state.get("booking_step")
    return step in _LANGUAGE_RESET_STEPS


def latch_indic_from_text(
    session_state: dict,
    text: str | None,
    *,
    allow_reset: bool | None = None,
) -> str:
    """Latch preferred_language from inbound script or (on new booking) Latin Hi.

    During an active booking flow language is sticky until visit_complete
    (after receipt). On the next booking opener, Indic script or Latin
    Hi/Hello/English may set a new preferred_language.
    """
    if not isinstance(session_state, dict):
        return "en"
    if allow_reset is None:
        allow_reset = language_reset_allowed(session_state)

    code = detect_script_locale(text)
    if code:
        return apply_detected_language(
            session_state, code, allow_switch=allow_reset,
        )
    if allow_reset and is_latin_language_switch(text):
        session_state["preferred_language"] = "en"
        return "en"
    return session_lang(session_state)


def latch_tamil_from_text(session_state: dict, text: str | None) -> str:
    """Backward-compatible alias for latch_indic_from_text."""
    return latch_indic_from_text(session_state, text)


def apply_detected_language(
    session_state: dict,
    language: str | None,
    *,
    allow_switch: bool = False,
) -> str:
    """Persist preferred_language from a confident language detection.

    By default English / mixed do not overwrite an existing non-English
    preference (so mid-flow stays sticky until receipt / visit_complete).
    When allow_switch is True (new booking opener), a different supported
    locale replaces the previous one.
    """
    detected = normalize_lang(language)
    existing = normalize_lang(session_state.get("preferred_language"))

    if allow_switch and detected in _CATALOGS and detected != "en":
        session_state["preferred_language"] = detected
        return detected

    # Sticky: once a supported local language is set, keep it unless switched.
    if existing in _CATALOGS and existing != "en":
        return existing

    if detected in _CATALOGS and detected != "en":
        session_state["preferred_language"] = detected
        return detected

    if not session_state.get("preferred_language"):
        session_state["preferred_language"] = "en"
    return existing or "en"
