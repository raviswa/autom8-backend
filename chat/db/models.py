"""SQLAlchemy async models for multi-tenant restaurant database."""

from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlalchemy import (
    Boolean, Column, DateTime, Enum, ForeignKey, Integer, JSON,
    Numeric, String, Text, UniqueConstraint, Index, ARRAY, func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship

Base = declarative_base()

# ---------------------------------------------------------------------------
# Feature constants — single source of truth across the whole codebase.
# Every place that checks a subscription uses these string literals.
# ---------------------------------------------------------------------------

class Feature:
    TOKEN_MANAGEMENT = "token_management"
    DINE_IN          = "dine_in"
    TAKEAWAY         = "takeaway"
    DELIVERY         = "delivery"
    RESERVE_TABLE    = "reserve_table"

    ALL = [TOKEN_MANAGEMENT, DINE_IN, TAKEAWAY, DELIVERY, RESERVE_TABLE]

    # Features that require the ordering subsystem (cart, KDS, payments)
    ORDER_FEATURES = [DINE_IN, TAKEAWAY, DELIVERY]


class Restaurant(Base):
    """Core tenant record for each restaurant."""

    __tablename__ = "restaurants"

    id                      = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    name                    = Column(String(255), nullable=False)
    whatsapp_number         = Column(String(20), unique=True, nullable=False, index=True)
    manager_phone           = Column(String(20), nullable=False)
    timezone                = Column(String(50), default="Asia/Kolkata", nullable=False)
    dining_duration_minutes = Column(Integer, default=90, nullable=False)
    payment_mode            = Column(
        Enum("prepay", "postpay", name="payment_mode_enum"),
        default="prepay", nullable=False,
    )
    is_active               = Column(Boolean, default=True, nullable=False)
    created_at              = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # ── Subscription ────────────────────────────────────────────────────────
    # Array of Feature.* strings the restaurant has subscribed to.
    # Minimum 2 required at sign-up (enforced at application layer).
    # Example: ["token_management", "dine_in", "takeaway"]
    subscribed_features = Column(
        ARRAY(String), nullable=False,
        default=list,
        server_default="{}",
    )

    # ── Merged from restaurant_details (migration: consolidate_restaurants) ────
    display_name    = Column(String(255))
    legal_name      = Column(String(255))
    address_line1   = Column(String(255))
    address_line2   = Column(String(255))
    state           = Column(String(100))
    postal_code     = Column(String(20))
    latitude        = Column(Numeric(10, 7))
    longitude       = Column(Numeric(10, 7))
    contact_phone   = Column(String(20))
    contact_email   = Column(String(255))
    website_url     = Column(String(500))
    google_maps_url = Column(String(1000))
    cuisine_type    = Column(String(100))
    opening_hours   = Column(JSON)
    meta_catalog_id = Column(String(64))

    # Relationships (RestaurantDetails removed — table dropped in migration)
    integrations        = relationship("RestaurantIntegration", back_populates="restaurant", cascade="all, delete-orphan")
    subscription        = relationship("RestaurantSubscription",back_populates="restaurant", uselist=False, cascade="all, delete-orphan")
    customers           = relationship("Customer",              back_populates="restaurant", cascade="all, delete-orphan")
    bookings            = relationship("Booking",               back_populates="restaurant", cascade="all, delete-orphan")
    conversations       = relationship("ConversationState",     back_populates="restaurant", cascade="all, delete-orphan")
    tables              = relationship("TableStatus",           back_populates="restaurant", cascade="all, delete-orphan")
    menu_items          = relationship("MenuItem",              back_populates="restaurant", cascade="all, delete-orphan")
    blocked_slots       = relationship("BlockedSlot",           back_populates="restaurant", cascade="all, delete-orphan")
    feedback_items      = relationship("Feedback",              back_populates="restaurant", cascade="all, delete-orphan")
    conversation_events = relationship("ConversationEvent",     back_populates="restaurant", cascade="all, delete-orphan")
    campaigns           = relationship("Campaign",              back_populates="restaurant", cascade="all, delete-orphan")
    campaign_events     = relationship("CampaignEvent",         back_populates="restaurant", cascade="all, delete-orphan")


class RestaurantSubscription(Base):
    """Billing and subscription metadata per restaurant.

    Kept separate from restaurants so billing concerns never pollute the
    operational record and can be updated independently.
    """

    __tablename__ = "restaurant_subscriptions"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), unique=True, nullable=False, index=True)

    # Which features are active — mirrors restaurants.subscribed_features
    # but also carries billing metadata so finance can audit independently.
    features      = Column(ARRAY(String), nullable=False, default=list, server_default="{}")

    # Billing
    billing_cycle = Column(Enum("monthly", "annual", name="billing_cycle_enum"), default="monthly", nullable=False)
    base_price    = Column(Numeric(10, 2), nullable=False, default=0)   # pre-discount total
    discount_pct  = Column(Numeric(5, 2),  nullable=False, default=0)   # 0–100
    final_price   = Column(Numeric(10, 2), nullable=False, default=0)   # what we charge

    # Pass-through cost tracking (updated monthly by billing job)
    last_meta_cost     = Column(Numeric(10, 2), default=0)
    last_razorpay_cost = Column(Numeric(10, 2), default=0)
    last_billed_month  = Column(String(7))    # "YYYY-MM"

    # Status
    status        = Column(
        Enum("trial", "active", "past_due", "cancelled", name="sub_status_enum"),
        default="trial", nullable=False,
    )
    trial_ends_at = Column(DateTime(timezone=True), nullable=True)
    renews_at     = Column(DateTime(timezone=True), nullable=True)

    created_at    = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at    = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    restaurant    = relationship("Restaurant", back_populates="subscription")


# RestaurantDetails class removed — table dropped in migration_consolidate_restaurants.sql
# All columns now live directly on the Restaurant model above.


class RestaurantIntegration(Base):
    """Per-restaurant provider credentials and channel configuration."""

    __tablename__ = "restaurant_integrations"

    id                   = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id        = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    provider             = Column(String(50), nullable=False)
    channel              = Column(String(50), nullable=False)
    external_account_id  = Column(String(255))
    phone_number_id      = Column(String(255))
    api_endpoint         = Column(String(500))
    access_token         = Column(Text)
    refresh_token        = Column(Text)
    webhook_verify_token = Column(String(255))
    webhook_secret       = Column(Text)
    config               = Column(JSON)
    is_active            = Column(Boolean, default=True, nullable=False)
    created_at           = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at           = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("restaurant_id", "provider", "channel", name="uix_restaurant_provider_channel"),
        Index("ix_restaurant_integrations_lookup", "restaurant_id", "provider", "channel", "is_active"),
    )

    restaurant = relationship("Restaurant", back_populates="integrations")


class Customer(Base):
    """Customer registry per restaurant."""

    __tablename__ = "customers"

    id                    = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id         = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    phone                 = Column(String(20), nullable=False)
    name                  = Column(String(255), nullable=False)
    whatsapp_profile_name = Column(String(255))
    last_visit_date       = Column(String(10))
    visit_count           = Column(Integer, default=0, nullable=False)
    opted_in_marketing    = Column(Boolean, default=True, nullable=False)
    created_at            = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    __table_args__ = (
        UniqueConstraint("restaurant_id", "phone", name="uix_restaurant_phone"),
        Index("ix_restaurant_phone", "restaurant_id", "phone"),
    )

    restaurant          = relationship("Restaurant",       back_populates="customers")
    bookings            = relationship("Booking",          back_populates="customer", cascade="all, delete-orphan")
    feedback_items      = relationship("Feedback",         back_populates="customer", cascade="all, delete-orphan")
    name_changes        = relationship("NameChangeLog",    back_populates="customer", cascade="all, delete-orphan")
    profile             = relationship("CustomerProfile",  back_populates="customer", uselist=False, cascade="all, delete-orphan")
    conversation_events = relationship("ConversationEvent",back_populates="customer", cascade="all, delete-orphan")
    campaign_events     = relationship("CampaignEvent",    back_populates="customer", cascade="all, delete-orphan")


class ConversationState(Base):
    __tablename__ = "conversation_states"

    id             = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id  = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    customer_phone = Column(String(20), nullable=False)
    adk_session_id = Column(String(255), nullable=False)
    current_state  = Column(String(100), nullable=False)
    context        = Column(JSON)
    updated_at     = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    restaurant = relationship("Restaurant", back_populates="conversations")


class Booking(Base):
    __tablename__ = "bookings"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id    = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    customer_id      = Column(UUID(as_uuid=True), ForeignKey("customers.id"),   nullable=False, index=True)
    service_type     = Column(Enum("dine_in","takeaway","delivery","reserve_table", name="service_type_enum"), nullable=False)
    table_number     = Column(Integer)
    party_size       = Column(Integer)
    delivery_address = Column(String(500))
    booking_datetime = Column(DateTime(timezone=True))
    status           = Column(Enum("pending","confirmed","rejected","cancelled","completed","no_show", name="booking_status_enum"), nullable=False, default="pending")
    token_number     = Column(String(50))
    token_advance    = Column(Numeric(12, 2))
    payment_status   = Column(Enum("pending","paid","refunded","na", name="payment_status_enum"), nullable=False, default="pending")
    razorpay_order_id     = Column(String(255))
    # Change your line to:
    kds_alert_sent = Column(Boolean, default=False)
    table_confirmed_at    = Column(DateTime(timezone=True))
    menu_prompt_sent      = Column(Boolean, default=False, nullable=False)
    reminder_24h_sent     = Column(Boolean, default=False, nullable=False)
    reminder_1h_sent      = Column(Boolean, default=False, nullable=False)
    feedback_requested    = Column(Boolean, default=False, nullable=False)
    created_at            = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)

    restaurant  = relationship("Restaurant", back_populates="bookings")
    customer    = relationship("Customer",   back_populates="bookings")
    order_items = relationship("OrderItem",  back_populates="booking", cascade="all, delete-orphan")
    feedback    = relationship("Feedback",   back_populates="booking", uselist=False, cascade="all, delete-orphan")


class TableStatus(Base):
    __tablename__ = "table_status"

    id                 = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id      = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    table_number       = Column(Integer, nullable=False)
    status             = Column(Enum("free","occupied", name="table_status_enum"), nullable=False, default="free")
    current_booking_id = Column(UUID(as_uuid=True), ForeignKey("bookings.id"))
    occupied_since     = Column(DateTime(timezone=True))
    auto_release_at    = Column(DateTime(timezone=True))
    warning_sent       = Column(Boolean, default=False, nullable=False)

    __table_args__ = (UniqueConstraint("restaurant_id", "table_number", name="uix_restaurant_table"),)

    restaurant = relationship("Restaurant", back_populates="tables")


class MenuItem(Base):
    __tablename__ = "menu_items"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    name          = Column(String(255), nullable=False)
    price         = Column(Numeric(10, 2), nullable=False)
    category      = Column(String(100), nullable=False)
    is_available  = Column(Boolean, default=True, nullable=False)

    restaurant  = relationship("Restaurant", back_populates="menu_items")
    order_items = relationship("OrderItem",  back_populates="menu_item")


class OrderItem(Base):
    __tablename__ = "order_items"

    id           = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    booking_id   = Column(UUID(as_uuid=True), ForeignKey("bookings.id"),   nullable=False, index=True)
    menu_item_id = Column(UUID(as_uuid=True), ForeignKey("menu_items.id"), nullable=False)
    quantity     = Column(Integer, nullable=False)
    unit_price   = Column(Numeric(10, 2), nullable=False)

    booking   = relationship("Booking",  back_populates="order_items")
    menu_item = relationship("MenuItem", back_populates="order_items")


class BlockedSlot(Base):
    __tablename__ = "blocked_slots"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    date          = Column(String(10), nullable=False)
    slot          = Column(Enum("full","lunch","dinner", name="slot_enum"), nullable=False)
    reason        = Column(String(255))

    restaurant = relationship("Restaurant", back_populates="blocked_slots")


class Feedback(Base):
    __tablename__ = "feedback"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    booking_id    = Column(UUID(as_uuid=True), ForeignKey("bookings.id"),    nullable=False, index=True)
    customer_id   = Column(UUID(as_uuid=True), ForeignKey("customers.id"),   nullable=False)
    restaurant_id = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False)
    rating        = Column(Integer, nullable=False)
    created_at    = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    booking    = relationship("Booking",    back_populates="feedback")
    customer   = relationship("Customer",   back_populates="feedback_items")
    restaurant = relationship("Restaurant", back_populates="feedback_items")


class NameChangeLog(Base):
    __tablename__ = "name_change_log"

    id          = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    customer_id = Column(UUID(as_uuid=True), ForeignKey("customers.id"), nullable=False, index=True)
    old_name    = Column(String(255), nullable=False)
    new_name    = Column(String(255), nullable=False)
    changed_at  = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    reason      = Column(String(255))

    customer = relationship("Customer", back_populates="name_changes")


class CustomerProfile(Base):
    __tablename__ = "customer_profiles"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    customer_id      = Column(UUID(as_uuid=True), ForeignKey("customers.id"),   unique=True, nullable=False, index=True)
    restaurant_id    = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    rfm_segment      = Column(String(50), default="new_customer", nullable=False)
    favourite_items  = Column(JSON)
    preferred_service= Column(String(50))
    preferred_day    = Column(String(20))
    preferred_time   = Column(String(20))
    avg_party_size   = Column(Numeric(5, 2),  default=0, nullable=False)
    avg_spend        = Column(Numeric(10, 2), default=0, nullable=False)
    total_spend      = Column(Numeric(12, 2), default=0, nullable=False)
    visit_streak     = Column(Integer, default=0, nullable=False)
    last_rfm_calc    = Column(DateTime(timezone=True))
    updated_at       = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    customer = relationship("Customer", back_populates="profile")


class ConversationEvent(Base):
    __tablename__ = "conversation_events"

    id            = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    customer_id   = Column(UUID(as_uuid=True), ForeignKey("customers.id"),   nullable=False, index=True)
    session_id    = Column(String(100), nullable=False)
    event_type    = Column(String(50),  nullable=False)
    intent        = Column(String(50))
    raw_message   = Column(Text, nullable=False)
    resolved      = Column(Boolean, default=True, nullable=False)
    created_at    = Column(DateTime(timezone=True), server_default=func.now(), nullable=False, index=True)

    restaurant = relationship("Restaurant", back_populates="conversation_events")
    customer   = relationship("Customer",   back_populates="conversation_events")


class Campaign(Base):
    __tablename__ = "campaigns"

    id               = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    restaurant_id    = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"), nullable=False, index=True)
    name             = Column(String(100), nullable=False)
    message_template = Column(Text, nullable=False)
    campaign_type    = Column(String(50), nullable=False)
    segment_target   = Column(String(255), nullable=False)
    total_sent       = Column(Integer, default=0, nullable=False)
    created_at       = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    restaurant = relationship("Restaurant", back_populates="campaigns")
    events     = relationship("CampaignEvent", back_populates="campaign", cascade="all, delete-orphan")


class CampaignEvent(Base):
    __tablename__ = "campaign_events"

    id                 = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    campaign_id        = Column(UUID(as_uuid=True), ForeignKey("campaigns.id"),    nullable=False, index=True)
    customer_id        = Column(UUID(as_uuid=True), ForeignKey("customers.id"),    nullable=False, index=True)
    restaurant_id      = Column(UUID(as_uuid=True), ForeignKey("restaurants.id"),  nullable=False, index=True)
    sent_at            = Column(DateTime(timezone=True))
    delivered          = Column(Boolean, default=False, nullable=False)
    response_text      = Column(Text)
    response_intent    = Column(String(50))
    converted          = Column(Boolean, default=False, nullable=False)
    converted_at       = Column(DateTime(timezone=True))
    revenue_attributed = Column(Numeric(10, 2))

    campaign   = relationship("Campaign",    back_populates="events")
    customer   = relationship("Customer",    back_populates="campaign_events")
    restaurant = relationship("Restaurant",  back_populates="campaign_events")
