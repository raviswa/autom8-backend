"""Feature gate — subscription access and customer service menu."""

from __future__ import annotations

import json
import logging
import os
import re
import time
import unicodedata
from datetime import datetime, timezone, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from db.models import Feature

logger = logging.getLogger(__name__)

ORDER_MODE_IMMEDIATE = "immediate"
ORDER_MODE_SCHEDULED = "scheduled"

# Must match Node src/helpers/subscriptionAccess.js
GRACE_PERIOD_DAYS = max(1, int(os.getenv("SUBSCRIPTION_GRACE_PERIOD_DAYS", "15") or "15"))
LAPSED_ERROR = "subscription_lapsed"
# Reminder job sets this on unpaid tenants at T+0 / T+15
OVERDUE_STATUS_TENANT = "past_due"

_IST = ZoneInfo("Asia/Kolkata")

_CACHE: dict[str, tuple[list[str], float]] = {}
_TTL = 300
_SUB_CACHE: dict[str, tuple[dict | None, float]] = {}
_SUB_TTL = 60


def _ist_date_key(dt: datetime | None = None) -> str:
    d = dt or datetime.now(_IST)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc).astimezone(_IST)
    else:
        d = d.astimezone(_IST)
    return d.strftime("%Y-%m-%d")


def _to_date_key(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        if len(value) >= 10 and value[4] == "-" and value[7] == "-":
            return value[:10]
        try:
            return _to_date_key(datetime.fromisoformat(value.replace("Z", "+00:00")))
        except Exception:
            return None
    if isinstance(value, datetime):
        return _ist_date_key(value)
    return None


def days_relative_to_anchor(anchor: Any, now: datetime | None = None) -> int | None:
    """Negative = before anchor, 0 = due today, positive = days past (IST calendar)."""
    anchor_key = _to_date_key(anchor)
    today_key = _ist_date_key(now)
    if not anchor_key or not today_key:
        return None
    ay, am, ad = map(int, anchor_key.split("-"))
    ty, tm, td = map(int, today_key.split("-"))
    return (datetime(ty, tm, td) - datetime(ay, am, ad)).days


def get_cycle_anchor(sub: dict | None) -> Any:
    if not sub:
        return None
    if sub.get("status") == "trial":
        return sub.get("trial_ends_at")
    return sub.get("renews_at") or sub.get("trial_ends_at")


def is_lifetime_tenant(restaurant_id: str | None) -> bool:
    if not restaurant_id:
        return False
    raw = os.getenv("LIFETIME_TENANT_IDS", "") or ""
    ids = {s.strip() for s in raw.split(",") if s.strip()}
    return str(restaurant_id).strip() in ids


def is_subscription_soft_locked(
    sub: dict | None,
    now: datetime | None = None,
    restaurant_id: str | None = None,
) -> bool:
    """Authoritative soft-lock: daysPast(anchor) >= GRACE_PERIOD_DAYS.
    Lifetime / demo tenants (LIFETIME_TENANT_IDS) are never soft-locked.
    """
    rid = restaurant_id or (sub or {}).get("restaurant_id")
    if is_lifetime_tenant(rid):
        return False
    if not sub:
        return False
    if sub.get("status") == "cancelled":
        return True
    anchor = get_cycle_anchor(sub)
    if not anchor:
        return False
    relative = days_relative_to_anchor(anchor, now)
    if relative is None:
        return False
    return relative >= GRACE_PERIOD_DAYS


def build_lapsed_payload(sub: dict | None = None) -> dict:
    sub = sub or {}
    anchor = get_cycle_anchor(sub)
    grace_ends_at = None
    key = _to_date_key(anchor)
    if key:
        y, m, d = map(int, key.split("-"))
        grace_ends_at = (
            datetime(y, m, d, tzinfo=timezone.utc) + timedelta(days=GRACE_PERIOD_DAYS)
        ).isoformat()
    return {
        "error": LAPSED_ERROR,
        "message": (
            "Subscription expired. Please renew to create new orders or send campaigns. "
            "You can still view history and complete payments."
        ),
        "grace_ends_at": grace_ends_at,
        "renews_at": sub.get("renews_at"),
        "trial_ends_at": sub.get("trial_ends_at"),
        "status": sub.get("status"),
    }


async def fetch_tenant_subscription(restaurant_id: str) -> dict | None:
    cached = _SUB_CACHE.get(restaurant_id)
    if cached and time.monotonic() - cached[1] < _SUB_TTL:
        return cached[0]
    try:
        from tools.db_tools import AsyncSessionLocal
        from sqlalchemy import text

        if AsyncSessionLocal is None:
            return None
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text(
                    "SELECT id, status, trial_ends_at, renews_at "
                    "FROM tenant_subscriptions "
                    "WHERE restaurant_id = :rid LIMIT 1"
                ),
                {"rid": restaurant_id},
            )
            row = result.mappings().first()
            data = dict(row) if row else None
    except Exception as e:
        logger.warning("fetch_tenant_subscription failed restaurant_id=%s: %s", restaurant_id, e)
        data = None
    _SUB_CACHE[restaurant_id] = (data, time.monotonic())
    return data


async def assert_tenant_subscription_allows(
    restaurant_id: str,
    action: str,
) -> tuple[bool, dict | None]:
    """
    Soft-lock write gate for tenants.
    Blocked actions: create_order, send_order_link, send_marketing
    Allowed: reads, payment flows, balance/status checks.
    """
    blocked = {"create_order", "send_order_link", "send_marketing"}
    if action not in blocked:
        return True, None
    sub = await fetch_tenant_subscription(restaurant_id)
    if not is_subscription_soft_locked(sub, restaurant_id=restaurant_id):
        return True, None
    return False, build_lapsed_payload(sub)


SERVICE_ROW_CONFIG: dict[str, dict[str, str]] = {
    "token_queue": {
        "title": "🎫 Token / Queue",
        "description": "Get a queue token, we'll take it from there",
        "title_key": "svc_card_token_queue_title",
        "desc_key": "svc_card_token_queue_desc",
    },
    "dine_in_now": {
        "title": "🍽️ Dine-In Now",
        "description": "Order food at your table",
        "title_key": "svc_card_dine_in_now_title",
        "desc_key": "svc_card_dine_in_now_desc",
        # Short WA carousel button (max 20) — do NOT use the long card title.
        "button_key": "svc_dine_in",
    },
    "door_delivery_now": {
        "title": "🛵 Home Delivery",
        "description": "Fresh food delivered to your door",
        "title_key": "svc_card_door_delivery_now_title",
        "desc_key": "svc_card_door_delivery_now_desc",
        "button_key": "svc_home_delivery",
    },
    "takeaway_now": {
        "title": "🛍️ Take Away",
        "description": "Skip the line, pick up now",
        "title_key": "svc_card_takeaway_now_title",
        "desc_key": "svc_card_takeaway_now_desc",
        "button_key": "svc_takeaway",
    },
    "table_reservation": {
        "title": "🗓️ Future Reservation",
        "description": "Book your preferred table in advance",
        "title_key": "svc_card_table_reservation_title",
        "desc_key": "svc_card_table_reservation_desc",
        "button_key": "svc_table_reservation",
    },
    "scheduled_delivery": {
        "title": "🕒 Scheduled Delivery",
        "description": "Schedule a delivery for later",
        "title_key": "svc_card_scheduled_delivery_title",
        "desc_key": "svc_card_scheduled_delivery_desc",
        "footnote": "scheduled",
        "button_key": "svc_scheduled_delivery",
    },
    "scheduled_pickup": {
        "title": "🚗 Scheduled Take Away",
        "description": "Plan your pick-up time in advance",
        "title_key": "svc_card_scheduled_pickup_title",
        "desc_key": "svc_card_scheduled_pickup_desc",
        "footnote": "scheduled",
        "button_key": "svc_scheduled_takeaway",
    },
}

# Public HTTPS base for WhatsApp carousel card headers (served by Express
# from /service-cards). Override via SERVICE_CARD_IMAGE_BASE_URL in env.
_DEFAULT_SERVICE_CARD_IMAGE_BASE = "https://api.autom8.works/service-cards"


def service_card_image_base() -> str:
    import os
    return (os.environ.get("SERVICE_CARD_IMAGE_BASE_URL") or _DEFAULT_SERVICE_CARD_IMAGE_BASE).rstrip("/")


def service_card_image_url(row_id: str) -> str | None:
    """Public image URL for a service-menu row, or None if no asset exists."""
    if not row_id or row_id not in SERVICE_ROW_CONFIG:
        return None
    return f"{service_card_image_base()}/{row_id}.jpg"


def service_card_body_text(row_id: str, title: str | None = None, description: str | None = None) -> str:
    """WhatsApp carousel card body (max 160 chars)."""
    cfg = SERVICE_ROW_CONFIG.get(row_id) or {}
    t = (title or cfg.get("title") or row_id).strip()
    d = (description or cfg.get("description") or "").strip()
    body = f"*{t}*\n\n{d}" if d else f"*{t}*"
    return body[:160]


def _cache_get(restaurant_id: str) -> list[str] | None:
    entry = _CACHE.get(restaurant_id)
    if entry and time.monotonic() - entry[1] < _TTL:
        return entry[0]
    return None


def _cache_set(restaurant_id: str, features: list[str]) -> None:
    _CACHE[restaurant_id] = (features, time.monotonic())


def invalidate(restaurant_id: str) -> None:
    _CACHE.pop(restaurant_id, None)


async def get_features(restaurant_id: str) -> list[str]:
    cached = _cache_get(restaurant_id)
    if cached is not None:
        return cached

    try:
        from tools.booking_mechanisms import fetch_restaurant_info

        info = await fetch_restaurant_info(restaurant_id)
        features = _normalize_services_enabled(info)
    except Exception as e:
        logger.exception("Failed to fetch features for restaurant_id=%s: %s", restaurant_id, e)
        features = []

    _cache_set(restaurant_id, features)
    return features


def has_feature(features: list[str], feature: str) -> bool:
    return feature in features


async def restaurant_has_feature(restaurant_id: str, feature: str) -> bool:
    features = await get_features(restaurant_id)
    return feature in features


class FeatureNotSubscribed(Exception):
    def __init__(self, feature: str):
        super().__init__(feature)
        self.feature = feature


async def require_feature(restaurant_id: str, feature: str) -> None:
    if not await restaurant_has_feature(restaurant_id, feature):
        raise FeatureNotSubscribed(feature)


_DENIAL_MESSAGES: dict[str, str] = {
    Feature.TOKEN_MANAGEMENT: (
        "Token queue management isn't part of your current plan. "
        "Please ask your restaurant manager to upgrade. 🙏"
    ),
    Feature.DINE_IN: (
        "Dine-in ordering isn't enabled for this restaurant yet. "
        "Please speak to a staff member to place your order. 🍽️"
    ),
    Feature.TAKEAWAY: (
        "Online takeaway ordering isn't available here yet. "
        "Please visit the counter to place your order. 🛍️"
    ),
    Feature.DELIVERY: (
        "Door delivery isn't available from this restaurant yet. 🛵"
    ),
    Feature.RESERVE_TABLE: (
        "Table reservations aren't enabled here yet. "
        "Please call us directly to book a table. 📅"
    ),
}

_DEFAULT_DENIAL = (
    "This feature isn't part of your restaurant's current plan. "
    "Please contact the manager for details. 🙏"
)


def denial_message(feature: str) -> str:
    return _DENIAL_MESSAGES.get(feature, _DEFAULT_DENIAL)


def _feature_val(feature) -> str:
    return feature.value if hasattr(feature, "value") else feature


def _normalize_services_enabled(restaurant: dict) -> list[str]:
    services_enabled = (
        restaurant.get("services_enabled")
        or restaurant.get("subscribed_features")
        or []
    )

    # Support boolean maps like {"dine_in": true, ...}.
    if isinstance(services_enabled, dict):
        return [str(k) for k, v in services_enabled.items() if bool(v)]

    if isinstance(services_enabled, str):
        try:
            parsed = json.loads(services_enabled)
            if isinstance(parsed, dict):
                return [str(k) for k, v in parsed.items() if bool(v)]
            services_enabled = parsed
        except Exception:
            services_enabled = [x.strip() for x in services_enabled.split(",") if x.strip()]

    if not isinstance(services_enabled, list):
        return []

    return [str(x) for x in services_enabled]


def _service_row(row_id: str, lang: str | None = None) -> dict[str, str]:
    cfg = SERVICE_ROW_CONFIG[row_id]
    title = cfg["title"]
    description = cfg["description"]
    button_title = title
    code = lang or "en"
    if lang:
        try:
            from locales.customer import reply
            if cfg.get("title_key"):
                title = reply(lang, cfg["title_key"])
            if cfg.get("desc_key"):
                description = reply(lang, cfg["desc_key"])
            if cfg.get("button_key"):
                button_title = reply(lang, cfg["button_key"])
            else:
                button_title = title
        except Exception:
            button_title = title
    else:
        button_title = title
    if cfg.get("footnote") == "scheduled":
        try:
            from locales.customer import get_scheduled_order_footnote, normalize_lang
            footnote = get_scheduled_order_footnote(normalize_lang(code))
            if footnote and footnote not in description:
                description = f"{description.rstrip('. ')}. {footnote}"
        except Exception:
            pass
    return {
        "id": row_id,
        "title": title,
        "description": description,
        "button_title": button_title,
    }


def _parse_row_id(row_id: str) -> tuple[str | None, str | None]:
    mapping: dict[str, tuple[str | None, str | None]] = {
        "token_queue": (Feature.TOKEN_MANAGEMENT, None),
        "dine_in_now": (Feature.DINE_IN, None),
        "door_delivery_now": (Feature.DELIVERY, ORDER_MODE_IMMEDIATE),
        "takeaway_now": (Feature.TAKEAWAY, ORDER_MODE_IMMEDIATE),
        "table_reservation": (Feature.RESERVE_TABLE, None),
        "scheduled_delivery": (Feature.DELIVERY, ORDER_MODE_SCHEDULED),
        "scheduled_pickup": (Feature.TAKEAWAY, ORDER_MODE_SCHEDULED),
        "nothing": (None, None),
    }
    return mapping.get(row_id, (None, None))


_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001FAFF"  # symbols & pictographs / extended
    "\U0001F600-\U0001F64F"  # emoticons
    "\U0001F680-\U0001F6FF"  # transport
    "\U0001F900-\U0001F9FF"  # supplemental
    "\U00002600-\U000026FF"  # misc symbols
    "\U00002700-\U000027BF"  # dingbats
    "\uFE0F"                 # variation selector
    "\u200D"                 # ZWJ (emoji sequences)
    "]+",
    flags=re.UNICODE,
)


def _truncate_wa_button(text: str, limit: int = 20) -> str:
    """Truncate to WhatsApp's 20-char button limit without mid-word cuts when possible."""
    s = (text or "").strip()
    if len(s) <= limit:
        return s
    cut = s[:limit].rstrip()
    sp = cut.rfind(" ")
    if sp >= 6:
        cut = cut[:sp].rstrip()
    return cut or s[:limit]


def _strip_emoji_title(title: str) -> str:
    """Short label for carousel button titles (max 20).

    IMPORTANT: do NOT use ``[^\\w]`` — Python ``\\w`` drops Indic vowel signs /
    viramas (Mn/Mc), which garbles Tamil/Malayalam/Hindi into broken spellings
    like ``உணவகத் தல`` instead of ``உணவகத்தில்``.
    """
    cleaned = _EMOJI_RE.sub(" ", title or "")
    kept: list[str] = []
    for ch in cleaned:
        cat = unicodedata.category(ch)
        if ch.isalnum() or ch.isspace() or ch in "/&+-":
            kept.append(ch)
        elif cat in ("Mn", "Mc", "Me", "Lm"):  # combining marks / modifiers
            kept.append(ch)
        elif cat.startswith("L"):  # any letter
            kept.append(ch)
        else:
            kept.append(" ")
    cleaned = re.sub(r"\s+", " ", "".join(kept)).strip()
    return _truncate_wa_button(cleaned) or "Select"


def service_card_button_title(row_id: str, title: str | None = None) -> str:
    """Unique per-card WhatsApp button title (must differ across carousel cards)."""
    cfg = SERVICE_ROW_CONFIG.get(row_id) or {}
    return _strip_emoji_title(title or cfg.get("title") or row_id)


def match_service_row_choice(
    choice: str,
    rows: list[dict] | None = None,
) -> str | None:
    """Map a webhook id/title/body fragment back to a service row id."""
    raw = (choice or "").strip()
    if not raw:
        return None

    def _norm(s: str) -> str:
        s = (s or "").strip().strip("*").strip()
        s = _strip_emoji_title(s).lower()
        s = s.replace("-", " ")
        return re.sub(r"\s+", " ", s).strip()

    candidates = rows or [
        {"id": rid, "title": cfg["title"], "description": cfg["description"]}
        for rid, cfg in SERVICE_ROW_CONFIG.items()
    ]
    lower = raw.lower()
    norm_raw = _norm(raw)
    for row in candidates:
        rid = str(row.get("id") or "")
        if not rid or rid == "nothing":
            continue
        if raw == rid or lower == rid.lower():
            return rid
        title = str(row.get("title") or "")
        if title and (raw == title or lower == title.lower() or norm_raw == _norm(title)):
            return rid
        btn = service_card_button_title(rid, row.get("button_title") or title)
        if btn and (raw == btn or lower == btn.lower() or norm_raw == _norm(btn)):
            return rid
        # Also accept the untruncated localized short label
        raw_btn = str(row.get("button_title") or "").strip()
        if raw_btn and (raw == raw_btn or lower == raw_btn.lower() or norm_raw == _norm(raw_btn)):
            return rid
        body = service_card_body_text(rid, title=title, description=row.get("description"))
        first = body.split("\n", 1)[0].strip().strip("*")
        if first and (raw == first or lower == first.lower() or norm_raw == _norm(first)):
            return rid
    return None


def build_service_selection_payload(
    restaurant: dict,
    *,
    lang: str | None = None,
) -> dict | None:
    services_enabled = _normalize_services_enabled(restaurant)
    scheduled_delivery_enabled = bool(restaurant.get("scheduled_delivery_enabled"))
    scheduled_takeaway_enabled = bool(restaurant.get("scheduled_takeaway_enabled"))

    rows_sec1 = []
    rows_sec2 = []

    dine_in_on = Feature.DINE_IN in services_enabled

    # Token / Queue is a walk-in handoff for restaurants WITHOUT Dine-In ordering.
    # When Dine-In is opted in, hide Token / Queue — customers should use Dine-In Now.
    if Feature.TOKEN_MANAGEMENT in services_enabled and not dine_in_on:
        rows_sec1.append(_service_row("token_queue", lang=lang))

    if dine_in_on:
        rows_sec1.append(_service_row("dine_in_now", lang=lang))
        rows_sec2.append(_service_row("table_reservation", lang=lang))

    if Feature.DELIVERY in services_enabled:
        rows_sec1.append(_service_row("door_delivery_now", lang=lang))
        if scheduled_delivery_enabled:
            rows_sec2.append(_service_row("scheduled_delivery", lang=lang))

    if Feature.TAKEAWAY in services_enabled:
        rows_sec1.append(_service_row("takeaway_now", lang=lang))
        if scheduled_takeaway_enabled:
            rows_sec2.append(_service_row("scheduled_pickup", lang=lang))

    total_rows = len(rows_sec1) + len(rows_sec2)

    if total_rows == 0:
        return {
            "type": "text",
            "text": {
                "body": "We're not taking walk-ins right now. Please check back later or contact us directly.",
            },
        }

    try:
        from locales.customer import reply
        sec1_title = reply(lang, "service_section_instant") if lang else "🚀 INSTANT / NOW"
        sec2_title = reply(lang, "service_section_planned") if lang else "⏰ PLANNED / LATER"
        help_text = reply(lang, "service_menu_help") if lang else "How can we help you today?"
        btn = reply(lang, "service_menu_button") if lang else "👉 Select Service"
    except Exception:
        sec1_title, sec2_title = "🚀 INSTANT / NOW", "⏰ PLANNED / LATER"
        help_text, btn = "How can we help you today?", "👉 Select Service"

    sections = []
    if rows_sec1:
        sections.append({"title": sec1_title[:24], "rows": rows_sec1})
    if rows_sec2:
        sections.append({"title": sec2_title[:24], "rows": rows_sec2})

    return {
        "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {
                "text": help_text,
            },
            "action": {
                "button": (btn[:20] if btn else "Select Service"),
                "sections": sections,
            },
        },
    }


async def build_service_menu_rows(
    restaurant_id: str,
    session_state: dict[str, Any] | None = None,
) -> list[dict]:
    from tools.kitchen_hours import kitchen_accepting_orders, refresh_kitchen_acceptance
    from tools.booking_mechanisms import fetch_restaurant_info

    state = session_state or {}
    await refresh_kitchen_acceptance(state, restaurant_id)

    lang = None
    try:
        from locales.customer import session_lang
        lang = session_lang(state)
    except Exception:
        lang = None

    info = await fetch_restaurant_info(restaurant_id)
    payload = build_service_selection_payload(info, lang=lang)

    if not payload or payload.get("type") != "interactive":
        return []

    sections = payload["interactive"]["action"]["sections"]
    rows = [row for section in sections for row in section["rows"]]

    # Kitchen closed: still offer Token / Queue (walk-in handoff), hide order flows.
    if not kitchen_accepting_orders(state):
        rows = [r for r in rows if r.get("id") == "token_queue"]

    return rows


def _resolve_choice_from_rows(
    choice_id: str,
    rows: list[dict],
) -> tuple[str | None, str | None]:
    valid_ids = {row.get("id") for row in rows}
    rid = choice_id if choice_id in valid_ids else match_service_row_choice(choice_id, rows)
    if not rid or rid not in valid_ids:
        return (None, None)
    return _parse_row_id(rid)


async def resolve_service_selection(
    restaurant_id: str,
    choice_id: str,
    session_state: dict[str, Any] | None = None,
) -> tuple[str | None, str | None]:
    rows = await build_service_menu_rows(restaurant_id, session_state=session_state)
    return _resolve_choice_from_rows(choice_id, rows)


async def resolve_service_choice(
    restaurant_id: str,
    choice_id: str,
    session_state: dict[str, Any] | None = None,
) -> str | None:
    feature, _ = await resolve_service_selection(
        restaurant_id,
        choice_id,
        session_state=session_state,
    )
    return feature