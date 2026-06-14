"""
Filter WhatsApp Business auto-reply / away messages.

Keep patterns in sync with src/helpers/whatsappAutoReply.js
"""

from __future__ import annotations

import re
from typing import Any

_AUTO_REPLY_RE = re.compile(
    r"(?:"
    r"hi,?\s+thanks\s+for\s+contacting|"
    r"thank\s+you\s+for\s+(?:contacting|reaching|your\s+message)|"
    r"thanks\s+for\s+(?:contacting|reaching\s+out|your\s+message)|"
    r"we(?:'ve|\s+have)\s+received\s+your\s+message|"
    r"your\s+message\s+(?:has\s+been\s+)?received|"
    r"appreciate\s+your\s+(?:getting\s+in\s+touch|message|contacting)|"
    r"we(?:\s+will|'ll)\s+get\s+back\s+to\s+you|"
    r"get\s+back\s+to\s+you\s+(?:as\s+soon\s+as\s+possible|shortly|soon)|"
    r"auto[\s-]?reply|"
    r"automatic(?:ally)?\s+(?:reply|response|message)|"
    r"out\s+of\s+(?:office|town)|"
    r"currently\s+(?:unavailable|away|busy|not\s+available)|"
    r"this\s+is\s+an\s+automated\s+(?:message|response)|"
    r"do\s+not\s+reply\s+to\s+this|"
    r"outside\s+(?:of\s+)?(?:business|working|office)\s+hours|"
    r"our\s+(?:business|working|office)\s+hours|"
    r"not\s+available\s+right\s+now|"
    r"away\s+from\s+(?:my|the)\s+(?:phone|desk)|"
    r"message\s+is\s+important\s+to\s+us|"
    r"we\s+are\s+(?:currently\s+)?closed"
    r")",
    re.IGNORECASE,
)

_AUTO_REPLY_WEAK_RE = re.compile(
    r"(?:thank|received|contacting|get\s+back|unavailable|business\s+hours|automated)",
    re.IGNORECASE,
)

_SHORT_REPLY_RE = re.compile(
    r"^(?:excellent|good|average|poor|skip|yes|no|ok|okay|menu|help|hi)$",
    re.IGNORECASE,
)


def _normalize_phone(phone: str | None) -> str:
    return re.sub(r"\D", "", str(phone or ""))


def _is_reply_to_us(message_obj: dict[str, Any], our_phone: str | None) -> bool:
    if not our_phone:
        return False
    context_from = (message_obj.get("context") or {}).get("from", "")
    if not context_from:
        return False
    cf = _normalize_phone(context_from)
    op = _normalize_phone(our_phone)
    if not cf or not op:
        return False
    return cf == op or cf.endswith(op[-10:]) or op.endswith(cf[-10:])


def _looks_like_customer_reply(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if len(t) <= 12 and re.fullmatch(r"[\d\s.,!?]+", t, re.IGNORECASE):
        return True
    return bool(_SHORT_REPLY_RE.match(t))


def is_whatsapp_auto_reply(
    message_obj: dict[str, Any],
    message_body: str,
    our_phone: str | None = None,
) -> bool:
    """
    Return True if this inbound message is a business auto-reply to ignore.

    Signals:
      1. Meta system message
      2. Text matches known auto-reply patterns
      3. Quoted reply to our number + weak auto-reply keywords (not short ratings)
    """
    if message_obj.get("system"):
        return True

    msg_type = message_obj.get("type", "")
    if msg_type != "text":
        return False

    text = (message_body or "").strip()
    if not text or _looks_like_customer_reply(text):
        return False

    if _AUTO_REPLY_RE.search(text):
        return True

    if _is_reply_to_us(message_obj, our_phone) and _AUTO_REPLY_WEAK_RE.search(text) and len(text) >= 25:
        return True

    return False
