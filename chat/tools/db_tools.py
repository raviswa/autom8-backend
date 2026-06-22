"""Database tools - ADK-compatible async database operations"""

from datetime import datetime, timedelta
from typing import List, Dict, Optional, Any
from decimal import Decimal
from uuid import UUID
import json
import logging
import hashlib
import re
import time
import os as _os
import httpx as _httpx
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy import select, update, insert, and_, or_, func, text
from sqlalchemy.orm import selectinload
from sqlalchemy.dialects.postgresql import insert as pg_insert

from db.models import (
    Restaurant,
    RestaurantIntegration,
    Customer,
    Booking,
    TableStatus,
    MenuItem,
    OrderItem,
    BlockedSlot,
    Feedback,
    NameChangeLog,
    ConversationState,
)
from config.settings import settings

logger = logging.getLogger(__name__)

# ─── Database engine ──────────────────────────────────────────────────────────
engine = None
AsyncSessionLocal = None


async def init_db():
    global engine, AsyncSessionLocal
    try:
        db_url = settings.get_db_url()
        engine = create_async_engine(
            db_url,
            echo=False,
            future=True,
            pool_size=10,
            max_overflow=20,
            pool_pre_ping=True,
            pool_recycle=1800,
        )
        AsyncSessionLocal = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )
        # Test connection properly with async context manager
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
            row = await conn.execute(text("""
                SELECT pg_get_constraintdef(oid) AS def
                FROM pg_constraint
                WHERE conrelid = 'public.walk_in_tokens'::regclass
                  AND conname = 'walk_in_tokens_type_check'
            """))
            defn = row.scalar() or ""
            if "scheduled_delivery" in defn:
                logger.info("[boot] ✅ walk_in_tokens_type_check allows scheduled_delivery")
            else:
                logger.error(
                    "[boot] ❌ walk_in_tokens_type_check on THIS DB connection "
                    f"does NOT allow scheduled_delivery: {defn or '(missing)'}"
                )
        print("Database connection successful")
    except Exception as e:
        print(f"Database connection failed: {e}. Running without database.")
        if settings.environment == "production":
            raise
        engine = None
        AsyncSessionLocal = None


# ─── Feature Gate ─────────────────────────────────────────────────────────────

async def get_restaurant_features(restaurant_id: str) -> list[str]:
    """Return the subscribed_features list for a restaurant by ID."""
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(Restaurant).where(Restaurant.id == UUID(restaurant_id))
            )
            restaurant = result.scalar_one_or_none()
            if restaurant and restaurant.subscribed_features:
                return list(restaurant.subscribed_features)
            return []
    except Exception as e:
        logger.error(f"get_restaurant_features failed for {restaurant_id}: {e}")
        return []


# ─── Session helper ───────────────────────────────────────────────────────────

def get_session() -> AsyncSession:
    """Return a new AsyncSession context manager. Use as: async with get_session() as session:"""
    if AsyncSessionLocal is None:
        raise Exception("Database not initialized")
    return AsyncSessionLocal()


# ─── In-process TTL caches ────────────────────────────────────────────────────

_RESTAURANT_CACHE: dict[str, tuple[dict, float]] = {}
_INTEGRATION_CACHE: dict[tuple, tuple[dict | None, float]] = {}
_MENU_CACHE: dict[str, tuple[list, float]] = {}
_TABLES_CACHE: dict[str, tuple[list, float]] = {}

_RESTAURANT_TTL = 300
_INTEGRATION_TTL = 300
_MENU_TTL = 300
_TABLES_TTL = 30    # tables change frequently during service


# ─── Advisory lock helpers ────────────────────────────────────────────────────

def _advisory_lock_key(restaurant_id: str, customer_phone: str) -> int:
    raw = f"{restaurant_id}:{customer_phone}"
    digest = hashlib.sha256(raw.encode()).digest()
    unsigned = int.from_bytes(digest[:8], "big")
    return unsigned if unsigned < (1 << 63) else unsigned - (1 << 64)


@asynccontextmanager
async def customer_lock(restaurant_id: str, customer_phone: str):
    if AsyncSessionLocal is None:
        yield
        return

    lock_key = _advisory_lock_key(restaurant_id, customer_phone)

    async with AsyncSessionLocal() as session:
        await session.execute(text(f"SELECT pg_advisory_lock({lock_key})"))
        try:
            yield
        finally:
            await session.execute(text(f"SELECT pg_advisory_unlock({lock_key})"))


# ─── Session state ────────────────────────────────────────────────────────────

async def get_session_state(restaurant_id: str, customer_phone: str) -> dict:
    """Load conversation session state from DB. Returns empty dict if not found."""
    if AsyncSessionLocal is None:
        return {}

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(ConversationState).where(
                    and_(
                        ConversationState.restaurant_id == UUID(restaurant_id),
                        ConversationState.customer_phone == customer_phone,
                    )
                )
            )
            state_obj = result.scalar_one_or_none()
            if state_obj and state_obj.context:
                return dict(state_obj.context).copy()
            return {}
    except Exception as e:
        logger.error(f"Failed to load session state for {customer_phone}: {e}")
        return {}


async def save_session_state(
    restaurant_id: str,
    customer_phone: str,
    session_state: dict,
) -> bool:
    if AsyncSessionLocal is None:
        return False

    try:
        clean_state = dict(session_state).copy()
        current_state_key = clean_state.get("current_state", "init")
        session_id = f"{restaurant_id}:{customer_phone}"
        now = datetime.utcnow()

        stmt = (
            pg_insert(ConversationState)
            .values(
                restaurant_id=UUID(restaurant_id),
                customer_phone=customer_phone,
                adk_session_id=session_id,
                current_state=current_state_key,
                context=clean_state,
                updated_at=now,
            )
            .on_conflict_do_update(
                index_elements=["restaurant_id", "customer_phone"],
                set_={
                    "current_state": current_state_key,
                    "context": clean_state,
                    "updated_at": now,
                },
            )
        )

        async with AsyncSessionLocal() as session:
            await session.execute(stmt)
            await session.commit()
        return True

    except Exception as e:
        logger.error(f"Failed to save session state for {customer_phone}: {e}")
        return False


# ─── Restaurant tools ─────────────────────────────────────────────────────────

async def get_restaurant_by_whatsapp_number(whatsapp_number: str) -> Dict[str, Any] | None:
    now = time.monotonic()
    cached, ts = _RESTAURANT_CACHE.get(whatsapp_number, (None, 0.0))
    if cached is not None and now - ts < _RESTAURANT_TTL:
        return cached

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(Restaurant).where(Restaurant.whatsapp_number == whatsapp_number)
            )
            restaurant = result.scalar_one_or_none()
            if restaurant:
                data = {
                    "id": str(restaurant.id),
                    "name": restaurant.name,
                    "whatsapp_number": restaurant.whatsapp_number,
                    "manager_phone": restaurant.manager_phone,
                    "timezone": restaurant.timezone,
                    "dining_duration_minutes": restaurant.dining_duration_minutes,
                    "payment_mode": restaurant.payment_mode,
                    "is_active": restaurant.is_active,
                    "meta_catalog_id": getattr(restaurant, "meta_catalog_id", None),
                }
                _RESTAURANT_CACHE[whatsapp_number] = (data, now)
                return data
            _RESTAURANT_CACHE[whatsapp_number] = (None, now)
            return None
    except Exception as e:
        logger.error(f"Failed to look up restaurant {whatsapp_number}: {e}")
        return cached


async def get_restaurant_by_id(restaurant_id: str) -> Dict[str, Any] | None:
    """Look up restaurant by UUID. Uses the same TTL cache as get_restaurant_by_whatsapp_number."""
    cache_key = f"id:{restaurant_id}"
    now = time.monotonic()
    cached, ts = _RESTAURANT_CACHE.get(cache_key, (None, 0.0))
    if cached is not None and now - ts < _RESTAURANT_TTL:
        return cached

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(Restaurant).where(Restaurant.id == UUID(restaurant_id))
            )
            restaurant = result.scalar_one_or_none()
            if restaurant:
                data = {
                    "id":              str(restaurant.id),
                    "name":            restaurant.name,
                    "whatsapp_number": restaurant.whatsapp_number,
                    "manager_phone":   restaurant.manager_phone,
                    "timezone":        restaurant.timezone,
                    "is_active":       restaurant.is_active,
                    "meta_catalog_id": getattr(restaurant, "meta_catalog_id", None),
                }
                _RESTAURANT_CACHE[cache_key] = (data, now)
                return data
            _RESTAURANT_CACHE[cache_key] = (None, now)
            return None
    except Exception as e:
        logger.error(f"Failed to look up restaurant {restaurant_id}: {e}")
        return cached


async def get_restaurant_by_phone_number_id(phone_number_id: str) -> Dict[str, Any] | None:
    """Resolve outlet from Meta webhook metadata.phone_number_id."""
    if not phone_number_id or AsyncSessionLocal is None:
        return None

    cache_key = f"pnid:{phone_number_id}"
    now = time.monotonic()
    cached, ts = _RESTAURANT_CACHE.get(cache_key, (None, 0.0))
    if cached is not None and now - ts < _RESTAURANT_TTL:
        return cached

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(Restaurant)
                .join(
                    RestaurantIntegration,
                    RestaurantIntegration.restaurant_id == Restaurant.id,
                )
                .where(
                    RestaurantIntegration.phone_number_id == str(phone_number_id).strip(),
                    RestaurantIntegration.channel == "whatsapp",
                    RestaurantIntegration.is_active == True,
                    Restaurant.is_active == True,
                )
                .limit(1)
            )
            restaurant = result.scalar_one_or_none()
            if restaurant:
                data = {
                    "id": str(restaurant.id),
                    "name": restaurant.name,
                    "whatsapp_number": restaurant.whatsapp_number,
                    "manager_phone": restaurant.manager_phone,
                    "timezone": restaurant.timezone,
                    "dining_duration_minutes": restaurant.dining_duration_minutes,
                    "payment_mode": restaurant.payment_mode,
                    "is_active": restaurant.is_active,
                    "meta_catalog_id": getattr(restaurant, "meta_catalog_id", None),
                }
                _RESTAURANT_CACHE[cache_key] = (data, now)
                return data
            _RESTAURANT_CACHE[cache_key] = (None, now)
            return None
    except Exception as e:
        logger.error(f"Failed to look up restaurant by phone_number_id {phone_number_id}: {e}")
        return cached


async def get_restaurant_integration(
    restaurant_id: str,
    provider: str,
    channel: str,
) -> Dict[str, Any] | None:
    if AsyncSessionLocal is None:
        return None

    cache_key = (restaurant_id, provider, channel)
    now = time.monotonic()
    cached, ts = _INTEGRATION_CACHE.get(cache_key, (None, 0.0))
    if ts and now - ts < _INTEGRATION_TTL:
        return cached

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(RestaurantIntegration).where(
                    and_(
                        RestaurantIntegration.restaurant_id == UUID(restaurant_id),
                        RestaurantIntegration.provider == provider,
                        RestaurantIntegration.channel == channel,
                        RestaurantIntegration.is_active == True,
                    )
                )
            )
            integration = result.scalar_one_or_none()
            if not integration:
                _INTEGRATION_CACHE[cache_key] = (None, now)
                return None

            data = {
                "id": str(integration.id),
                "restaurant_id": str(integration.restaurant_id),
                "provider": integration.provider,
                "channel": integration.channel,
                "external_account_id": integration.external_account_id,
                "phone_number_id": integration.phone_number_id,
                "api_endpoint": integration.api_endpoint,
                "access_token": integration.access_token,
                "refresh_token": integration.refresh_token,
                "webhook_verify_token": integration.webhook_verify_token,
                "webhook_secret": integration.webhook_secret,
                "config": integration.config or {},
                "is_active": integration.is_active,
            }
            _INTEGRATION_CACHE[cache_key] = (data, now)
            return data
    except Exception as e:
        logger.error(f"Failed to get integration for {restaurant_id}: {e}")
        return cached


# ─── autom8 Supabase helpers ──────────────────────────────────────────────────
# Shared by customer tools (and menu/tables already inline below).

def _a8_base() -> str:
    return _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")


def _a8_headers() -> dict:
    key = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
    return {
        "apikey":        key,
        "Authorization": f"Bearer {key}",
        "Content-Type":  "application/json",
        "Prefer":        "return=representation",
    }


def _row_to_customer(r: dict) -> Dict[str, Any]:
    """Normalise a Supabase customers row to the shape the rest of the code expects."""
    return {
        "id":                    r["id"],
        "restaurant_id":         r["restaurant_id"],
        "phone":                 r["phone"],
        "name":                  r.get("name") or "",
        "whatsapp_profile_name": r.get("whatsapp_profile_name"),
        "last_visit_date":       r.get("last_visit_date"),
        "visit_count":           int(r.get("visit_count") or 1),
        "opted_in_marketing":    bool(r.get("opted_in_marketing", True)),
        "created_at":            r.get("created_at"),
    }


# ─── Customer tools ───────────────────────────────────────────────────────────
#
# WHY DUAL-WRITE:
#   autom8 Supabase  → primary / source-of-truth → portal dashboard shows customers
#   local Railway DB → mirror                    → SQLAlchemy relationship joins in
#                                                  get_todays_bookings, find_customer_booking,
#                                                  get_bookings_needing_menu_prompt, etc.
#                                                  still return .customer.name/.phone
#
# READ always comes from autom8 Supabase (freshest data).
# WRITES go to Supabase first; local mirror is best-effort (non-fatal on failure).


async def lookup_customer_status(
    restaurant_id: str,
    phone: str,
) -> tuple[Dict[str, Any] | None, bool]:
    """
    Returns (customer_record, is_new).
    is_new is True when this phone has no row in customers for this restaurant.
    """
    customer = await get_customer(restaurant_id, phone)
    if customer:
        return customer, False
    return None, True


async def get_customer(restaurant_id: str, phone: str) -> Dict[str, Any] | None:
    """Look up customer — reads from autom8 Supabase."""
    base = _a8_base()
    if not base:
        logger.warning("[get_customer] AUTOM8_SUPABASE_URL not set")
        return None
    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                f"{base}/rest/v1/customers",
                params={
                    "select":        "id,restaurant_id,phone,name,whatsapp_profile_name,"
                                     "last_visit_date,visit_count,opted_in_marketing,created_at",
                    "restaurant_id": f"eq.{restaurant_id}",
                    "phone":         f"eq.{phone}",
                    "limit":         "1",
                },
                headers=_a8_headers(),
            )
        if resp.status_code == 200:
            rows = resp.json()
            return _row_to_customer(rows[0]) if rows else None
        logger.warning(f"[get_customer] Supabase {resp.status_code}: {resp.text}")
        return None
    except Exception as e:
        logger.error(f"[get_customer] failed for {phone}: {e}")
        return None


async def create_customer(
    restaurant_id: str,
    phone: str,
    name: str,
    profile_name: str | None = None,
) -> Dict[str, Any]:
    """
    Create a new customer.

    1. Writes to autom8 Supabase (portal visibility — primary).
    2. Mirrors to local Railway DB (SQLAlchemy relationship joins — best-effort).

    Returns the customer dict using the UUID assigned by Supabase so that
    both databases carry the same customer ID.
    """
    base = _a8_base()
    created_data: Dict[str, Any] | None = None

    # ── 1. autom8 Supabase (primary) ──────────────────────────────────────────
    if base:
        try:
            async with _httpx.AsyncClient(timeout=5) as client:
                resp = await client.post(
                    f"{base}/rest/v1/customers",
                    json={
                        "restaurant_id":         restaurant_id,
                        "phone":                 phone,
                        "name":                  name,
                        "whatsapp_profile_name": profile_name,
                        "visit_count":           1,
                        "opted_in_marketing":    True,
                    },
                    headers=_a8_headers(),
                )
            if resp.status_code in (200, 201):
                rows = resp.json()
                row = rows[0] if isinstance(rows, list) else rows
                created_data = _row_to_customer(row)
                logger.info(
                    f"[create_customer] Supabase: {phone} → {created_data['id']}"
                )
            else:
                logger.error(
                    f"[create_customer] Supabase {resp.status_code}: {resp.text}"
                )
        except Exception as e:
            logger.error(f"[create_customer] Supabase write failed for {phone}: {e}")
    else:
        logger.warning("[create_customer] AUTOM8_SUPABASE_URL not set — skipping Supabase write")

    # ── 2. Local Railway DB mirror (best-effort) ───────────────────────────────
    # Use the UUID from Supabase so both DBs share the same customer ID.
    if AsyncSessionLocal is not None:
        try:
            supabase_uuid = UUID(created_data["id"]) if created_data else None
            async with AsyncSessionLocal() as session:
                customer = Customer(
                    restaurant_id=UUID(restaurant_id),
                    phone=phone,
                    name=name,
                    whatsapp_profile_name=profile_name,
                    visit_count=1,
                )
                # Inject the Supabase-assigned UUID when available
                if supabase_uuid:
                    customer.id = supabase_uuid
                session.add(customer)
                await session.commit()
                await session.refresh(customer)

                # Fall back to local data only if Supabase write failed
                if created_data is None:
                    created_data = {
                        "id":                    str(customer.id),
                        "restaurant_id":         str(customer.restaurant_id),
                        "phone":                 customer.phone,
                        "name":                  customer.name,
                        "whatsapp_profile_name": customer.whatsapp_profile_name,
                        "visit_count":           customer.visit_count,
                        "last_visit_date":       None,
                        "opted_in_marketing":    True,
                        "created_at":            None,
                    }
                logger.debug(f"[create_customer] local mirror OK for {phone}")
        except Exception as e:
            logger.warning(f"[create_customer] local mirror failed (non-fatal): {e}")

    if created_data is None:
        raise RuntimeError(
            f"[create_customer] all write targets failed for {phone}"
        )

    return created_data


async def update_customer_name(
    customer_id: str,
    new_name: str,
    reason: str = "",
) -> Dict[str, Any]:
    """
    Update customer name.

    1. PATCHes autom8 Supabase (primary).
    2. Updates local Railway DB mirror.
    3. Appends a NameChangeLog entry in local DB (best-effort).
    """
    base = _a8_base()
    old_name: str | None = None

    # ── 1. Fetch old name from Supabase ───────────────────────────────────────
    if base:
        try:
            async with _httpx.AsyncClient(timeout=5) as client:
                r = await client.get(
                    f"{base}/rest/v1/customers",
                    params={"select": "name", "id": f"eq.{customer_id}", "limit": "1"},
                    headers=_a8_headers(),
                )
            if r.status_code == 200 and r.json():
                old_name = r.json()[0].get("name")
        except Exception as e:
            logger.warning(f"[update_customer_name] couldn't fetch old name: {e}")

    # ── 2. PATCH Supabase ──────────────────────────────────────────────────────
        try:
            async with _httpx.AsyncClient(timeout=5) as client:
                resp = await client.patch(
                    f"{base}/rest/v1/customers",
                    params={"id": f"eq.{customer_id}"},
                    json={"name": new_name},
                    headers=_a8_headers(),
                )
            if resp.status_code not in (200, 204):
                logger.error(
                    f"[update_customer_name] Supabase {resp.status_code}: {resp.text}"
                )
        except Exception as e:
            logger.error(f"[update_customer_name] Supabase PATCH failed: {e}")

    # ── 3. Mirror update to local DB ──────────────────────────────────────────
    if AsyncSessionLocal is not None:
        try:
            async with AsyncSessionLocal() as session:
                await session.execute(
                    update(Customer)
                    .where(Customer.id == UUID(customer_id))
                    .values(name=new_name)
                )
                await session.commit()
        except Exception as e:
            logger.warning(f"[update_customer_name] local mirror update failed (non-fatal): {e}")

    # ── 4. NameChangeLog (local DB, best-effort) ───────────────────────────────
    if AsyncSessionLocal is not None and old_name is not None:
        try:
            async with AsyncSessionLocal() as session:
                log_entry = NameChangeLog(
                    customer_id=UUID(customer_id),
                    old_name=old_name,
                    new_name=new_name,
                    reason=reason,
                )
                session.add(log_entry)
                await session.commit()
        except Exception as e:
            logger.warning(f"[update_customer_name] NameChangeLog write failed (non-fatal): {e}")

    return {"id": customer_id, "old_name": old_name, "new_name": new_name}


async def update_last_visit(customer_id: str) -> bool:
    """
    Update last_visit_date to today and increment visit_count.

    1. Fetches current count from Supabase then PATCHes (Supabase REST doesn't
       support column = column + 1 natively).
    2. Mirrors the same values to local Railway DB.
    """
    base = _a8_base()
    today = datetime.utcnow().strftime("%Y-%m-%d")
    new_count = 2  # safe default if fetch fails

    # ── 1. Supabase read-then-patch ────────────────────────────────────────────
    if base:
        try:
            async with _httpx.AsyncClient(timeout=5) as client:
                r = await client.get(
                    f"{base}/rest/v1/customers",
                    params={"select": "visit_count", "id": f"eq.{customer_id}", "limit": "1"},
                    headers=_a8_headers(),
                )
            if r.status_code == 200 and r.json():
                new_count = int(r.json()[0].get("visit_count") or 1) + 1

            async with _httpx.AsyncClient(timeout=5) as client:
                resp = await client.patch(
                    f"{base}/rest/v1/customers",
                    params={"id": f"eq.{customer_id}"},
                    json={"last_visit_date": today, "visit_count": new_count},
                    headers=_a8_headers(),
                )
            if resp.status_code not in (200, 204):
                logger.warning(
                    f"[update_last_visit] Supabase {resp.status_code}: {resp.text}"
                )
        except Exception as e:
            logger.error(f"[update_last_visit] Supabase update failed: {e}")

    # ── 2. Mirror to local Railway DB ─────────────────────────────────────────
    if AsyncSessionLocal is not None:
        try:
            async with AsyncSessionLocal() as session:
                await session.execute(
                    update(Customer)
                    .where(Customer.id == UUID(customer_id))
                    .values(
                        last_visit_date=today,
                        visit_count=Customer.visit_count + 1,
                    )
                )
                await session.commit()
        except Exception as e:
            logger.warning(f"[update_last_visit] local mirror failed (non-fatal): {e}")

    return True


# ─── Availability tools ───────────────────────────────────────────────────────

async def check_availability(restaurant_id: str, date: str, slot: str) -> bool:
    """Check if date/slot is blocked. Returns True if available."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(BlockedSlot).where(
                and_(
                    BlockedSlot.restaurant_id == UUID(restaurant_id),
                    BlockedSlot.date == date,
                    or_(BlockedSlot.slot == slot, BlockedSlot.slot == "full"),
                )
            )
        )
        blocked = result.scalar_one_or_none()
        return blocked is None


async def get_next_token_number(restaurant_id: str) -> str:
    """
    Get the next sequential token number for today's bookings.
    Tokens reset daily and are formatted as zero-padded 3-digit strings e.g. #001.
    """
    async with AsyncSessionLocal() as session:
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        today_end = today_start + timedelta(days=1)

        result = await session.execute(
            select(func.count(Booking.id)).where(
                and_(
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.created_at >= today_start,
                    Booking.created_at < today_end,
                    Booking.status != "cancelled",
                )
            )
        )
        count = result.scalar() or 0
        return f"#{str(count + 1).zfill(3)}"


# ─── Table availability tools ─────────────────────────────────────────────────

async def get_available_tables(restaurant_id: str) -> List[Dict[str, Any]]:
    """
    Return all currently available tables for a restaurant, sorted by
    capacity descending (largest first — useful for greedy bin-packing).
    """
    now = time.monotonic()
    cached, ts = _TABLES_CACHE.get(restaurant_id, ([], 0.0))
    if cached and now - ts < _TABLES_TTL:
        return cached

    _autom8_url = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
    _autom8_key = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")

    if not _autom8_url or not _autom8_key:
        logger.warning("[get_available_tables] AUTOM8_SUPABASE_URL/KEY not set — returning empty")
        return []

    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                f"{_autom8_url}/rest/v1/tables",
                params={
                    "select":        "table_number,capacity,status,section",
                    "restaurant_id": f"eq.{restaurant_id}",
                    "status":        "eq.available",
                    "is_active":     "eq.true",
                    "order":         "capacity.desc",
                },
                headers={
                    "apikey":        _autom8_key,
                    "Authorization": f"Bearer {_autom8_key}",
                },
            )
        if resp.status_code == 200:
            rows = resp.json()
            data = [
                {
                    "table_number": r["table_number"],
                    "capacity":     int(r.get("capacity") or 0),
                    "section":      r.get("section", ""),
                }
                for r in rows
                if int(r.get("capacity") or 0) > 0
            ]
            _TABLES_CACHE[restaurant_id] = (data, now)
            logger.debug(f"[get_available_tables] {len(data)} available tables for {restaurant_id}")
            return data
        else:
            logger.warning(f"[get_available_tables] Supabase returned {resp.status_code}")
            return cached
    except Exception as e:
        logger.warning(f"[get_available_tables] Failed (non-fatal): {e}")
        return cached


def invalidate_tables_cache(restaurant_id: str) -> None:
    """Invalidate table cache — call after a table status changes."""
    _TABLES_CACHE.pop(restaurant_id, None)


# ─── Booking tools ────────────────────────────────────────────────────────────

def _coerce_table_number(value) -> int | None:
    """Accept int, numeric str, or empty/None — never pass '' to the DB."""
    if value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        cleaned = value.strip()
        if not cleaned or cleaned.lower() == "none":
            return None
        return int(cleaned)
    return int(value)


async def create_booking(
    restaurant_id: str,
    customer_id: str,
    service_type: str,
    party_size: int | None = None,
    booking_datetime: str | None = None,
    table_number: int | str | None = None,
    delivery_address: str | None = None,
    token_number: str | None = None,
) -> Dict[str, Any]:
    """Create a new booking record."""
    table_num = _coerce_table_number(table_number)

    async with AsyncSessionLocal() as session:
        booking = Booking(
            restaurant_id=UUID(restaurant_id),
            customer_id=UUID(customer_id),
            service_type=service_type,
            party_size=party_size,
            booking_datetime=datetime.fromisoformat(booking_datetime) if booking_datetime else None,
            table_number=table_num,
            delivery_address=delivery_address,
            token_number=token_number,
            status="pending",
            payment_status="pending",
        )
        session.add(booking)
        await session.commit()
        await session.refresh(booking)

        return {
            "id": str(booking.id),
            "restaurant_id": str(booking.restaurant_id),
            "customer_id": str(booking.customer_id),
            "service_type": booking.service_type,
            "party_size": booking.party_size,
            "table_number": booking.table_number,
            "delivery_address": booking.delivery_address,
            "token_number": booking.token_number,
            "status": booking.status,
            "payment_status": booking.payment_status,
        }


async def update_booking_status(booking_id: str, status: str) -> Dict[str, Any]:
    """Update booking status."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Booking).where(Booking.id == UUID(booking_id)))
        booking = result.scalar_one_or_none()

        if not booking:
            raise ValueError(f"Booking {booking_id} not found")

        booking.status = status
        session.add(booking)
        await session.commit()

        return {"id": str(booking.id), "status": booking.status}


async def update_booking_payment_status(booking_id: str, payment_status: str) -> Dict[str, Any]:
    """Update booking payment_status (pending|paid|refunded|na)."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Booking).where(Booking.id == UUID(booking_id)))
        booking = result.scalar_one_or_none()

        if not booking:
            raise ValueError(f"Booking {booking_id} not found")

        booking.payment_status = payment_status
        session.add(booking)
        await session.commit()

        return {"id": str(booking.id), "payment_status": booking.payment_status}


async def save_prepay_fulfillment_payload(booking_id: str, payload: dict[str, Any]) -> None:
    """Persist prepay fulfillment payload on the booking row (survives session loss)."""
    if AsyncSessionLocal is None:
        return
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                text("""
                    UPDATE bookings
                    SET prepay_fulfillment_payload = CAST(:payload AS jsonb)
                    WHERE id = CAST(:bid AS uuid)
                """),
                {"bid": booking_id, "payload": json.dumps(payload)},
            )
            await session.commit()
    except Exception as e:
        logger.warning(f"[prepay] save_prepay_fulfillment_payload failed for {booking_id}: {e}")


async def load_prepay_fulfillment_payload(booking_id: str) -> dict[str, Any] | None:
    """Load persisted prepay payload from booking row."""
    if AsyncSessionLocal is None:
        return None
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("""
                    SELECT prepay_fulfillment_payload
                    FROM bookings
                    WHERE id = CAST(:bid AS uuid)
                """),
                {"bid": booking_id},
            )
            row = result.fetchone()
            if not row or not row[0]:
                return None
            data = row[0]
            return dict(data) if isinstance(data, dict) else json.loads(data)
    except Exception as e:
        logger.warning(f"[prepay] load_prepay_fulfillment_payload failed for {booking_id}: {e}")
        return None


async def clear_prepay_fulfillment_payload(booking_id: str) -> None:
    """Remove persisted prepay payload after successful fulfillment."""
    if AsyncSessionLocal is None:
        return
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                text("""
                    UPDATE bookings
                    SET prepay_fulfillment_payload = NULL
                    WHERE id = CAST(:bid AS uuid)
                """),
                {"bid": booking_id},
            )
            await session.commit()
    except Exception as e:
        logger.warning(f"[prepay] clear_prepay_fulfillment_payload failed for {booking_id}: {e}")


async def get_pending_prepay_reminder_candidates(
    min_age_minutes: int = 15,
    max_age_hours: int = 24,
    max_reminders: int = 3,
) -> list[dict[str, Any]]:
    """Bookings awaiting Razorpay prepay that may need a WhatsApp payment reminder."""
    if AsyncSessionLocal is None:
        return []
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("""
                    SELECT
                      b.id::text AS booking_id,
                      b.restaurant_id::text AS restaurant_id,
                      b.service_type,
                      b.token_number,
                      b.prepay_fulfillment_payload AS payload,
                      c.phone AS customer_phone,
                      c.name AS customer_name
                    FROM bookings b
                    JOIN customers c ON c.id = b.customer_id
                    JOIN restaurants r ON r.id = b.restaurant_id
                    WHERE b.payment_status = 'pending'
                      AND b.status = 'pending'
                      AND COALESCE(r.payment_mode, 'prepay') = 'prepay'
                      AND b.prepay_fulfillment_payload IS NOT NULL
                      AND b.created_at < NOW() - (:min_age || ' minutes')::interval
                      AND b.created_at > NOW() - (:max_age || ' hours')::interval
                      AND COALESCE(
                            (b.prepay_fulfillment_payload->>'reminder_count')::int, 0
                          ) < :max_reminders
                    ORDER BY b.created_at ASC
                    LIMIT 30
                """),
                {
                    "min_age": str(min_age_minutes),
                    "max_age": str(max_age_hours),
                    "max_reminders": max_reminders,
                },
            )
            rows = result.mappings().all()
            return [dict(r) for r in rows]
    except Exception as e:
        logger.warning(f"[prepay] get_pending_prepay_reminder_candidates failed: {e}")
        return []


async def increment_prepay_reminder_count(booking_id: str) -> None:
    """Bump reminder_count inside prepay_fulfillment_payload."""
    if AsyncSessionLocal is None:
        return
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(
                text("""
                    UPDATE bookings
                    SET prepay_fulfillment_payload = jsonb_set(
                      COALESCE(prepay_fulfillment_payload, '{}'::jsonb),
                      '{reminder_count}',
                      to_jsonb(
                        COALESCE((prepay_fulfillment_payload->>'reminder_count')::int, 0) + 1
                      ),
                      true
                    )
                    WHERE id = CAST(:bid AS uuid)
                """),
                {"bid": booking_id},
            )
            await session.commit()
    except Exception as e:
        logger.warning(f"[prepay] increment_prepay_reminder_count failed for {booking_id}: {e}")


async def mark_booking_kds_sent(booking_id: str) -> None:
    """Record that this booking was pushed to KDS."""
    if AsyncSessionLocal is None:
        return
    async with AsyncSessionLocal() as session:
        await session.execute(
            text("""
                UPDATE bookings
                SET kds_sent_at = NOW()
                WHERE id = CAST(:bid AS uuid)
                  AND kds_sent_at IS NULL
            """),
            {"bid": booking_id},
        )
        await session.commit()


async def get_paid_bookings_missing_kds() -> List[Dict[str, Any]]:
    """
    Return paid bookings that have no KDS ticket and have not yet been alerted.

    Filters:
      - payment_status = 'paid'
      - kds_alert_sent IS NOT TRUE   ← never re-process an alerted booking
      - created_at > now() - 24h     ← ignore stale historical records
    """
    base = _a8_base()
    if not base:
        logger.warning("[get_paid_bookings_missing_kds] AUTOM8_SUPABASE_URL not set")
        return []

    cutoff = (datetime.utcnow() - timedelta(hours=24)).isoformat()

    try:
        async with _httpx.AsyncClient(timeout=10) as client:

            # ── Step 1: Fetch paid, un-alerted, recent bookings ───────────────
            b_resp = await client.get(
                f"{base}/rest/v1/bookings",
                params={
                    "select":          "id,restaurant_id,token_number,service_type,created_at",
                    "payment_status":  "eq.paid",
                    "kds_alert_sent":  "is.false",
                    "created_at":      f"gte.{cutoff}",
                    "order":           "created_at.asc",
                    "limit":           "50",
                },
                headers=_a8_headers(),
            )
            if b_resp.status_code != 200:
                logger.error(
                    f"[get_paid_bookings_missing_kds] bookings fetch "
                    f"{b_resp.status_code}: {b_resp.text}"
                )
                return []

            bookings = b_resp.json()
            if not bookings:
                return []

            booking_ids = [b["id"] for b in bookings]

            # ── Step 2: Find which booking_ids already have kds_items ─────────
            # kds_items → order_items (booking_id FK)
            oi_resp = await client.get(
                f"{base}/rest/v1/order_items",
                params={
                    "select":     "booking_id",
                    "booking_id": f"in.({','.join(booking_ids)})",
                    "limit":      "500",
                },
                headers=_a8_headers(),
            )
            order_items_with_booking: set[str] = set()
            if oi_resp.status_code == 200:
                for oi in oi_resp.json():
                    bid = oi.get("booking_id")
                    if bid:
                        order_items_with_booking.add(bid)

            # Among those order_items, which have kds_items?
            kds_covered_bookings: set[str] = set()
            if order_items_with_booking:
                oi_ids_resp = await client.get(
                    f"{base}/rest/v1/order_items",
                    params={
                        "select":     "id,booking_id",
                        "booking_id": f"in.({','.join(order_items_with_booking)})",
                        "limit":      "500",
                    },
                    headers=_a8_headers(),
                )
                if oi_ids_resp.status_code == 200:
                    oi_id_map: dict[str, str] = {}   # order_item_id → booking_id
                    for oi in oi_ids_resp.json():
                        if oi.get("id") and oi.get("booking_id"):
                            oi_id_map[oi["id"]] = oi["booking_id"]

                    if oi_id_map:
                        kds_resp = await client.get(
                            f"{base}/rest/v1/kds_items",
                            params={
                                "select":        "order_item_id",
                                "order_item_id": f"in.({','.join(oi_id_map.keys())})",
                                "limit":         "500",
                            },
                            headers=_a8_headers(),
                        )
                        if kds_resp.status_code == 200:
                            for kds in kds_resp.json():
                                oi_id = kds.get("order_item_id")
                                if oi_id and oi_id in oi_id_map:
                                    kds_covered_bookings.add(oi_id_map[oi_id])

            # ── Step 3: Keep only bookings with NO kds coverage ───────────────
            missing_ids = [
                b["id"] for b in bookings
                if b["id"] not in kds_covered_bookings
            ]
            if not missing_ids:
                return []

            # ── Step 4: Enrich with customer + manager phone ──────────────────
            missing_bookings = [b for b in bookings if b["id"] in missing_ids]
            results = []

            for b in missing_bookings:
                restaurant_id = b["restaurant_id"]

                # Customer phone + name via customers table
                cust_resp = await client.get(
                    f"{base}/rest/v1/customers",
                    params={
                        "select":        "name,phone",
                        "restaurant_id": f"eq.{restaurant_id}",
                        # customers are linked via bookings.customer_id;
                        # fetch separately since bookings select is kept minimal
                        "limit":         "1",
                    },
                    headers=_a8_headers(),
                )
                # Better: fetch booking with customer_id then look up customer
                # For now fall back to restaurant manager lookup
                cust_name  = "Guest"
                cust_phone = ""
                if cust_resp.status_code == 200 and cust_resp.json():
                    c = cust_resp.json()[0]
                    cust_name  = c.get("name")  or "Guest"
                    cust_phone = c.get("phone") or ""

                # Manager phone via restaurants table
                r_resp = await client.get(
                    f"{base}/rest/v1/restaurants",
                    params={
                        "select": "manager_phone",
                        "id":     f"eq.{restaurant_id}",
                        "limit":  "1",
                    },
                    headers=_a8_headers(),
                )
                manager_phone = ""
                if r_resp.status_code == 200 and r_resp.json():
                    manager_phone = r_resp.json()[0].get("manager_phone") or ""

                results.append({
                    "booking_id":    b["id"],
                    "restaurant_id": restaurant_id,
                    "token_number":  b.get("token_number"),
                    "service_type":  b.get("service_type"),
                    "customer_name": cust_name,
                    "customer_phone": cust_phone,
                    "manager_phone": manager_phone,
                })

        logger.info(
            f"[get_paid_bookings_missing_kds] "
            f"{len(bookings)} paid bookings checked, {len(results)} missing KDS"
        )
        return results

    except Exception as e:
        logger.error(f"[get_paid_bookings_missing_kds] Error: {e}")
        return []


async def mark_kds_alert_sent(booking_id: str) -> None:
    """
    Silence a booking so reconcile_paid_orders_without_kds never re-processes it.
    Called after a manager alert fires OR after a successful KDS retry.

    Writes to Supabase (primary) and mirrors to Railway DB (best-effort).
    """
    # ── 1. Supabase primary ───────────────────────────────────────────────────
    base = _a8_base()
    if base:
        try:
            async with _httpx.AsyncClient(timeout=5) as client:
                resp = await client.patch(
                    f"{base}/rest/v1/bookings",
                    params={"id": f"eq.{booking_id}"},
                    json={"kds_alert_sent": True},
                    headers={**_a8_headers(), "Prefer": "return=minimal"},
                )
            if resp.status_code not in (200, 204):
                logger.warning(
                    f"[mark_kds_alert_sent] Supabase {resp.status_code}: {resp.text}"
                )
            else:
                logger.info(f"[mark_kds_alert_sent] ✅ Silenced {booking_id[:8]} in Supabase")
        except Exception as e:
            logger.error(f"[mark_kds_alert_sent] Supabase write failed for {booking_id}: {e}")

    # ── 2. Railway DB mirror (best-effort) ────────────────────────────────────
    if AsyncSessionLocal is not None:
        try:
            async with AsyncSessionLocal() as session:
                await session.execute(
                    update(Booking)
                    .where(Booking.id == UUID(booking_id))
                    .values(kds_alert_sent=True)
                )
                await session.commit()
        except Exception as e:
            # Non-fatal — Supabase write above is the source of truth
            logger.warning(
                f"[mark_kds_alert_sent] Railway mirror failed for {booking_id}: {e}"
                                )

async def get_bookings_due_for_kds() -> list[dict]:
    """
    Confirmed scheduled delivery/takeaway bookings whose KDS release window has opened.
    Respects prepay: only dispatches when payment_status = paid if restaurant uses prepay.
    """
    if AsyncSessionLocal is None:
        return []

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                SELECT
                  b.id AS booking_id,
                  b.restaurant_id::text AS restaurant_id,
                  b.service_type,
                  b.token_number,
                  b.delivery_address,
                  b.booking_datetime,
                  c.name AS customer_name,
                  c.phone AS customer_phone,
                  wt.id AS portal_token_id,
                  wt.meta AS token_meta
                FROM bookings b
                JOIN customers c ON c.id = b.customer_id
                JOIN restaurants r ON r.id = b.restaurant_id
                LEFT JOIN walk_in_tokens wt
                  ON wt.meta->>'booking_id' = b.id::text
                WHERE b.status = 'confirmed'
                  AND b.kds_sent_at IS NULL
                  AND b.booking_datetime IS NOT NULL
                  AND b.booking_datetime > NOW()
                  AND b.service_type IN ('delivery', 'takeaway')
                  AND b.booking_datetime - (
                        COALESCE(r.scheduled_kds_lead_minutes, 150) * INTERVAL '1 minute'
                      ) <= NOW()
                  AND (
                    COALESCE(r.payment_mode, 'prepay') <> 'prepay'
                    OR b.payment_status = 'paid'
                  )
                ORDER BY b.booking_datetime ASC
                LIMIT 50
            """),
        )
        rows = []
        for row in result.mappings().all():
            data = dict(row)
            meta = data.get("token_meta") or {}
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except Exception:
                    meta = {}
            data["token_meta"] = meta
            rows.append(data)
        return rows


async def patch_walk_in_token_meta_for_booking(booking_id: str, patch: dict) -> bool:
    """Merge JSON into walk_in_tokens.meta for scheduler KDS dispatch."""
    if AsyncSessionLocal is None or not booking_id:
        return False
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                UPDATE walk_in_tokens
                SET meta = COALESCE(meta, '{}'::jsonb) || CAST(:patch AS jsonb)
                WHERE meta->>'booking_id' = :bid
            """),
            {"bid": str(booking_id), "patch": json.dumps(patch or {})},
        )
        await session.commit()
        return (result.rowcount or 0) > 0


async def patch_walk_in_token_meta(
    token_id: str,
    restaurant_id: str,
    patch: dict,
) -> bool:
    """Merge JSON into a specific walk_in_tokens row."""
    if AsyncSessionLocal is None or not token_id:
        return False
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                UPDATE walk_in_tokens
                SET meta = COALESCE(meta, '{}'::jsonb) || CAST(:patch AS jsonb)
                WHERE id = :tid
                  AND restaurant_id = CAST(:rid AS uuid)
            """),
            {
                "tid": token_id,
                "rid": restaurant_id,
                "patch": json.dumps(patch or {}),
            },
        )
        await session.commit()
        return (result.rowcount or 0) > 0


async def get_todays_bookings(restaurant_id: str) -> List[Dict[str, Any]]:
    async with AsyncSessionLocal() as session:
        today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        today_end = today_start + timedelta(days=1)

        result = await session.execute(
            select(Booking).where(
                and_(
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.created_at >= today_start,
                    Booking.created_at < today_end,
                    Booking.status != "cancelled",
                )
            )
        )
        bookings = result.scalars().all()

        return [
            {
                "id": str(b.id),
                "customer_name": b.customer.name if b.customer else "Unknown",
                "service_type": b.service_type,
                "party_size": b.party_size,
                "booking_datetime": b.booking_datetime.isoformat() if b.booking_datetime else None,
                "table_number": b.table_number,
                "status": b.status,
                "payment_status": b.payment_status,
            }
            for b in bookings
        ]


async def get_booking_by_id(restaurant_id: str, booking_id: str) -> Dict[str, Any] | None:
    """Get a specific booking by ID."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Booking).where(
                and_(
                    Booking.id == UUID(booking_id),
                    Booking.restaurant_id == UUID(restaurant_id),
                )
            )
        )
        booking = result.scalar_one_or_none()

        if booking:
            return {
                "id": str(booking.id),
                "customer_id": str(booking.customer_id),
                "service_type": booking.service_type,
                "party_size": booking.party_size,
                "status": booking.status,
                "payment_status": booking.payment_status,
                "table_number": booking.table_number,
                "delivery_address": booking.delivery_address,
                "token_number": booking.token_number,
                "table_confirmed_at": booking.table_confirmed_at.isoformat() if booking.table_confirmed_at else None,
                "menu_prompt_sent": booking.menu_prompt_sent,
            }
        return None


async def get_booking_with_customer(booking_id: str) -> Dict[str, Any] | None:
    """Load booking with customer phone/name — used by Razorpay webhook fulfillment."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Booking)
            .options(selectinload(Booking.customer))
            .where(Booking.id == UUID(booking_id))
        )
        booking = result.scalar_one_or_none()
        if not booking:
            return None
        customer = booking.customer
        return {
            "id": str(booking.id),
            "restaurant_id": str(booking.restaurant_id),
            "customer_id": str(booking.customer_id),
            "customer_phone": customer.phone if customer else None,
            "customer_name": customer.name if customer else None,
            "service_type": booking.service_type,
            "status": booking.status,
            "payment_status": booking.payment_status,
            "token_number": booking.token_number,
            "kds_sent_at": await _fetch_booking_kds_sent_at(str(booking.id)),
        }


async def _fetch_booking_kds_sent_at(booking_id: str):
    """Read kds_sent_at (column added via migration; may be absent on ORM model)."""
    if AsyncSessionLocal is None:
        return None
    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                text("SELECT kds_sent_at FROM bookings WHERE id = CAST(:bid AS uuid)"),
                {"bid": booking_id},
            )
            row = result.fetchone()
            return row[0] if row else None
    except Exception:
        return None


async def confirm_table_for_booking(booking_id: str, table_number: int) -> Dict[str, Any]:
    """Assign table to booking and record confirmation time for Dine-in flow."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Booking).where(Booking.id == UUID(booking_id)))
        booking = result.scalar_one_or_none()

        if not booking:
            raise ValueError(f"Booking {booking_id} not found")

        booking.table_number = table_number
        booking.table_confirmed_at = datetime.utcnow()
        session.add(booking)
        await session.commit()

        return {
            "id": str(booking.id),
            "table_number": booking.table_number,
            "table_confirmed_at": booking.table_confirmed_at.isoformat(),
        }


async def get_bookings_needing_menu_prompt() -> List[Dict[str, Any]]:
    """Get Dine-in bookings where table was confirmed 3 minutes ago but menu not sent."""
    async with AsyncSessionLocal() as session:
        three_mins_ago = datetime.utcnow() - timedelta(minutes=3)
        result = await session.execute(
            select(Booking)
            .options(selectinload(Booking.customer), selectinload(Booking.restaurant))
            .where(
                and_(
                    Booking.service_type == "dine_in",
                    Booking.table_confirmed_at <= three_mins_ago,
                    Booking.menu_prompt_sent == False,
                )
            )
        )
        bookings = result.scalars().all()

        return [
            {
                "id": str(b.id),
                "customer_id": str(b.customer_id),
                "restaurant_id": str(b.restaurant_id),
                "phone": b.customer.phone if b.customer else None,
                "customer_name": b.customer.name if b.customer else None,
                "table_number": b.table_number,
            }
            for b in bookings
        ]


async def mark_menu_prompt_sent(booking_id: str) -> bool:
    """Mark that the delayed menu prompt was sent."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Booking).where(Booking.id == UUID(booking_id)))
        booking = result.scalar_one_or_none()
        if booking:
            booking.menu_prompt_sent = True
            session.add(booking)
            await session.commit()
            return True
        return False


async def find_customer_booking(restaurant_id: str, search: str) -> List[Dict[str, Any]]:
    """Find bookings by customer name or phone."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Booking).join(Customer).where(
                and_(
                    Booking.restaurant_id == UUID(restaurant_id),
                    or_(
                        Customer.name.ilike(f"%{search}%"),
                        Customer.phone.ilike(f"%{search}%"),
                    ),
                )
            )
        )
        bookings = result.scalars().all()

        return [
            {
                "id": str(b.id),
                "customer_name": b.customer.name if b.customer else "Unknown",
                "phone": b.customer.phone if b.customer else None,
                "service_type": b.service_type,
                "status": b.status,
            }
            for b in bookings
        ]


# ─── Slot tools ───────────────────────────────────────────────────────────────

async def block_slot(restaurant_id: str, date: str, slot: str, reason: str = "") -> bool:
    """Block a date/slot for a restaurant."""
    async with AsyncSessionLocal() as session:
        blocked_slot = BlockedSlot(
            restaurant_id=UUID(restaurant_id),
            date=date,
            slot=slot,
            reason=reason,
        )
        session.add(blocked_slot)
        await session.commit()
        return True


# ─── Menu tools ───────────────────────────────────────────────────────────────

async def get_menu(restaurant_id: str) -> List[Dict[str, Any]]:
    now = time.monotonic()
    cached, ts = _MENU_CACHE.get(restaurant_id, (None, 0.0))
    if cached is not None and now - ts < _MENU_TTL:
        return cached

    _autom8_url = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
    _autom8_key = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")

    if _autom8_url and _autom8_key:
        try:
            _base_params = (
                f"select=id,name,price,category,is_available"
                f"&restaurant_id=eq.{restaurant_id}"
                f"&is_available=eq.true"
                f"&order=category.asc,name.asc"
            )

            _url = f"{_autom8_url}/rest/v1/menu_items?{_base_params}"

            async with _httpx.AsyncClient(timeout=5) as _client:
                _resp = await _client.get(
                    _url,
                    headers={
                        "apikey":        _autom8_key,
                        "Authorization": f"Bearer {_autom8_key}",
                        "Content-Type":  "application/json",
                    },
                )

            if _resp.status_code == 200:
                _rows = _resp.json()
                data = [
                    {
                        "id":       row["id"],
                        "name":     row["name"],
                        "price":    float(row["price"]),
                        "category": row.get("category", ""),
                    }
                    for row in _rows
                ]
                _MENU_CACHE[restaurant_id] = (data, now)
                logger.debug(f"[get_menu] {len(data)} items from autom8 DB")
                return data
            else:
                logger.warning(f"[get_menu] autom8 DB returned {_resp.status_code} — falling back to local")

        except Exception as _e:
            logger.warning(f"[get_menu] autom8 DB fetch failed (non-fatal): {_e} — falling back to local")

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(
                select(MenuItem).where(
                    and_(
                        MenuItem.restaurant_id == UUID(restaurant_id),
                        MenuItem.is_available == True,
                    )
                )
            )
            items = result.scalars().all()
            data = [
                {
                    "id":       str(item.id),
                    "name":     item.name,
                    "price":    float(item.price),
                    "category": item.category,
                }
                for item in items
            ]
            _MENU_CACHE[restaurant_id] = (data, now)
            logger.debug(f"[get_menu] {len(data)} items from local munafe DB")
            return data
    except Exception as e:
        logger.error(f"[get_menu] local DB also failed for {restaurant_id}: {e}")
        return cached if cached is not None else []


def invalidate_menu_cache(restaurant_id: str) -> None:
    _MENU_CACHE.pop(restaurant_id, None)


async def lookup_menu_names_by_retailer_ids(
    restaurant_id: str, retailer_ids: list[str]
) -> dict[str, str]:
    """Resolve retailer SKUs (e.g. E003) to display names without stock filters."""
    ids = sorted({(rid or "").strip() for rid in retailer_ids if (rid or "").strip()})
    if not ids:
        return {}

    _autom8_url = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
    _autom8_key = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")
    if not _autom8_url or not _autom8_key:
        return {}

    quoted = ",".join(f'"{rid}"' for rid in ids)
    params = (
        f"select=retailer_id,name"
        f"&restaurant_id=eq.{restaurant_id}"
        f"&retailer_id=in.({quoted})"
    )
    url = f"{_autom8_url}/rest/v1/menu_items?{params}"

    try:
        async with _httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(
                url,
                headers={
                    "apikey": _autom8_key,
                    "Authorization": f"Bearer {_autom8_key}",
                    "Content-Type": "application/json",
                },
            )
        if resp.status_code != 200:
            return {}
        out: dict[str, str] = {}
        for row in resp.json():
            rid = (row.get("retailer_id") or "").strip()
            name = (row.get("name") or "").strip()
            if rid and name:
                out[rid] = name
                out[rid.upper()] = name
                out[rid.lower()] = name
        return out
    except Exception:
        return {}


async def add_menu_item(
    restaurant_id: str, name: str, price: float, category: str
) -> Dict[str, Any]:
    """Add a new menu item."""
    async with AsyncSessionLocal() as session:
        menu_item = MenuItem(
            restaurant_id=UUID(restaurant_id),
            name=name,
            price=Decimal(str(price)),
            category=category,
            is_available=True,
        )
        session.add(menu_item)
        await session.commit()
        await session.refresh(menu_item)
        invalidate_menu_cache(restaurant_id)
        return {
            "id": str(menu_item.id),
            "name": menu_item.name,
            "price": float(menu_item.price),
            "category": menu_item.category,
        }


async def remove_menu_item(restaurant_id: str, name: str) -> bool:
    """Mark a menu item as unavailable."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(MenuItem).where(
                and_(
                    MenuItem.restaurant_id == UUID(restaurant_id),
                    MenuItem.name == name,
                )
            )
        )
        item = result.scalar_one_or_none()
        if item:
            item.is_available = False
            session.add(item)
            await session.commit()
            invalidate_menu_cache(restaurant_id)
            return True
        return False


# ─── Feedback tools ───────────────────────────────────────────────────────────

async def save_feedback(
    restaurant_id: str, customer_id: str, booking_id: str, rating: int
) -> bool:
    """Save customer feedback rating."""
    async with AsyncSessionLocal() as session:
        feedback = Feedback(
            restaurant_id=UUID(restaurant_id),
            customer_id=UUID(customer_id),
            booking_id=UUID(booking_id),
            rating=rating,
        )
        session.add(feedback)
        await session.commit()
        return True


# ─── Table status tools ───────────────────────────────────────────────────────

async def get_table_statuses(restaurant_id: str) -> List[Dict[str, Any]]:
    """Get current status of all tables."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TableStatus).where(TableStatus.restaurant_id == UUID(restaurant_id))
        )
        tables = result.scalars().all()

        return [
            {
                "table_number": t.table_number,
                "status": t.status,
                "current_booking_id": str(t.current_booking_id) if t.current_booking_id else None,
                "occupied_since": t.occupied_since.isoformat() if t.occupied_since else None,
                "auto_release_at": t.auto_release_at.isoformat() if t.auto_release_at else None,
                "warning_sent": t.warning_sent,
            }
            for t in tables
        ]


async def occupy_table(
    restaurant_id: str,
    table_number: int,
    booking_id: str,
    dining_duration_minutes: int,
) -> bool:
    """Mark table occupied when payment confirmed."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TableStatus).where(
                and_(
                    TableStatus.restaurant_id == UUID(restaurant_id),
                    TableStatus.table_number == table_number,
                )
            )
        )
        table = result.scalar_one_or_none()

        if table:
            now = datetime.utcnow()
            table.status = "occupied"
            table.current_booking_id = UUID(booking_id)
            table.occupied_since = now
            table.auto_release_at = now + timedelta(minutes=dining_duration_minutes)
            table.warning_sent = False
            session.add(table)
            await session.commit()
            return True
        return False


async def release_table(restaurant_id: str, table_number: int, release_method: str) -> bool:
    """Mark table as free. method: manager or auto"""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TableStatus).where(
                and_(
                    TableStatus.restaurant_id == UUID(restaurant_id),
                    TableStatus.table_number == table_number,
                )
            )
        )
        table = result.scalar_one_or_none()

        if table:
            table.status = "free"
            table.current_booking_id = None
            table.occupied_since = None
            table.auto_release_at = None
            table.warning_sent = False
            session.add(table)
            await session.commit()
            return True
        return False


async def extend_table_time(
    restaurant_id: str, table_number: int, additional_minutes: int
) -> Dict[str, Any]:
    """Extend auto-release time for occupied table."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(TableStatus).where(
                and_(
                    TableStatus.restaurant_id == UUID(restaurant_id),
                    TableStatus.table_number == table_number,
                )
            )
        )
        table = result.scalar_one_or_none()

        if table and table.auto_release_at:
            table.auto_release_at = table.auto_release_at + timedelta(minutes=additional_minutes)
            session.add(table)
            await session.commit()
            return {
                "table_number": table.table_number,
                "new_auto_release_at": table.auto_release_at.isoformat(),
            }
        return {}


async def get_unpaid_bookings(restaurant_id: str) -> List[Dict[str, Any]]:
    """Get dine-in bookings with no payment recorded."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Booking).where(
                and_(
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.service_type == "dine_in",
                    Booking.payment_status == "pending",
                )
            )
        )
        bookings = result.scalars().all()

        return [
            {
                "id": str(b.id),
                "customer_id": str(b.customer_id),
                "customer_name": b.customer.name if b.customer else "Unknown",
                "phone": b.customer.phone if b.customer else None,
                "table_number": b.table_number,
            }
            for b in bookings
        ]


async def block_customer(restaurant_id: str, phone: str) -> bool:
    """
    Block a customer from future bot interactions.

    1. PATCHes opted_in_marketing=false in autom8 Supabase (primary).
    2. Mirrors the same flag to local Railway DB.
    """
    base = _a8_base()

    # ── 1. Supabase ───────────────────────────────────────────────────────────
    if base:
        try:
            async with _httpx.AsyncClient(timeout=5) as client:
                resp = await client.patch(
                    f"{base}/rest/v1/customers",
                    params={
                        "restaurant_id": f"eq.{restaurant_id}",
                        "phone":         f"eq.{phone}",
                    },
                    json={"opted_in_marketing": False},
                    headers=_a8_headers(),
                )
            if resp.status_code not in (200, 204):
                logger.warning(
                    f"[block_customer] Supabase {resp.status_code}: {resp.text}"
                )
        except Exception as e:
            logger.error(f"[block_customer] Supabase update failed for {phone}: {e}")

    # ── 2. Local Railway DB mirror ────────────────────────────────────────────
    if AsyncSessionLocal is not None:
        try:
            async with AsyncSessionLocal() as session:
                result = await session.execute(
                    select(Customer).where(
                        and_(
                            Customer.restaurant_id == UUID(restaurant_id),
                            Customer.phone == phone,
                        )
                    )
                )
                customer = result.scalar_one_or_none()
                if customer:
                    customer.opted_in_marketing = False
                    session.add(customer)
                    await session.commit()
        except Exception as e:
            logger.warning(f"[block_customer] local mirror failed (non-fatal): {e}")

    return True


# ─── Reservation reminders ────────────────────────────────────────────────────

async def get_reservation_reminder_candidates(
    hours_ahead: float,
    window_minutes: int,
    reminder_field: str,
) -> List[Dict[str, Any]]:
    """Find reserve_table bookings due for a 24h or 1h WhatsApp reminder."""
    if AsyncSessionLocal is None:
        return []

    from datetime import timezone
    now = datetime.now(timezone.utc)
    target = now + timedelta(hours=hours_ahead)
    window = timedelta(minutes=window_minutes)
    window_start = target - window
    window_end = target + window

    sent_col = getattr(Booking, reminder_field)

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(Booking)
            .options(selectinload(Booking.customer), selectinload(Booking.restaurant))
            .where(
                and_(
                    Booking.service_type == "reserve_table",
                    Booking.status.in_(["pending", "confirmed"]),
                    Booking.booking_datetime.isnot(None),
                    Booking.booking_datetime >= window_start,
                    Booking.booking_datetime <= window_end,
                    sent_col.is_(False),
                )
            )
            .limit(50)
        )
        bookings = result.scalars().all()

        return [
            {
                "id": str(b.id),
                "restaurant_id": str(b.restaurant_id),
                "customer_phone": b.customer.phone if b.customer else None,
                "customer_name": b.customer.name if b.customer else "Guest",
                "restaurant_name": b.restaurant.name if b.restaurant else "the restaurant",
                "party_size": b.party_size or 1,
                "booking_datetime": b.booking_datetime,
            }
            for b in bookings
            if b.customer and b.customer.phone
        ]


def _phone_variants(phone: str) -> list[str]:
    """Build phone variants for walk_in_tokens / conversation_states lookup."""
    digits = "".join(c for c in str(phone) if c.isdigit())
    if not digits:
        return []
    variants = {digits}
    if len(digits) == 10:
        variants.add(f"91{digits}")
    if len(digits) > 10:
        variants.add(digits[-10:])
        if digits.startswith("91") and len(digits) == 12:
            variants.add(digits[2:])
    return list(variants)


async def _next_portal_token_id(session, restaurant_id: str) -> str:
    """Sequential T-001 style ID — mirrors Node generateTokenId()."""
    result = await session.execute(
        text("SELECT id FROM walk_in_tokens WHERE restaurant_id = CAST(:rid AS uuid)"),
        {"rid": restaurant_id},
    )
    max_seq = 0
    for row in result:
        match = re.match(r"^T-(\d+)$", str(row[0]))
        if match:
            max_seq = max(max_seq, int(match.group(1)))
    for attempt in range(20):
        candidate = f"T-{str(max_seq + 1 + attempt).zfill(3)}"
        exists = await session.execute(
            text("SELECT 1 FROM walk_in_tokens WHERE id = :tid"),
            {"tid": candidate},
        )
        if not exists.first():
            return candidate
    return f"T-{str(int(time.time()) % 1_000_000).zfill(6)}"


async def create_walk_in_token_direct(
    restaurant_id: str,
    name: str,
    phone: str,
    token_type: str,
    pax: int = 1,
    meta: dict | None = None,
) -> str | None:
    """
    Insert walk_in_tokens directly via Postgres when the Node API sync fails.
    Chat service always has DB access in production.
    """
    if AsyncSessionLocal is None:
        logger.error("[walk-in-token] DB session not initialized")
        return None

    if token_type not in ("dinein", "takeaway", "large_party", "scheduled_delivery", "scheduled_takeaway"):
        logger.error(f"[walk-in-token] Invalid type: {token_type}")
        return None

    clean_phone = "".join(c for c in str(phone) if c.isdigit()) or None
    status = (
        "pending_approval" if token_type in ("large_party", "scheduled_delivery", "scheduled_takeaway")
        else "takeaway" if token_type == "takeaway"
        else "waiting"
    )
    actual_pax = 1 if token_type in ("takeaway", "scheduled_delivery", "scheduled_takeaway") else max(1, int(pax or 1))

    existing = await get_active_walk_in_token(restaurant_id, phone)
    if existing and existing.get("type") == token_type:
        logger.info(
            f"[walk-in-token] Reusing active {existing['id']} for {phone} "
            f"(status={existing.get('status')})"
        )
        return existing["id"]

    try:
        async with AsyncSessionLocal() as session:
            token_id = await _next_portal_token_id(session, restaurant_id)
            await session.execute(
                text("""
                    INSERT INTO walk_in_tokens
                      (id, restaurant_id, name, phone, type, pax, status, arrived_at, meta)
                    VALUES
                      (:id, CAST(:rid AS uuid), :name, :phone, :type, :pax, :status,
                       NOW(), CAST(:meta AS jsonb))
                """),
                {
                    "id":     token_id,
                    "rid":    restaurant_id,
                    "name":   name.strip(),
                    "phone":  clean_phone,
                    "type":   token_type,
                    "pax":    actual_pax,
                    "status": status,
                    "meta":   json.dumps(meta or {}),
                },
            )
            await session.commit()
            logger.info(
                f"[walk-in-token] ✅ Direct DB token {token_id} for {name} "
                f"(restaurant={restaurant_id})"
            )
            if token_type == "dinein" and status == "waiting":
                try:
                    from tools.wait_estimate import apply_wait_estimate_to_token
                    from datetime import datetime, timezone
                    await apply_wait_estimate_to_token(
                        restaurant_id,
                        token_id,
                        actual_pax,
                        datetime.now(timezone.utc).isoformat(),
                    )
                except Exception as est_err:
                    logger.warning(f"[walk-in-token] wait estimate failed: {est_err}")
            return token_id
    except Exception as e:
        logger.error(f"[walk-in-token] Direct insert failed: {e}")
        return None


async def get_active_walk_in_token(
    restaurant_id: str,
    customer_phone: str,
) -> dict | None:
    """
    Return the most recent active walk_in_token for this customer today.
    Used to recover session state when the portal approved a table but the
    chat session was not synced.
    """
    if AsyncSessionLocal is None:
        return None

    phones = _phone_variants(customer_phone)
    if not phones:
        return None

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                SELECT id, status, pax, table_number, meta, type, phone
                FROM walk_in_tokens
                WHERE restaurant_id = CAST(:rid AS uuid)
                  AND phone = ANY(:phones)
                  AND status IN ('seated', 'takeaway', 'waiting', 'pending_approval')
                  AND arrived_at >= CURRENT_DATE
                ORDER BY arrived_at DESC
                LIMIT 1
            """),
            {"rid": restaurant_id, "phones": phones},
        )
        row = result.mappings().first()
        if not row:
            return None
        return dict(row)


async def get_scheduled_delivery_token(
    restaurant_id: str,
    customer_phone: str,
) -> dict | None:
    """Return today's scheduled_delivery token for approval polling."""
    if AsyncSessionLocal is None:
        return None

    phones = _phone_variants(customer_phone)
    if not phones:
        return None

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                SELECT id, status, pax, meta, type, phone
                FROM walk_in_tokens
                WHERE restaurant_id = CAST(:rid AS uuid)
                  AND phone = ANY(:phones)
                  AND type = 'scheduled_delivery'
                  AND status IN ('pending_approval', 'takeaway')
                ORDER BY arrived_at DESC
                LIMIT 1
            """),
            {"rid": restaurant_id, "phones": phones},
        )
        row = result.mappings().first()
        if not row:
            return None
        data = dict(row)
        meta = data.get("meta") or {}
        if isinstance(meta, str):
            try:
                meta = json.loads(meta)
            except Exception:
                meta = {}
        data["meta"] = meta
        return data


def apply_walk_in_token_to_session(session_state: dict, token: dict) -> None:
    """Merge portal token data into the chat session state."""
    if token.get("id"):
        session_state["display_token"] = token["id"]
        session_state["token_number"] = token["id"]

    if token.get("pax"):
        session_state["party_size"] = int(token["pax"])

    meta = token.get("meta") or {}
    if isinstance(meta, str):
        try:
            import json
            meta = json.loads(meta)
        except Exception:
            meta = {}

    combo = meta.get("combo") or []
    if combo:
        table_numbers = [str(row[0]) for row in combo if row]
        session_state["assigned_tables"] = table_numbers
        if table_numbers:
            try:
                session_state["table_number"] = int(table_numbers[0])
            except (TypeError, ValueError):
                pass
    elif token.get("table_number") is not None:
        try:
            session_state["table_number"] = int(token["table_number"])
        except (TypeError, ValueError):
            session_state["table_number"] = token["table_number"]

    session_state["service_type"] = session_state.get("service_type") or "dine_in"
    session_state["booking_step"] = "awaiting_order"
    session_state.pop("_order_retry_attempted", None)


async def recover_session_from_walk_in_token(
    restaurant_id: str,
    customer_phone: str,
    session_state: dict,
) -> bool:
    """Load seated token from portal and apply to session. Returns True if recovered."""
    token = await get_active_walk_in_token(restaurant_id, customer_phone)
    if not token or token.get("status") != "seated":
        return False
    apply_walk_in_token_to_session(session_state, token)
    logger.info(
        f"[token-recovery] Synced session from {token.get('id')} "
        f"tables={session_state.get('assigned_tables') or session_state.get('table_number')}"
    )
    return True


def _display_token_from_order_number(order_number: str) -> str:
    """ORD-098 → T-098 for customer-facing copy."""
    on = str(order_number or "").strip()
    if on.upper().startswith("ORD-"):
        return f"T-{on[4:]}"
    return on


async def get_ready_takeaway_order(
    restaurant_id: str,
    customer_phone: str,
) -> dict | None:
    """
    Return today's takeaway order marked ready by kitchen/captain (status=ready).
    Excludes stale ready rows and orders tied to completed visits.
    """
    if AsyncSessionLocal is None:
        return None

    phones = _phone_variants(customer_phone)
    if not phones:
        return None

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                SELECT o.order_number, o.status, o.source, o.updated_at
                FROM orders o
                WHERE o.restaurant_id = CAST(:rid AS uuid)
                  AND o.customer_phone = ANY(:phones)
                  AND o.status = 'ready'
                  AND (
                    o.source = 'takeaway'
                    OR o.source ILIKE '%takeaway%'
                  )
                  AND o.created_at >= CURRENT_DATE
                  AND o.updated_at >= NOW() - INTERVAL '3 hours'
                  AND NOT EXISTS (
                    SELECT 1 FROM walk_in_tokens t
                    WHERE t.restaurant_id = o.restaurant_id
                      AND regexp_replace(t.phone, '\\D', '', 'g') = ANY(:phones)
                      AND t.status = 'completed'
                      AND t.completed_at >= o.created_at
                  )
                ORDER BY o.updated_at DESC
                LIMIT 1
            """),
            {"rid": restaurant_id, "phones": phones},
        )
        row = result.mappings().first()
        if not row:
            return None
        data = dict(row)
        data["display_token"] = _display_token_from_order_number(data.get("order_number", ""))
        return data


async def mark_reservation_reminder_sent(booking_id: str, reminder_field: str) -> None:
    if AsyncSessionLocal is None:
        return

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Booking).where(Booking.id == UUID(booking_id)))
        booking = result.scalar_one_or_none()
        if not booking:
            return
        setattr(booking, reminder_field, True)
        session.add(booking)
        await session.commit()

async def count_orders_for_slot(restaurant_id: str, slot_iso: str) -> int:
    """Count scheduled orders occupying a 30-minute slot bucket."""
    if AsyncSessionLocal is None:
        return 0
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                SELECT COUNT(*)::int AS cnt
                FROM bookings b
                WHERE b.restaurant_id = CAST(:rid AS uuid)
                  AND b.scheduled_slot_at IS NOT NULL
                  AND date_trunc('hour', b.scheduled_slot_at AT TIME ZONE 'Asia/Kolkata')
                      + (floor(extract(minute from b.scheduled_slot_at AT TIME ZONE 'Asia/Kolkata') / 30) * interval '30 min')
                    = date_trunc('hour', CAST(:slot AS timestamptz) AT TIME ZONE 'Asia/Kolkata')
                      + (floor(extract(minute from CAST(:slot AS timestamptz) AT TIME ZONE 'Asia/Kolkata') / 30) * interval '30 min')
                  AND b.status NOT IN ('cancelled', 'rejected')
                  AND (
                    b.payment_status = 'paid'
                    OR EXISTS (
                      SELECT 1 FROM walk_in_tokens wt
                      WHERE wt.meta->>'booking_id' = b.id::text
                        AND wt.status = 'pending_approval'
                    )
                  )
            """),
            {"rid": restaurant_id, "slot": slot_iso},
        )
        row = result.mappings().first()
        return int(row["cnt"]) if row else 0


async def update_booking_schedule(
    booking_id: str,
    *,
    kitchen_start_at: str | None = None,
    scheduled_slot_at: str | None = None,
    total_cook_minutes: int | None = None,
    total_packing_minutes: float | None = None,
    schedule_meta: dict | None = None,
) -> bool:
    if AsyncSessionLocal is None or not booking_id:
        return False
    patches: dict[str, Any] = {}
    if kitchen_start_at:
        patches["kitchen_start_at"] = datetime.fromisoformat(
            kitchen_start_at.replace("Z", "+00:00")
        )
    if scheduled_slot_at:
        patches["scheduled_slot_at"] = datetime.fromisoformat(
            scheduled_slot_at.replace("Z", "+00:00")
        )
        patches["booking_datetime"] = patches["scheduled_slot_at"]
    if total_cook_minutes is not None:
        patches["total_cook_minutes"] = total_cook_minutes
    if total_packing_minutes is not None:
        patches["total_packing_minutes"] = total_packing_minutes
    if schedule_meta is not None:
        patches["schedule_meta"] = schedule_meta
    if not patches:
        return False

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            update(Booking).where(Booking.id == UUID(booking_id)).values(**patches)
        )
        await session.commit()
        return (result.rowcount or 0) > 0


async def fetch_menu_timing_map(restaurant_id: str) -> dict[str, dict[str, Any]]:
    """retailer_id → timing fields for kitchen scheduler."""
    if AsyncSessionLocal is None:
        return {}
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(MenuItem).where(MenuItem.restaurant_id == UUID(restaurant_id))
        )
        items = result.scalars().all()
        out: dict[str, dict[str, Any]] = {}
        for m in items:
            key = str(m.retailer_id or m.id)
            out[key] = {
                "name": m.name,
                "prep_time_fixed": getattr(m, "prep_time_fixed", 5),
                "batch_size": getattr(m, "batch_size", 1),
                "time_per_batch": getattr(m, "time_per_batch", 10),
                "kitchen_station": getattr(m, "kitchen_station", "assembly"),
                "packing_time": float(getattr(m, "packing_time", 1) or 1),
                "holds_well": bool(getattr(m, "holds_well", False)),
            }
        return out


async def enqueue_scheduled_jobs(
    restaurant_id: str,
    booking_id: str,
    token_id: str,
    kitchen_start_iso: str,
    payload: dict[str, Any],
) -> int:
    if AsyncSessionLocal is None:
        return 0
    jobs = [
        {
            "restaurant_id": UUID(restaurant_id),
            "booking_id": UUID(booking_id),
            "token_id": token_id,
            "job_type": "kds_dispatch",
            "run_at": datetime.fromisoformat(kitchen_start_iso.replace("Z", "+00:00")),
            "status": "pending",
            "idempotency_key": f"kds_dispatch:{booking_id}",
            "payload": payload,
        },
        {
            "restaurant_id": UUID(restaurant_id),
            "booking_id": UUID(booking_id),
            "token_id": token_id,
            "job_type": "prep_start_whatsapp",
            "run_at": datetime.fromisoformat(kitchen_start_iso.replace("Z", "+00:00")),
            "status": "pending",
            "idempotency_key": f"prep_start_whatsapp:{booking_id}",
            "payload": payload,
        },
    ]
    async with AsyncSessionLocal() as session:
        for job in jobs:
            await session.execute(
                text("""
                    INSERT INTO scheduled_jobs
                      (restaurant_id, booking_id, token_id, job_type, run_at, status, idempotency_key, payload)
                    VALUES
                      (CAST(:restaurant_id AS uuid), CAST(:booking_id AS uuid), :token_id,
                       :job_type, :run_at, :status, :idempotency_key, CAST(:payload AS jsonb))
                    ON CONFLICT (idempotency_key) DO UPDATE SET
                      run_at = EXCLUDED.run_at,
                      payload = EXCLUDED.payload,
                      status = CASE
                        WHEN scheduled_jobs.status = 'cancelled' THEN 'pending'
                        ELSE scheduled_jobs.status
                      END,
                      updated_at = NOW()
                """),
                {
                    "restaurant_id": str(job["restaurant_id"]),
                    "booking_id": str(job["booking_id"]),
                    "token_id": job["token_id"],
                    "job_type": job["job_type"],
                    "run_at": job["run_at"].isoformat(),
                    "status": job["status"],
                    "idempotency_key": job["idempotency_key"],
                    "payload": json.dumps(job["payload"] or {}),
                },
            )
        await session.commit()
    return len(jobs)


async def cancel_scheduled_jobs_for_booking(booking_id: str) -> None:
    if AsyncSessionLocal is None:
        return
    async with AsyncSessionLocal() as session:
        await session.execute(
            text("""
                UPDATE scheduled_jobs
                SET status = 'cancelled', updated_at = NOW()
                WHERE booking_id = CAST(:bid AS uuid) AND status = 'pending'
            """),
            {"bid": booking_id},
        )
        await session.commit()


async def get_scheduled_takeaway_token(restaurant_id: str, customer_phone: str) -> dict | None:
    """Latest scheduled_takeaway token for customer (approval polling)."""
    if AsyncSessionLocal is None:
        return None
    digits = re.sub(r"\D", "", customer_phone or "")
    phones = {digits}
    if len(digits) == 10:
        phones.add(f"91{digits}")
    if len(digits) > 10:
        phones.add(digits[-10:])
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                SELECT id, status, type, meta, name, phone, pax,
                       estimate_display, estimated_wait_minutes, waitlist_depth_at_issue
                FROM walk_in_tokens
                WHERE restaurant_id = CAST(:rid AS uuid)
                  AND type = 'scheduled_takeaway'
                  AND phone = ANY(:phones)
                ORDER BY arrived_at DESC
                LIMIT 1
            """),
            {"rid": restaurant_id, "phones": list(phones)},
        )
        row = result.mappings().first()
        return dict(row) if row else None


async def get_walk_in_token_by_id(restaurant_id: str, token_id: str) -> dict | None:
    """Lookup a walk-in token by id for manager button routing."""
    if AsyncSessionLocal is None or not token_id:
        return None
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                SELECT id, status, type, meta, name, phone, pax,
                       estimate_display, estimated_wait_minutes, waitlist_depth_at_issue
                FROM walk_in_tokens
                WHERE restaurant_id = CAST(:rid AS uuid)
                  AND id = :tid
                LIMIT 1
            """),
            {"rid": restaurant_id, "tid": token_id},
        )
        row = result.mappings().first()
        return dict(row) if row else None

