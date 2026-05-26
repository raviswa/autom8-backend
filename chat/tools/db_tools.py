"""Database tools - ADK-compatible async database operations."""

from datetime import datetime, timedelta
from typing import List, Dict, Optional, Any
from decimal import Decimal
from uuid import UUID
import logging
import hashlib
import time
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
    """Initialize database engine and session factory."""
    global engine, AsyncSessionLocal
    try:
        engine = create_async_engine(
            settings.database_url,
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
        async with engine.begin() as conn:
            await conn.execute(select(1))
        print("Database connection successful")
    except Exception as e:
        print(f"Database connection failed: {e}. Running without database.")
        if settings.environment == "production":
            raise
        engine = None
        AsyncSessionLocal = None

#__________________ Feature Gate___________________
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
_TABLES_CACHE: dict[str, tuple[list, float]] = {}   # ← NEW

_RESTAURANT_TTL = 300
_INTEGRATION_TTL = 300
_MENU_TTL = 300
_TABLES_TTL = 30    # ← 30 seconds — tables change frequently during service


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
                }
                _RESTAURANT_CACHE[whatsapp_number] = (data, now)
                return data
            _RESTAURANT_CACHE[whatsapp_number] = (None, now)
            return None
    except Exception as e:
        logger.error(f"Failed to look up restaurant {whatsapp_number}: {e}")
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
                "phone_number": integration.phone_number,
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


# ─── Customer tools ───────────────────────────────────────────────────────────

async def get_customer(restaurant_id: str, phone: str) -> Dict[str, Any] | None:
    """Look up customer."""
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
            return {
                "id": str(customer.id),
                "restaurant_id": str(customer.restaurant_id),
                "phone": customer.phone,
                "name": customer.name,
                "whatsapp_profile_name": customer.whatsapp_profile_name,
                "last_visit_date": customer.last_visit_date,
                "visit_count": customer.visit_count,
                "opted_in_marketing": customer.opted_in_marketing,
                "created_at": customer.created_at.isoformat() if customer.created_at else None,
            }
        return None


async def create_customer(
    restaurant_id: str, phone: str, name: str, profile_name: str | None = None
) -> Dict[str, Any]:
    """Create a new customer record."""
    async with AsyncSessionLocal() as session:
        customer = Customer(
            restaurant_id=UUID(restaurant_id),
            phone=phone,
            name=name,
            whatsapp_profile_name=profile_name,
            visit_count=1,
        )
        session.add(customer)
        await session.commit()
        await session.refresh(customer)
        return {
            "id": str(customer.id),
            "restaurant_id": str(customer.restaurant_id),
            "phone": customer.phone,
            "name": customer.name,
            "whatsapp_profile_name": customer.whatsapp_profile_name,
            "visit_count": customer.visit_count,
        }


async def update_customer_name(customer_id: str, new_name: str, reason: str = "") -> Dict[str, Any]:
    """Update customer name and log the change."""
    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Customer).where(Customer.id == UUID(customer_id)))
        customer = result.scalar_one_or_none()

        if not customer:
            raise ValueError(f"Customer {customer_id} not found")

        old_name = customer.name
        customer.name = new_name

        log_entry = NameChangeLog(
            customer_id=UUID(customer_id),
            old_name=old_name,
            new_name=new_name,
            reason=reason,
        )
        session.add(log_entry)
        session.add(customer)
        await session.commit()

        return {"id": str(customer.id), "old_name": old_name, "new_name": new_name}


async def update_last_visit(customer_id: str) -> bool:
    """Update customer last_visit_date to today."""
    async with AsyncSessionLocal() as session:
        today = datetime.utcnow().strftime("%Y-%m-%d")
        await session.execute(
            update(Customer)
            .where(Customer.id == UUID(customer_id))
            .values(last_visit_date=today, visit_count=Customer.visit_count + 1)
        )
        await session.commit()
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
# NEW: get_available_tables reads from autom8 Supabase (same DB as the portal)
# so the bot always sees real-time table status rather than a stale local copy.

async def get_available_tables(restaurant_id: str) -> List[Dict[str, Any]]:
    """
    Return all currently available tables for a restaurant, sorted by
    capacity descending (largest first — useful for greedy bin-packing).

    Reads from the autom8 Supabase DB via REST so the status is always
    in sync with the manager portal. Falls back to an empty list on error
    so the booking flow is never blocked.

    Results are cached for _TABLES_TTL seconds (30 s) to avoid hammering
    the DB on every message during a busy service.
    """
    import os as _os
    import httpx as _httpx

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

async def create_booking(
    restaurant_id: str,
    customer_id: str,
    service_type: str,
    party_size: int | None = None,
    booking_datetime: str | None = None,
    table_number: int | None = None,
    delivery_address: str | None = None,
    token_number: str | None = None,
) -> Dict[str, Any]:
    """Create a new booking record."""
    async with AsyncSessionLocal() as session:
        booking = Booking(
            restaurant_id=UUID(restaurant_id),
            customer_id=UUID(customer_id),
            service_type=service_type,
            party_size=party_size,
            booking_datetime=datetime.fromisoformat(booking_datetime) if booking_datetime else None,
            table_number=table_number,
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
    import os as _os
    import httpx as _httpx

    now = time.monotonic()
    cached, ts = _MENU_CACHE.get(restaurant_id, (None, 0.0))
    if cached is not None and now - ts < _MENU_TTL:
        return cached

    _autom8_url = _os.getenv("AUTOM8_SUPABASE_URL", "").rstrip("/")
    _autom8_key = _os.getenv("AUTOM8_SUPABASE_SERVICE_KEY", "")

    if _autom8_url and _autom8_key:
        try:
            from datetime import datetime, timezone, timedelta
            _ist = datetime.now(timezone(timedelta(hours=5, minutes=30)))
            _ist_hour = _ist.hour
            if   6  <= _ist_hour < 11: _slot = "morning_tiffin"
            elif 11 <= _ist_hour < 15: _slot = "lunch"
            elif 15 <= _ist_hour < 19: _slot = "evening_snacks"
            elif 19 <= _ist_hour < 23: _slot = "dinner_tiffin"
            else:                      _slot = None

            # Build base params — or= must NOT go through httpx params dict
            # because httpx percent-encodes the parentheses, which Supabase
            # does not recognise, causing the filter to be silently ignored
            # and ALL items to be returned regardless of time_slot.
            # Instead we append the raw or= string directly to the URL.
            _base_params = (
                f"select=id,name,price,category,time_slot,is_available"
                f"&restaurant_id=eq.{restaurant_id}"
                f"&is_available=eq.true"
                f"&order=category.asc,name.asc"
            )
            if _slot:
                _base_params += f"&or=(time_slot.eq.{_slot},time_slot.eq.all)"

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
                logger.debug(f"[get_menu] {len(data)} items from autom8 DB (slot={_slot})")
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
    """Block a customer from future bot interactions."""
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
            return True
        return False
