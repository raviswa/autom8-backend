# chat/tools/supply_language.py
# ============================================================================
# Detect client language from Unicode script ranges for Munafe Supply.
# Latin / ambiguous text → None (caller keeps stored lang or falls back to en).
# Devanagari is shared by Hindi and Marathi; Marathi-only markers disambiguate.
# ============================================================================

from __future__ import annotations

import re
from collections import Counter

SUPPORTED_LANGS = frozenset({'en', 'hi', 'bn', 'mr', 'te', 'ta'})
DEFAULT_LANG = 'en'

# Script ranges (inclusive)
_DEVANAGARI = (0x0900, 0x097F)
_BENGALI = (0x0980, 0x09FF)
_TAMIL = (0x0B80, 0x0BFF)
_TELUGU = (0x0C00, 0x0C7F)

# Common Marathi-only (or strongly Marathi) markers within Devanagari text.
# Keep this list conservative — false Marathi → Hindi is preferable to the reverse
# for Mumbai/Pune dual-script users who often write Hindi in Devanagari.
# Prefer markers that are uncommon in Hindi Devanagari (avoid shared loanwords
# like बाकी / ऑर्डर / पेमेंट which Hindi speakers also type).
_MARATHI_MARKERS = re.compile(
    r'(आहे|किती|आम्ही|तुम्ही|तुमचा|तुमचे|तुमची|आमचा|आमचे|'
    r'पाठवले|भरले|पाहिजे|हवे|आवडते|कृपा करा|पुष्टी)',
)

_SCRIPT_TO_LANG = {
    'devanagari': 'hi',  # overridden to mr when markers match
    'bengali': 'bn',
    'tamil': 'ta',
    'telugu': 'te',
}


def _script_of(ch: str) -> str | None:
    cp = ord(ch)
    if _DEVANAGARI[0] <= cp <= _DEVANAGARI[1]:
        return 'devanagari'
    if _BENGALI[0] <= cp <= _BENGALI[1]:
        return 'bengali'
    if _TAMIL[0] <= cp <= _TAMIL[1]:
        return 'tamil'
    if _TELUGU[0] <= cp <= _TELUGU[1]:
        return 'telugu'
    return None


def detect_language(text: str) -> str | None:
    """
    Return a supported lang code when the text has a clear native-script signal.
    Returns None when detection is ambiguous or Latin-only (fallback to stored/en).
    """
    if not text or not text.strip():
        return None

    counts: Counter[str] = Counter()
    for ch in text:
        script = _script_of(ch)
        if script:
            counts[script] += 1

    if not counts:
        return None

    dominant, n = counts.most_common(1)[0]
    # Require a few script chars so a single stray glyph doesn't flip language
    if n < 2 and sum(counts.values()) < 2:
        return None

    # Mixed Indic scripts with no clear winner → ambiguous
    if len(counts) > 1:
        second = counts.most_common(2)[1][1]
        if second >= n:  # tie
            return None
        if second / n > 0.4:  # too mixed
            return None

    if dominant == 'devanagari':
        if _MARATHI_MARKERS.search(text):
            return 'mr'
        return 'hi'

    return _SCRIPT_TO_LANG.get(dominant)


def normalize_lang(lang: str | None) -> str:
    if not lang:
        return DEFAULT_LANG
    cleaned = str(lang).strip().lower()
    return cleaned if cleaned in SUPPORTED_LANGS else DEFAULT_LANG


def resolve_language(stored: str | None, text: str) -> tuple[str, bool]:
    """
    Pick the language for this turn.

    Returns (lang, changed) where changed means the stored preference should be
    updated (confident script detection differs from stored).
    """
    stored_norm = normalize_lang(stored)
    detected = detect_language(text or '')

    if detected is None:
        return stored_norm, False

    if detected != stored_norm:
        return detected, True
    return detected, False
