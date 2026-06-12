"""
agents/customer/feedback_flow.py
──────────────────────────────────
Multi-step post-order feedback flow.

Steps
─────
  1. awaiting_feedback_rating
       Interactive list: Excellent / Good / Average / Below Average / Poor
       (also accepts typed 1–5 or list_reply)

  2. awaiting_feedback_aspects
       Numbered multi-select text — customer replies with comma/space-separated
       numbers e.g. "1 3 5" or "all".
       Aspect list is contextual:
         rating ≥ 4  →  "What did you love?"    (positive aspects)
         rating = 3  →  "What could be better?" (improvement aspects)
         rating ≤ 2  →  "What went wrong?"      (negative aspects)

  3. awaiting_feedback_comment
       Optional free-text comment.  Customer can type freely or tap "Skip".

  Final: save to DB, thank-you message, session → visit_complete.

WhatsApp Flow upgrade
─────────────────────
  If settings.meta_flow_feedback_id is set, steps 2+3 are replaced by a
  single native Flow with a CheckboxGroup (Meta dashboard setup required).
  Set meta_flow_feedback_id = "" or "your_flow_id_here" to use text fallback.

Session keys used
─────────────────
  feedback_booking_id    str   booking to attach feedback to
  feedback_token         str   displayed in messages
  feedback_table         str   displayed in messages
  feedback_rating        int   1–5
  feedback_rating_label  str   "Excellent" etc.
  feedback_aspects       list  selected aspect IDs
  feedback_comment       str | None
"""

from __future__ import annotations

import logging
import os as _os
from typing import Dict, Any

import aiohttp

from tools.whatsapp_tools import send_whatsapp_message
from tools.cart_tools import _send_interactive
from tools.booking_mechanisms import get_http, KDS_SECRET

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────

# Rating label → numeric score
RATING_MAP: dict[str, int] = {
    "excellent": 5,  "5": 5,
    "good":      4,  "4": 4,
    "average":   3,  "3": 3,
    "below average": 2, "2": 2, "below_average": 2,
    "poor":      1,  "1": 1,
}

# Emojis shown next to each rating in the thank-you message
RATING_EMOJI = {5: "🌟", 4: "😊", 3: "😐", 2: "😔", 1: "😞"}

# ── Aspect lists ─────────────────────────────────────────────────────────────

POSITIVE_ASPECTS: list[tuple[str, str]] = [
    ("food_quality",       "🍽️ Food quality"),
    ("quick_service",      "⚡ Quick service"),
    ("friendly_staff",     "😊 Friendly staff"),
    ("cleanliness",        "🧹 Cleanliness"),
    ("value_for_money",    "💰 Great value for money"),
    ("ordering_experience","📱 Easy ordering experience"),
]

IMPROVEMENT_ASPECTS: list[tuple[str, str]] = [
    ("food_quality",       "🍽️ Food quality"),
    ("wait_time",          "⏱️ Wait time"),
    ("staff_attitude",     "😐 Staff attitude"),
    ("cleanliness",        "🧹 Cleanliness"),
    ("value_for_money",    "💰 Value for money"),
    ("ordering_experience","📱 Ordering experience"),
]

NEGATIVE_ASPECTS: list[tuple[str, str]] = [
    ("food_quality",       "🍽️ Food quality"),
    ("wait_time",          "⏱️ Wait time too long"),
    ("staff_attitude",     "😐 Staff attitude"),
    ("cleanliness",        "🧹 Cleanliness"),
    ("overpriced",         "💰 Felt overpriced"),
    ("wrong_order",        "❌ Wrong / missing items"),
    ("food_temperature",   "🌡️ Food was too cold / hot"),
    ("ordering_experience","📱 Ordering experience"),
]


def _aspects_for_rating(rating: int) -> tuple[list[tuple[str, str]], str]:
    """Return (aspect_list, prompt_text) based on the rating score."""
    if rating >= 4:
        return POSITIVE_ASPECTS, "🌟 What did you love about your visit today?"
    if rating == 3:
        return IMPROVEMENT_ASPECTS, "💡 What could we do better next time?"
    return NEGATIVE_ASPECTS, "😔 We're sorry to hear that. What went wrong?"


def _build_aspect_menu(aspects: list[tuple[str, str]], prompt: str) -> str:
    lines = "\n".join(f"{i+1}️⃣ {label}" for i, (_, label) in enumerate(aspects))
    return (
        f"{prompt}\n\n"
        f"{lines}\n\n"
        f"Reply with the numbers that apply, separated by spaces or commas\n"
        f"_(e.g. *1 3* or *1,3,5* or *all*)_\n\n"
        f"Or tap *Skip* to finish."
    )


def _parse_aspect_reply(
    text: str, aspects: list[tuple[str, str]]
) -> list[str] | None:
    """
    Parse a multi-select reply into a list of aspect IDs.
    Returns None if the input is unrecognisable (not a skip).
    Returns [] if the customer explicitly skipped.
    """
    t = text.strip().lower()

    if t in ("skip", "s", "none", "no", "done", "ok", "okay"):
        return []

    if t in ("all", "everything", "sab", "all of the above"):
        return [aid for aid, _ in aspects]

    import re
    tokens = re.split(r"[\s,;]+", t)
    selected = []
    for tok in tokens:
        if tok.isdigit():
            idx = int(tok) - 1
            if 0 <= idx < len(aspects):
                selected.append(aspects[idx][0])
    return selected if selected else None


# ─────────────────────────────────────────────
# DB HELPERS
# ─────────────────────────────────────────────

async def _save_feedback(
    booking_id: str,
    rating: int,
    rating_label: str,
    aspects: list[str],
    comment: str | None,
    restaurant_id: str,
) -> None:
    """Upsert feedback onto the bookings row and optionally a feedback table."""
    try:
        base = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
        key  = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
        if not (base and key):
            logger.warning("[feedback] Supabase env vars not set — skipping save")
            return

        payload: dict[str, Any] = {
            "feedback_rating":  rating,
            "feedback_label":   rating_label,
            "feedback_aspects": aspects,       # stored as jsonb array
            "feedback_comment": comment,
            "feedback_given_at": "now()",
        }

        resp = await get_http().patch(
            f"{base}/rest/v1/bookings",
            params={"id": f"eq.{booking_id}"},
            json=payload,
            headers={
                "apikey":        key,
                "Authorization": f"Bearer {key}",
                "Content-Type":  "application/json",
                "Prefer":        "return=minimal",
            },
            timeout=aiohttp.ClientTimeout(total=5),
        )
        if resp.status in (200, 204):
            logger.info(
                f"[feedback] ✅ Saved rating={rating} aspects={aspects} "
                f"for booking {booking_id}"
            )
        else:
            logger.warning(
                f"[feedback] Save failed {resp.status}: {(await resp.text())[:200]}"
            )
    except Exception as e:
        logger.warning(f"[feedback] _save_feedback failed (non-fatal): {e}")


async def _mark_feedback_sent(booking_id: str) -> None:
    """Set feedback_sent_at so the scheduler won't re-queue this booking."""
    try:
        base = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
        key  = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
        if not (base and key):
            return
        await get_http().patch(
            f"{base}/rest/v1/bookings",
            params={"id": f"eq.{booking_id}"},
            json={"feedback_sent_at": "now()"},
            headers={
                "apikey": key, "Authorization": f"Bearer {key}",
                "Content-Type": "application/json", "Prefer": "return=minimal",
            },
            timeout=aiohttp.ClientTimeout(total=3),
        )
    except Exception as e:
        logger.debug(f"[feedback] _mark_feedback_sent failed (non-fatal): {e}")


# ─────────────────────────────────────────────
# FEEDBACK SENDER  (called by scheduler)
# ─────────────────────────────────────────────

async def send_feedback_request(
    customer_phone: str,
    customer_name: str,
    restaurant_id: str,
    booking_id: str,
    token_number: str,
    table_number: str | None,
    session_state: Dict[str, Any],
) -> None:
    """
    Send the initial feedback rating message and set session state.
    Called by the scheduler (scheduler_tools.py / feedback queue consumer).

    IMPORTANT: call _mark_feedback_sent() immediately after this to prevent
    the scheduler re-queuing the same booking.
    """
    # Store context so follow-up steps can reference it
    session_state["feedback_booking_id"] = booking_id
    session_state["feedback_token"]      = token_number
    session_state["feedback_table"]      = table_number or ""
    session_state["booking_step"]        = "awaiting_feedback_rating"

    # Build context line (token + table if available)
    context_line = f"Token *{token_number}*"
    if table_number:
        context_line += f" | Table *{table_number}*"

    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "list",
            "header": {"type": "text", "text": f"Hi {customer_name}! 😊"},
            "body": {
                "text": (
                    f"How was your experience today?\n"
                    f"_{context_line}_"
                )
            },
            "footer": {"text": "You can also add comments after your rating"},
            "action": {
                "button": "Rate your visit",
                "sections": [{
                    "title": "Tap to rate",
                    "rows": [
                        {"id": "excellent",     "title": "🌟 Excellent",      "description": "Everything was perfect!"},
                        {"id": "good",          "title": "😊 Good",           "description": "Mostly great, minor issues"},
                        {"id": "average",       "title": "😐 Average",        "description": "It was okay"},
                        {"id": "below_average", "title": "😔 Below average",  "description": "Could be better"},
                        {"id": "poor",          "title": "😞 Poor",           "description": "Very disappointed"},
                    ],
                }],
            },
        }
    })

    if not ok:
        # Plain text fallback
        await send_whatsapp_message(
            customer_phone,
            f"Hi {customer_name}! 😊 How was your experience today?\n"
            f"_{context_line}_\n\n"
            f"Please reply with a number:\n"
            f"5 — 🌟 Excellent\n4 — 😊 Good\n3 — 😐 Average\n"
            f"2 — 😔 Below average\n1 — 😞 Poor",
            restaurant_id,
        )

    await _mark_feedback_sent(booking_id)
    logger.info(f"[feedback] Sent rating request for booking {booking_id} to {customer_phone}")


# ─────────────────────────────────────────────
# FLOW HANDLER  (called from booking_agent router)
# ─────────────────────────────────────────────

async def handle_feedback_flow(
    restaurant_id: str,
    customer_name: str,
    customer_phone: str,
    message: str,
    session_state: Dict[str, Any],
    message_obj: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    """
    Handle an incoming message when the session is in a feedback step.
    Returns {"status": "..."} compatible with booking_agent return convention.
    """
    booking_step = session_state.get("booking_step")

    # ── Step 1: Rating ────────────────────────────────────────────────────────
    if booking_step == "awaiting_feedback_rating":
        return await _handle_rating(
            restaurant_id, customer_name, customer_phone,
            message, session_state, message_obj,
        )

    # ── Step 2: Aspect multi-select ───────────────────────────────────────────
    elif booking_step == "awaiting_feedback_aspects":
        return await _handle_aspects(
            restaurant_id, customer_name, customer_phone,
            message, session_state,
        )

    # ── Step 3: Optional comment ──────────────────────────────────────────────
    elif booking_step == "awaiting_feedback_comment":
        return await _handle_comment(
            restaurant_id, customer_name, customer_phone,
            message, session_state,
        )

    return {"status": "error"}


# ─────────────────────────────────────────────
# STEP HANDLERS
# ─────────────────────────────────────────────

async def _handle_rating(
    restaurant_id: str, customer_name: str, customer_phone: str,
    message: str, session_state: Dict[str, Any],
    message_obj: Dict[str, Any] | None,
) -> Dict[str, Any]:
    """Parse the rating from text or list_reply and send the aspect question."""

    # Extract from interactive list_reply if present
    raw_rating = message.strip().lower()
    if message_obj:
        try:
            interactive = message_obj.get("interactive", {})
            if interactive.get("type") == "list_reply":
                raw_rating = interactive["list_reply"]["id"].lower()
        except (KeyError, TypeError):
            pass

    rating = RATING_MAP.get(raw_rating)
    if rating is None:
        # Unrecognised — nudge gently
        await send_whatsapp_message(
            customer_phone,
            "Please tap one of the rating options, or reply with a number (1–5). 😊",
            restaurant_id,
        )
        return {"status": "awaiting_feedback_rating"}

    rating_label = raw_rating.replace("_", " ").title()
    session_state["feedback_rating"]       = rating
    session_state["feedback_rating_label"] = rating_label

    # Try WhatsApp Flow first if configured
    try:
        from config.settings import settings
        flow_id = getattr(settings, "meta_flow_feedback_id", "")
        if flow_id and flow_id not in ("", "your_flow_id_here"):
            from tools.whatsapp_tools import send_whatsapp_flow
            flow_token = f"feedback_{session_state.get('feedback_booking_id', '')}_{rating}"
            aspects, prompt = _aspects_for_rating(rating)
            items = [{"id": aid, "title": label} for aid, label in aspects]
            ok = await send_whatsapp_flow(
                phone=customer_phone,
                flow_id=flow_id,
                flow_token=flow_token,
                flow_cta="Select aspects",
                flow_header=prompt,
                flow_body="Select all that apply, then tap Submit.",
                flow_footer="Your feedback helps us improve 🙏",
                restaurant_id=restaurant_id,
            )
            if ok:
                session_state["_feedback_flow_token"] = flow_token
                session_state["booking_step"] = "awaiting_feedback_aspects"
                return {"status": "awaiting_feedback_aspects"}
    except Exception as e:
        logger.debug(f"[feedback] Flow send failed, using text fallback: {e}")

    # Text-based numbered multi-select (default)
    aspects, prompt = _aspects_for_rating(rating)
    session_state["_feedback_aspects_list"] = [aid for aid, _ in aspects]
    menu_text = _build_aspect_menu(aspects, prompt)
    session_state["booking_step"] = "awaiting_feedback_aspects"

    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "button",
            "body": {"text": menu_text},
            "footer": {"text": "Reply with numbers or type 'Skip'"},
            "action": {"buttons": [
                {"type": "reply", "reply": {"id": "SKIP_ASPECTS", "title": "⏭️ Skip"}},
            ]},
        }
    })
    if not ok:
        await send_whatsapp_message(customer_phone, menu_text, restaurant_id)

    return {"status": "awaiting_feedback_aspects"}


async def _handle_aspects(
    restaurant_id: str, customer_name: str, customer_phone: str,
    message: str, session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Parse multi-select aspect reply and ask for optional comment."""

    # Handle "Skip" button tap
    raw = message.strip()
    if raw.upper() in ("SKIP_ASPECTS", "SKIP", "S"):
        session_state["feedback_aspects"] = []
        return await _ask_for_comment(
            restaurant_id, customer_phone, session_state
        )

    # Handle WhatsApp Flow response
    if raw.startswith("FLOW:"):
        try:
            parts = raw.split("|")
            data  = {}
            for part in parts[1:]:
                if "=" in part:
                    k, v = part.split("=", 1)
                    data[k.strip()] = v.strip()
            aspects_str = data.get("aspects", "")
            selected = [a.strip() for a in aspects_str.split(",") if a.strip()]
            session_state["feedback_aspects"] = selected
        except Exception as e:
            logger.warning(f"[feedback] Flow aspect parse failed: {e}")
            session_state["feedback_aspects"] = []
        return await _ask_for_comment(restaurant_id, customer_phone, session_state)

    # Text multi-select parse
    aspects_list = session_state.get("_feedback_aspects_list", [])
    # Rebuild full list from stored IDs — find matching (id, label) pairs
    rating = session_state.get("feedback_rating", 3)
    full_aspects, _ = _aspects_for_rating(rating)

    parsed = _parse_aspect_reply(raw, full_aspects)
    if parsed is None:
        # Couldn't understand — nudge once
        await send_whatsapp_message(
            customer_phone,
            "Please reply with the numbers that apply (e.g. *1 3*) or type *Skip*. 😊",
            restaurant_id,
        )
        return {"status": "awaiting_feedback_aspects"}

    session_state["feedback_aspects"] = parsed
    return await _ask_for_comment(restaurant_id, customer_phone, session_state)


async def _ask_for_comment(
    restaurant_id: str, customer_phone: str, session_state: Dict[str, Any]
) -> Dict[str, Any]:
    """Send the optional comment prompt."""
    session_state["booking_step"] = "awaiting_feedback_comment"

    ok = await _send_interactive(customer_phone, {
        "interactive": {
            "type": "button",
            "body": {
                "text": (
                    "Any other comments for the team? 💬\n\n"
                    "Feel free to type anything — or tap *Skip* to finish."
                )
            },
            "footer": {"text": "Your feedback is always welcome 🙏"},
            "action": {"buttons": [
                {"type": "reply", "reply": {"id": "SKIP_COMMENT", "title": "⏭️ Skip"}},
            ]},
        }
    })
    if not ok:
        await send_whatsapp_message(
            customer_phone,
            "Any other comments? Type freely or reply *Skip* to finish. 🙏",
            restaurant_id,
        )
    return {"status": "awaiting_feedback_comment"}


async def _handle_comment(
    restaurant_id: str, customer_name: str, customer_phone: str,
    message: str, session_state: Dict[str, Any],
) -> Dict[str, Any]:
    """Receive optional comment, save everything, send thank-you."""

    raw = message.strip()
    comment: str | None = None

    if raw.upper() not in ("SKIP_COMMENT", "SKIP", "S", "NO", "NONE", ""):
        comment = raw[:500]   # cap length

    session_state["feedback_comment"] = comment

    # ── Save to DB ────────────────────────────────────────────────────────────
    booking_id   = session_state.get("feedback_booking_id", "")
    rating       = session_state.get("feedback_rating", 0)
    rating_label = session_state.get("feedback_rating_label", "")
    aspects      = session_state.get("feedback_aspects", [])

    if booking_id:
        await _save_feedback(
            booking_id, rating, rating_label, aspects, comment, restaurant_id
        )

    # ── Thank-you message ─────────────────────────────────────────────────────
    emoji        = RATING_EMOJI.get(rating, "🙏")
    aspect_lines = ""
    if aspects:
        rating_val = session_state.get("feedback_rating", 3)
        full_aspects, _ = _aspects_for_rating(rating_val)
        label_map = {aid: label for aid, label in full_aspects}
        bullets   = "\n".join(f"• {label_map.get(a, a)}" for a in aspects)
        if rating >= 4:
            aspect_lines = f"\nLoved that you enjoyed:\n{bullets}\n"
        else:
            aspect_lines = f"\nWe'll work on:\n{bullets}\n"

    thank_you = (
        f"{emoji} Thank you for your feedback, {customer_name}!\n"
        f"{aspect_lines}\n"
        f"Your input helps us serve you better. See you again soon! 😊"
    )
    await send_whatsapp_message(customer_phone, thank_you, restaurant_id)

    # Clean up feedback keys, move to visit_complete
    for key in (
        "feedback_booking_id", "feedback_token", "feedback_table",
        "feedback_rating", "feedback_rating_label", "feedback_aspects",
        "feedback_comment", "_feedback_aspects_list", "_feedback_flow_token",
    ):
        session_state.pop(key, None)

    session_state["booking_step"] = "visit_complete"
    return {"status": "feedback_complete"}
