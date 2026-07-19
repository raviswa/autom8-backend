# chat/locales/supply/__init__.py
# Localized reply strings for the Munafe Supply WhatsApp agent.
# Add a new language by creating <code>.py with a REPLIES dict and registering it below.

from __future__ import annotations

from . import bn, en, hi, mr, ta, te

_CATALOGS: dict[str, dict[str, str]] = {
    'en': en.REPLIES,
    'hi': hi.REPLIES,
    'bn': bn.REPLIES,
    'mr': mr.REPLIES,
    'te': te.REPLIES,
    'ta': ta.REPLIES,
}


def reply(lang: str, key: str, **kwargs) -> str:
    """Look up a reply template and format kwargs. Falls back to English, then key."""
    catalog = _CATALOGS.get(lang) or _CATALOGS['en']
    template = catalog.get(key) or _CATALOGS['en'].get(key) or key
    if not kwargs:
        return template
    try:
        return template.format(**kwargs)
    except (KeyError, ValueError):
        return template


def has_lang(lang: str) -> bool:
    return lang in _CATALOGS
