"""
Rule-based feedback intent classifier + reply window (mirrors Node feedbackIntent.js).
Used when Python session is in awaiting_feedback_* steps.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

FEEDBACK_REPLY_WINDOW_MINUTES = max(
    1, int(os.getenv("FEEDBACK_REPLY_WINDOW_MINUTES", "15"))
)
FEEDBACK_REPLY_WINDOW_SECONDS = FEEDBACK_REPLY_WINDOW_MINUTES * 60

_RESET = frozenset({
    "home", "menu", "main menu", "mainmenu", "restart", "start over", "startover",
    "reboot", "new", "begin",
})
_SERVICE_MENU_IDS = frozenset({
    "dine_in", "takeaway_now", "takeaway_schedule", "takeaway", "delivery",
    "schedule_delivery", "reserve_table", "book_table", "order_food",
})
_RATING_MAP = {
    "excellent": 5, "5": 5, "good": 4, "4": 4, "average": 3, "3": 3,
    "below average": 2, "below_average": 2, "2": 2, "poor": 1, "1": 1,
}
_SKIP = frozenset({
    "skip", "s", "none", "no", "done", "ok", "okay", "skip_aspects", "skip_comment",
})
_GREETING_RE = re.compile(
    r"^(hi|hello|hey|hola|namaste|good\s+(morning|afternoon|evening)|gm|yo)\b",
    re.IGNORECASE,
)
_ORDER_HINT_RE = re.compile(
    r"\b(menu|order|idli|dosa|biryani|cart|done|catalog|takeaway|delivery|dine)\b",
    re.IGNORECASE,
)

# Map Python booking_step → classifier sub-state
_STEP_TO_SUBSTATE = {
    "awaiting_feedback_rating": "awaiting_feedback_rating",
    "awaiting_feedback_aspects": "awaiting_feedback_tags",
    "awaiting_feedback_comment": "awaiting_feedback_comment",
}


def _normalize(text: str) -> str:
    t = (text or "").strip().lower()
    if t.startswith("⏭️"):
        t = t[1:].strip()
    return t


def _parse_rating(text: str) -> int | None:
    raw = _normalize(text)
    if raw in _RATING_MAP:
        return int(_RATING_MAP[raw])
    if re.fullmatch(r"[1-5]", raw):
        return int(raw)
    m = re.search(r"\b([1-5])\b", raw)
    if m:
        return int(m.group(1))
    stars = text.count("⭐") + text.count("★")
    if 1 <= stars <= 5 and len(text.strip()) <= 8:
        return stars
    return None


def _is_tag_selection(text: str) -> bool:
    t = _normalize(text)
    if t in {"all", "everything", "all of the above"}:
        return True
    return bool(re.fullmatch(r"[\d\s,;]+", t) and re.search(r"\d", t))


def _extract_interactive_id(message_obj: dict[str, Any] | None) -> str:
    if not message_obj or not isinstance(message_obj, dict):
        return ""
    if message_obj.get("type") != "interactive":
        return ""
    interactive = message_obj.get("interactive") or {}
    if interactive.get("type") == "list_reply":
        lr = interactive.get("list_reply") or {}
        return (lr.get("id") or lr.get("title") or "").strip()
    if interactive.get("type") == "button_reply":
        br = interactive.get("button_reply") or {}
        return (br.get("id") or br.get("title") or "").strip()
    return ""


def classify_session_feedback_intent(
    text: str,
    booking_step: str,
    message_obj: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Returns intent, feedback_action, abandon_feedback_flow."""
    sub_state = _STEP_TO_SUBSTATE.get(booking_step, booking_step)
    raw = (text or "").strip()
    lower = _normalize(raw)

    def abandon(intent: str) -> dict[str, Any]:
        return {
            "intent": intent,
            "feedback_action": None,
            "abandon_feedback_flow": True,
        }

    def reply(action: str) -> dict[str, Any]:
        return {
            "intent": "feedback_reply",
            "feedback_action": action,
            "abandon_feedback_flow": False,
        }

    if message_obj and message_obj.get("type") == "order":
        return abandon("new_order")

    iid = _extract_interactive_id(message_obj)
    if iid:
        il = iid.lower()
        if il in _SERVICE_MENU_IDS:
            return abandon("menu_action")
        if il in _SKIP:
            return reply("skip")
        if sub_state == "awaiting_feedback_rating" and il in _RATING_MAP:
            return reply("rating")
        if sub_state == "awaiting_feedback_rating":
            return abandon("menu_action")
        return abandon("menu_action")

    if lower in _RESET or lower in _SERVICE_MENU_IDS:
        return abandon("menu_action")
    if _GREETING_RE.match(lower):
        return abandon("greeting")
    if lower in _SKIP:
        return reply("skip")

    if sub_state == "awaiting_feedback_rating":
        if re.fullmatch(r"[\d\s,;]+", lower) and re.search(r"[\s,;]", lower) and re.search(r"\d", lower):
            return abandon("other")
        if _parse_rating(raw) is not None:
            return reply("rating")
        if _ORDER_HINT_RE.search(raw):
            return abandon("new_order")
        return abandon("other")

    if sub_state == "awaiting_feedback_tags":
        if _is_tag_selection(raw):
            return reply("tags")
        if _ORDER_HINT_RE.search(raw):
            return abandon("new_order")
        return abandon("other")

    if sub_state == "awaiting_feedback_comment":
        if raw:
            return reply("comment")
        return abandon("other")

    return abandon("other")


def is_session_feedback_expired(session_state: dict[str, Any]) -> bool:
    sent_at = session_state.get("feedback_invite_sent_at")
    if not sent_at:
        return False
    try:
        if isinstance(sent_at, (int, float)):
            start = datetime.fromtimestamp(sent_at, tz=timezone.utc)
        else:
            start = datetime.fromisoformat(str(sent_at).replace("Z", "+00:00"))
        elapsed = (datetime.now(timezone.utc) - start).total_seconds()
        return elapsed > FEEDBACK_REPLY_WINDOW_SECONDS
    except Exception:
        return False


def is_db_feedback_invite_active(feedback_sent_at: str | None) -> bool:
    """True if Node feedback_pending invite is still inside the reply window."""
    if not feedback_sent_at:
        return True
    try:
        start = datetime.fromisoformat(str(feedback_sent_at).replace("Z", "+00:00"))
        elapsed = (datetime.now(timezone.utc) - start).total_seconds()
        return elapsed <= FEEDBACK_REPLY_WINDOW_SECONDS
    except Exception:
        return True


def clear_session_feedback(session_state: dict[str, Any]) -> None:
    """Drop feedback sub-state so normal booking routing resumes."""
    for key in (
        "feedback_booking_id", "feedback_token", "feedback_table",
        "feedback_rating", "feedback_rating_label", "feedback_aspects",
        "feedback_comment", "_feedback_aspects_list", "_feedback_flow_token",
        "feedback_invite_sent_at",
    ):
        session_state.pop(key, None)
    session_state["booking_step"] = "visit_complete"
