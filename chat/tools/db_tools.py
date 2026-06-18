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
        }


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

    if token_type not in ("dinein", "takeaway", "large_party", "scheduled_delivery"):
        logger.error(f"[walk-in-token] Invalid type: {token_type}")
        return None

    clean_phone = "".join(c for c in str(phone) if c.isdigit()) or None
    status = (
        "pending_approval" if token_type in ("large_party", "scheduled_delivery")
        else "takeaway" if token_type == "takeaway"
        else "waiting"
    )
    actual_pax = 1 if token_type in ("takeaway", "scheduled_delivery") else max(1, int(pax or 1))

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
                  AND status IN ('seated', 'takeaway', 'waiting')
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
                  AND arrived_at >= CURRENT_DATE
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
    Used for service-menu pickup line — not shown on mere returning-customer hint.
    """
    if AsyncSessionLocal is None:
        return None

    phones = _phone_variants(customer_phone)
    if not phones:
        return None

    async with AsyncSessionLocal() as session:
        result = await session.execute(
            text("""
                SELECT order_number, status, source
                FROM orders
                WHERE restaurant_id = CAST(:rid AS uuid)
                  AND customer_phone = ANY(:phones)
                  AND status = 'ready'
                  AND (
                    source = 'takeaway'
                    OR source ILIKE '%takeaway%'
                  )
                  AND created_at >= CURRENT_DATE
                ORDER BY created_at DESC
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
