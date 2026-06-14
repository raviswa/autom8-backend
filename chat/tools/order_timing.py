"""
Order timing notes — owner ready ranges + manager busy-kitchen flag.
Shown on takeaway/delivery confirmations as soft estimates, not guarantees.
"""

from __future__ import annotations


def _display_range(ready_range: str | None) -> str:
    """Normalize owner input like '20-30' or '20 - 30 mins' for display."""
    if not ready_range:
        return ""
    text = str(ready_range).strip()
    for suffix in ("mins", "min", "minutes", "minute"):
        if text.lower().endswith(suffix):
            text = text[: -len(suffix)].strip()
    return text


def format_ready_time_note(
    service_type: str,
    *,
    ready_range: str | None = None,
    kitchen_busy: bool = False,
) -> str:
    """
    Build optional ETA paragraph for order confirmations.
    Returns empty string when no range is set and kitchen is not busy.
    """
    display = _display_range(ready_range)
    st = (service_type or "").replace("-", "_").lower()

    if display:
        if kitchen_busy:
            return (
                f"⏱ Normally it takes {display} mins, but due to high volumes "
                "there could be some delay in preparing your food. "
                "We'll WhatsApp you when it's ready."
            )
        label = "delivered" if st == "delivery" else "ready"
        return (
            f"⏱ Usually {label} in {display} mins. "
            "We'll WhatsApp you when it's ready."
        )

    if kitchen_busy:
        return (
            "⏱ Kitchen is busy — please allow a little extra time preparing your order. "
            "We'll WhatsApp you when it's ready."
        )

    return ""


def ready_range_for_service(session_state: dict, service_type: str) -> str | None:
    st = (service_type or "").replace("-", "_").lower()
    if st == "delivery":
        return session_state.get("delivery_ready_range") or None
    return session_state.get("takeaway_ready_range") or None


def ready_time_note_from_session(session_state: dict, service_type: str) -> str:
    return format_ready_time_note(
        service_type,
        ready_range=ready_range_for_service(session_state, service_type),
        kitchen_busy=bool(session_state.get("kitchen_busy")),
    )
