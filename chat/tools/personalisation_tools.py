"""Personalisation Engine - RFM segmentation and personalised messaging."""

import json
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, List
from decimal import Decimal

from tools.db_tools import get_menu, get_session
from db.models import CustomerProfile, Booking, OrderItem, Customer
from sqlalchemy import select, func, and_, desc, text
from sqlalchemy.orm import selectinload

logger = logging.getLogger(__name__)


# PART A: Profile Builder
async def update_customer_profile(customer_id: str, restaurant_id: str) -> Dict[str, Any]:
    """Recalculate customer profile after every completed booking."""
    
    try:
        from uuid import UUID
        
        async with get_session() as session:
            # Get customer
            result = await session.execute(
                select(Customer).where(Customer.id == UUID(customer_id))
            )
            customer = result.scalar_one_or_none()
            
            if not customer:
                logger.warning(f"Customer {customer_id} not found")
                return {}
            
            # Calculate favourite items (top 5 by order count)
            favourite_items = await _calculate_favourite_items(customer_id, restaurant_id, session)
            
            # Calculate preferred service
            preferred_service = await _calculate_preferred_service(customer_id, restaurant_id, session)
            
            # Calculate preferred day/time
            preferred_day, preferred_time = await _calculate_preferred_patterns(customer_id, restaurant_id, session)
            
            # Calculate avg party size
            avg_party_size = await _calculate_avg_party_size(customer_id, restaurant_id, session)
            
            # Calculate avg spend and total spend
            avg_spend, total_spend = await _calculate_spend_metrics(customer_id, restaurant_id, session)
            
            # Calculate visit streak
            visit_streak = await _calculate_visit_streak(customer_id, restaurant_id, session)
            
            # Calculate RFM segment
            rfm_segment = await calculate_rfm_segment(customer_id, restaurant_id)
            
            # Upsert profile
            profile_data = {
                "customer_id": UUID(customer_id),
                "restaurant_id": UUID(restaurant_id),
                "rfm_segment": rfm_segment,
                "favourite_items": json.dumps(favourite_items) if favourite_items else None,
                "preferred_service": preferred_service,
                "preferred_day": preferred_day,
                "preferred_time": preferred_time,
                "avg_party_size": Decimal(str(avg_party_size)),
                "avg_spend": Decimal(str(avg_spend)),
                "total_spend": Decimal(str(total_spend)),
                "visit_streak": visit_streak,
                "last_rfm_calc": datetime.utcnow(),
            }
            
            # Check if profile exists
            result = await session.execute(
                select(CustomerProfile).where(
                    and_(
                        CustomerProfile.customer_id == UUID(customer_id),
                        CustomerProfile.restaurant_id == UUID(restaurant_id),
                    )
                )
            )
            existing_profile = result.scalar_one_or_none()
            
            if existing_profile:
                # Update existing
                for key, value in profile_data.items():
                    setattr(existing_profile, key, value)
                session.add(existing_profile)
            else:
                # Create new
                profile = CustomerProfile(**profile_data)
                session.add(profile)
            
            await session.commit()
            
            logger.info(f"Profile updated for customer {customer_id}")
            return profile_data
    
    except Exception as e:
        logger.error(f"Error updating customer profile: {e}")
        return {}


async def _calculate_favourite_items(customer_id: str, restaurant_id: str, session) -> List[Dict[str, Any]]:
    """Calculate top 5 favourite items by order count."""
    
    try:
        from uuid import UUID
        
        # Get order items with menu details
        result = await session.execute(
            select(
                OrderItem.menu_item_id,
                func.sum(OrderItem.quantity).label("total_quantity"),
                func.max(Booking.created_at).label("last_ordered"),
            )
            .join(Booking, OrderItem.booking_id == Booking.id)
            .join(OrderItem.menu_item)
            .where(
                and_(
                    Booking.customer_id == UUID(customer_id),
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.status.in_(["confirmed", "completed"]),
                )
            )
            .group_by(OrderItem.menu_item_id)
            .order_by(desc(func.sum(OrderItem.quantity)))
            .limit(5)
        )
        
        items = []
        for row in result:
            # Get menu item name
            menu_result = await session.execute(
                select(OrderItem.menu_item).where(OrderItem.menu_item_id == row.menu_item_id)
            )
            menu_item = menu_result.scalar_one_or_none()
            
            if menu_item:
                items.append({
                    "name": menu_item.name,
                    "order_count": int(row.total_quantity),
                    "last_ordered": row.last_ordered.isoformat() if row.last_ordered else None,
                })
        
        return items
    
    except Exception as e:
        logger.error(f"Error calculating favourite items: {e}")
        return []


async def _calculate_preferred_service(customer_id: str, restaurant_id: str, session) -> str | None:
    """Calculate most frequent service type."""
    
    try:
        from uuid import UUID
        
        result = await session.execute(
            select(
                Booking.service_type,
                func.count(Booking.id).label("count"),
            )
            .where(
                and_(
                    Booking.customer_id == UUID(customer_id),
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.status.in_(["confirmed", "completed"]),
                )
            )
            .group_by(Booking.service_type)
            .order_by(desc(func.count(Booking.id)))
            .limit(1)
        )
        
        row = result.first()
        return row.service_type if row else None
    
    except Exception as e:
        logger.error(f"Error calculating preferred service: {e}")
        return None


async def _calculate_preferred_patterns(customer_id: str, restaurant_id: str, session) -> tuple[str | None, str | None]:
    """Calculate preferred day and time patterns."""
    
    try:
        from uuid import UUID
        
        # Preferred day
        result = await session.execute(
            select(
                func.extract("dow", Booking.created_at).label("day_of_week"),
                func.count(Booking.id).label("count"),
            )
            .where(
                and_(
                    Booking.customer_id == UUID(customer_id),
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.status.in_(["confirmed", "completed"]),
                )
            )
            .group_by(func.extract("dow", Booking.created_at))
            .order_by(desc(func.count(Booking.id)))
            .limit(1)
        )
        
        day_row = result.first()
        preferred_day = None
        if day_row:
            day_names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
            preferred_day = day_names[int(day_row.day_of_week)]
        
        # Preferred time
        result = await session.execute(
            select(
                func.extract("hour", Booking.created_at).label("hour"),
                func.count(Booking.id).label("count"),
            )
            .where(
                and_(
                    Booking.customer_id == UUID(customer_id),
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.status.in_(["confirmed", "completed"]),
                )
            )
            .group_by(func.extract("hour", Booking.created_at))
            .order_by(desc(func.count(Booking.id)))
            .limit(1)
        )
        
        time_row = result.first()
        preferred_time = None
        if time_row:
            hour = int(time_row.hour)
            if 6 <= hour < 11:
                preferred_time = "morning"
            elif 11 <= hour < 15:
                preferred_time = "lunch"
            elif 15 <= hour < 18:
                preferred_time = "snacks"
            elif 18 <= hour < 22:
                preferred_time = "dinner"
            else:
                preferred_time = "late"
        
        return preferred_day, preferred_time
    
    except Exception as e:
        logger.error(f"Error calculating preferred patterns: {e}")
        return None, None


async def _calculate_avg_party_size(customer_id: str, restaurant_id: str, session) -> float:
    """Calculate average party size from dine-in bookings."""
    
    try:
        from uuid import UUID
        
        result = await session.execute(
            select(func.avg(Booking.party_size))
            .where(
                and_(
                    Booking.customer_id == UUID(customer_id),
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.service_type == "dine_in",
                    Booking.status.in_(["confirmed", "completed"]),
                    Booking.party_size.isnot(None),
                )
            )
        )
        
        avg = result.scalar()
        return float(avg) if avg else 0.0
    
    except Exception as e:
        logger.error(f"Error calculating avg party size: {e}")
        return 0.0


async def _calculate_spend_metrics(customer_id: str, restaurant_id: str, session) -> tuple[float, float]:
    """Calculate average spend and total spend."""
    
    try:
        from uuid import UUID
        
        # Get all completed bookings with payment
        result = await session.execute(
            select(Booking)
            .where(
                and_(
                    Booking.customer_id == UUID(customer_id),
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.status.in_(["confirmed", "completed"]),
                    Booking.payment_status == "paid",
                )
            )
        )
        
        bookings = result.scalars().all()
        
        if not bookings:
            return 0.0, 0.0
        
        # Calculate total spend from order items
        total_spend = 0.0
        for booking in bookings:
            for order_item in booking.order_items:
                total_spend += float(order_item.quantity * order_item.unit_price)
        
        avg_spend = total_spend / len(bookings)
        return avg_spend, total_spend
    
    except Exception as e:
        logger.error(f"Error calculating spend metrics: {e}")
        return 0.0, 0.0


async def _calculate_visit_streak(customer_id: str, restaurant_id: str, session) -> int:
    """Calculate consecutive weeks with visits."""
    
    try:
        from uuid import UUID
        
        # Get all visit dates in descending order
        result = await session.execute(
            select(Booking.created_at)
            .where(
                and_(
                    Booking.customer_id == UUID(customer_id),
                    Booking.restaurant_id == UUID(restaurant_id),
                    Booking.status.in_(["confirmed", "completed"]),
                )
            )
            .order_by(desc(Booking.created_at))
        )
        
        visit_dates = [row.created_at.date() for row in result]
        
        if not visit_dates:
            return 0
        
        # Calculate consecutive weeks
        streak = 0
        current_week = visit_dates[0].isocalendar()[1]
        current_year = visit_dates[0].isocalendar()[0]
        
        for visit_date in visit_dates:
            visit_week = visit_date.isocalendar()[1]
            visit_year = visit_date.isocalendar()[0]
            
            if visit_year == current_year and visit_week == current_week:
                continue  # Same week, continue
            elif visit_year == current_year and visit_week == current_week - 1:
                streak += 1
                current_week = visit_week
            elif visit_year == current_year - 1 and visit_week == 52 and current_week == 1:
                # Handle year boundary
                streak += 1
                current_year = visit_year
                current_week = visit_week
            else:
                break  # Streak broken
        
        return streak
    
    except Exception as e:
        logger.error(f"Error calculating visit streak: {e}")
        return 0


# PART B: RFM Calculator
async def calculate_rfm_segment(customer_id: str, restaurant_id: str) -> str:
    """Calculate RFM segment for customer."""
    
    try:
        from uuid import UUID
        
        async with get_session() as session:
            # Get customer
            result = await session.execute(
                select(Customer).where(Customer.id == UUID(customer_id))
            )
            customer = result.scalar_one_or_none()
            
            if not customer:
                return "new_customer"
            
            # Recency score (R)
            recency_score = 1  # Default: >60 days
            if customer.last_visit_date:
                last_visit = datetime.strptime(customer.last_visit_date, "%Y-%m-%d")
                days_since = (datetime.utcnow() - last_visit).days
                
                if days_since <= 7:
                    recency_score = 5
                elif days_since <= 14:
                    recency_score = 4
                elif days_since <= 30:
                    recency_score = 3
                elif days_since <= 60:
                    recency_score = 2
            
            # Frequency score (F)
            frequency_score = min(customer.visit_count, 5)  # Cap at 5
            
            # Monetary score (M) - based on avg spend
            result = await session.execute(
                select(CustomerProfile.avg_spend)
                .where(
                    and_(
                        CustomerProfile.customer_id == UUID(customer_id),
                        CustomerProfile.restaurant_id == UUID(restaurant_id),
                    )
                )
            )
            avg_spend_row = result.scalar_one_or_none()
            avg_spend = float(avg_spend_row) if avg_spend_row else 0
            
            monetary_score = 1
            if avg_spend > 800:
                monetary_score = 5
            elif avg_spend > 500:
                monetary_score = 4
            elif avg_spend > 300:
                monetary_score = 3
            elif avg_spend > 150:
                monetary_score = 2
            
            # Total RFM score
            total_score = recency_score + frequency_score + monetary_score
            
            # Map to segment
            if total_score >= 13:
                segment = "champion"
            elif total_score >= 10:
                segment = "loyal"
            elif total_score >= 7:
                segment = "promising"
            elif total_score >= 5:
                segment = "at_risk"
            elif total_score >= 3:
                segment = "lost"
            else:
                segment = "new_customer"
            
            # Special case: new customer
            if customer.visit_count == 1 and recency_score >= 3:
                segment = "new_customer"
            
            logger.info(f"RFM calculated for {customer_id}: R={recency_score}, F={frequency_score}, M={monetary_score}, segment={segment}")
            return segment
    
    except Exception as e:
        logger.error(f"Error calculating RFM segment: {e}")
        return "new_customer"


# PART C: Personalised Greeting Builder
async def build_personalised_greeting(
    customer_id: str,
    restaurant_id: str,
) -> str:
    """
    Build personalised greeting based on customer profile.
    Accepts (customer_id, restaurant_id) and loads profile internally.
    """
    try:
        from uuid import UUID

        async with get_session() as session:
            result = await session.execute(
                select(Customer).where(Customer.id == UUID(customer_id))
            )
            customer = result.scalar_one_or_none()
            if not customer:
                return "Welcome! "

            # Days since last visit
            days_since = 0
            if customer.last_visit_date:
                last_visit = datetime.strptime(customer.last_visit_date, "%Y-%m-%d")
                days_since = (datetime.utcnow() - last_visit).days

            # Customer profile
            result = await session.execute(
                select(CustomerProfile).where(
                    and_(
                        CustomerProfile.customer_id == UUID(customer_id),
                        CustomerProfile.restaurant_id == UUID(restaurant_id),
                    )
                )
            )
            profile = result.scalar_one_or_none()

            favourite_item = None
            if profile and profile.favourite_items:
                items = (
                    json.loads(profile.favourite_items)
                    if isinstance(profile.favourite_items, str)
                    else profile.favourite_items
                )
                if items:
                    favourite_item = items[0].get("name")

            profile_dict = {
                "rfm_segment": profile.rfm_segment if profile else "new_customer",
                "visit_streak": profile.visit_streak if profile else 0,
                "favourite_item": favourite_item,
                "visit_count": customer.visit_count,
            } if profile else None

            return _build_greeting_text(profile_dict, days_since)

    except Exception as e:
        logger.error(f"Error in build_personalised_greeting: {e}")
        return "Welcome! "


def _build_greeting_text(
    customer_profile: dict | None,
    days_since_last_visit: int,
) -> str:
    """Core greeting logic — pure function, no I/O."""
    if not customer_profile:
        return "Welcome! "

    rfm_segment = customer_profile.get("rfm_segment", "new_customer")
    visit_streak = customer_profile.get("visit_streak", 0)
    favourite_item = customer_profile.get("favourite_item")

    if visit_streak >= 5:
        return f"You have visited us {visit_streak} weeks in a row — you are truly one of our favourites! "

    if rfm_segment == "champion" and favourite_item:
        return f"Shall we get your usual {favourite_item} started? "

    if rfm_segment == "loyal":
        return "Great to see you again! Always a pleasure having you. "

    if 60 <= days_since_last_visit <= 90:
        return "It has been a while — we have missed you. Hope everything is well! "

    if days_since_last_visit > 90:
        return "What a lovely surprise. We have missed having you here! "

    if customer_profile.get("visit_count") == 2:
        return "So glad you chose us again. "

    return "Welcome back! "


# PART D: Order Suggestion Builder
async def build_order_suggestion(
    customer_id: str,
    restaurant_id: str,
) -> str | None:
    """
    Build order suggestion based on customer history.
    Accepts (customer_id, restaurant_id) and loads profile internally.
    """
    try:
        from uuid import UUID

        async with get_session() as session:
            # Fetch the customer profile
            result = await session.execute(
                select(CustomerProfile).where(
                    and_(
                        CustomerProfile.customer_id == UUID(customer_id),
                        CustomerProfile.restaurant_id == UUID(restaurant_id),
                    )
                )
            )
            profile = result.scalar_one_or_none()

            if not profile:
                # No profile yet — surface restaurant-wide popular items
                result = await session.execute(
                    select(
                        OrderItem.menu_item_id,
                        func.sum(OrderItem.quantity).label("total_quantity"),
                    )
                    .join(Booking, OrderItem.booking_id == Booking.id)
                    .where(
                        and_(
                            Booking.restaurant_id == UUID(restaurant_id),
                            Booking.status.in_(["confirmed", "completed"]),
                        )
                    )
                    .group_by(OrderItem.menu_item_id)
                    .order_by(desc(func.sum(OrderItem.quantity)))
                    .limit(3)
                )
                rows = result.all()
                if rows:
                    from db.models import MenuItem
                    names = []
                    for row in rows:
                        mi_result = await session.execute(
                            select(MenuItem).where(MenuItem.id == row.menu_item_id)
                        )
                        mi = mi_result.scalar_one_or_none()
                        if mi:
                            names.append(mi.name)
                    if names:
                        return f"Our most popular: {', '.join(names)}"
                return None

            # Has a profile — use favourite items
            if profile.favourite_items:
                items = (
                    json.loads(profile.favourite_items)
                    if isinstance(profile.favourite_items, str)
                    else profile.favourite_items
                )
                if items:
                    top_item = items[0].get("name")
                    if top_item:
                        return f"Shall we add your usual {top_item}?"

            # Second visit — show last order
            result = await session.execute(
                select(Customer).where(Customer.id == UUID(customer_id))
            )
            customer = result.scalar_one_or_none()
            if customer and customer.visit_count == 2:
                order_result = await session.execute(
                    select(OrderItem)
                    .join(Booking, OrderItem.booking_id == Booking.id)
                    .where(
                        and_(
                            Booking.customer_id == UUID(customer_id),
                            Booking.restaurant_id == UUID(restaurant_id),
                            Booking.status.in_(["confirmed", "completed"]),
                        )
                    )
                    .order_by(desc(Booking.created_at))
                    .limit(3)
                )
                order_items = order_result.scalars().all()
                names = []
                for oi in order_items:
                    if oi.menu_item:
                        names.append(oi.menu_item.name)
                if names:
                    return f"Last time you enjoyed {', '.join(names)}. Same again today?"

            return None

    except Exception as e:
        logger.error(f"Error in build_order_suggestion: {e}")
        return None
