# chat/locales/customer/__init__.py
# Localized reply strings for the customer WhatsApp ordering agent.
# Add a language by creating <code>.py with a REPLIES dict and registering it below.

from __future__ import annotations

from . import en, ta

_CATALOGS: dict[str, dict[str, str]] = {
    "en": en.REPLIES,
    "ta": ta.REPLIES,
}

# Map conversation_intelligence language labels → locale codes.
_LANG_ALIASES: dict[str, str] = {
    "english": "en",
    "en": "en",
    "tamil": "ta",
    "ta": "ta",
    # Hinglish / mixed stay on English until hi catalog is added.
    "hinglish": "en",
    "mixed": "en",
    "hi": "en",
}


def normalize_lang(lang: str | None) -> str:
    raw = str(lang or "en").strip().lower()
    return _LANG_ALIASES.get(raw, "en")


def reply(lang: str | None, key: str, **kwargs) -> str:
    """Look up a reply template and format kwargs. Falls back to English, then key."""
    code = normalize_lang(lang)
    catalog = _CATALOGS.get(code) or _CATALOGS["en"]
    template = catalog.get(key) or _CATALOGS["en"].get(key) or key
    if not kwargs:
        return template
    try:
        return template.format(**kwargs)
    except (KeyError, ValueError):
        return template


def has_lang(lang: str | None) -> bool:
    return normalize_lang(lang) in _CATALOGS


def session_lang(session_state: dict | None) -> str:
    """Preferred language from session context (defaults to en)."""
    if not isinstance(session_state, dict):
        return "en"
    return normalize_lang(session_state.get("preferred_language"))


def apply_detected_language(session_state: dict, language: str | None) -> str:
    """Persist preferred_language on first confident non-English detection.

    English / mixed / hinglish do not overwrite an existing Tamil preference.
    Returns the locale code to use for this turn's outbound copy.
    """
    detected = normalize_lang(language)
    existing = normalize_lang(session_state.get("preferred_language"))

    # Sticky: once Tamil is set, keep it for the session.
    if existing == "ta":
        return "ta"

    # Only latch non-English when detection is confident Tamil.
    raw = str(language or "").strip().lower()
    if raw in ("tamil", "ta") and detected == "ta":
        session_state["preferred_language"] = "ta"
        return "ta"

    if not session_state.get("preferred_language"):
        session_state["preferred_language"] = "en"
    return existing or "en"
