"""Campaign Intelligence - personalised messaging and analytics."""

import json
import logging
from datetime import datetime, timedelta
from typing import Dict, Any, List
from decimal import Decimal

from tools.db_tools import get_session
from tools.whatsapp_tools import send_whatsapp_message
from tools.personalisation_tools import calculate_rfm_segment
from db.models import Customer, CustomerProfile, Campaign, CampaignEvent
from sqlalchemy import select, func, and_, or_, update
from apscheduler.schedulers.asyncio import AsyncIOScheduler

logger = logging.getLogger(__name__)


# PART A: Segment Calculator
async def calculate_all_segments(restaurant_id: str) -> Dict[str, int]:
    """Calculate RFM segments for all customers in restaurant."""
    
    try:
        from uuid import UUID
        
        async with await get_session() as session:
            # Get all customers for restaurant
            result = await session.execute(
                select(Customer).where(Customer.restaurant_id == UUID(restaurant_id))
            )
            customers = result.scalars().all()
            
            segments = {
                "champion": 0,
                "loyal": 0,
                "promising": 0,
                "at_risk": 0,
                "lost": 0,
                "new_customer": 0,
            }
            
            for customer in customers:
                # Calculate RFM segment
                segment = await calculate_rfm_segment(str(customer.id), restaurant_id)
                
                # Update profile
                profile_result = await session.execute(
                    select(CustomerProfile).where(
                        and_(
                            CustomerProfile.customer_id == customer.id,
                            CustomerProfile.restaurant_id == UUID(restaurant_id),
                        )
                    )
                )
                profile = profile_result.scalar_one_or_none()
                
                if profile:
                    profile.rfm_segment = segment
                    profile.last_rfm_calc = datetime.utcnow()
                    session.add(profile)
                
                segments[segment] += 1
            
            await session.commit()
            
            logger.info(f"Segments calculated for restaurant {restaurant_id}: {segments}")
            return segments
    
    except Exception as e:
        logger.error(f"Error calculating segments: {e}")
        return {}


# PART B: Personalised Campaign Message Generator
async def generate_campaign_message(
    customer_id: str,
    restaurant_id: str,
    campaign_type: str,
    base_message: str,
) -> str:
    """Generate personalised campaign message using Gemini."""
    
    try:
        import google.generativeai as genai
        from config.settings import settings
        
        genai.configure(api_key=settings.google_api_key)
        model = genai.GenerativeModel("gemini-1.5-flash")
        
        # Get customer profile data
        async with await get_session() as session:
            from uuid import UUID
            
            # Get customer
            result = await session.execute(
                select(Customer).where(Customer.id == UUID(customer_id))
            )
            customer = result.scalar_one_or_none()
            
            if not customer:
                return base_message
            
            # Get profile
            result = await session.execute(
                select(CustomerProfile).where(
                    and_(
                        CustomerProfile.customer_id == UUID(customer_id),
                        CustomerProfile.restaurant_id == UUID(restaurant_id),
                    )
                )
            )
            profile = result.scalar_one_or_none()
            
            # Calculate days since last visit
            days_since = 0
            if customer.last_visit_date:
                last_visit = datetime.strptime(customer.last_visit_date, "%Y-%m-%d")
                days_since = (datetime.utcnow() - last_visit).days
            
            # Get favourite item
            favourite_item = None
            if profile and profile.favourite_items:
                try:
                    items = json.loads(profile.favourite_items)
                    if items and len(items) > 0:
                        favourite_item = items[0].get("name")
                except:
                    pass
            
            prompt = f"""
Personalise this WhatsApp campaign message for an Indian restaurant customer.
Return ONLY the message text, no explanation.

Customer:
- Name: {customer.name}
- Segment: {profile.rfm_segment if profile else 'new_customer'}
- Favourite item: {favourite_item or 'not yet known'}
- Preferred service: {profile.preferred_service if profile else 'unknown'}
- Visits: {customer.visit_count}
- Avg spend: Rs {float(profile.avg_spend) if profile else 0}
- Days since last visit: {days_since}

Campaign type: {campaign_type}
Base message: {base_message}

Rules:
- Under 160 characters
- Use customer name
- Reference favourite item if known
- champion/loyal: warm and appreciative tone
- at_risk: gently urgent, not pushy
- lost: surprising and enticing
- new_customer: welcoming and informative
- End with: Reply 1 to book
- Maximum 2 emojis
- Return ONLY the message text
"""
            
            response = model.generate_content(prompt)
            message = response.text.strip()
            
            # Ensure under 160 chars
            if len(message) > 160:
                message = message[:157] + "..."
            
            logger.info(f"Campaign message generated for {customer.name}: {message[:50]}...")
            return message
    
    except Exception as e:
        logger.error(f"Error generating campaign message: {e}")
        return base_message


# PART C: Send Time Optimiser
async def get_optimal_send_time(customer_id: str) -> Dict[str, Any]:
    """Calculate optimal send time for customer."""
    
    try:
        from uuid import UUID
        
        async with await get_session() as session:
            # Get customer profile
            result = await session.execute(
                select(CustomerProfile).where(CustomerProfile.customer_id == UUID(customer_id))
            )
            profile = result.scalar_one_or_none()
            
            if not profile or not profile.preferred_day or not profile.preferred_time:
                # Default: next Saturday 11 AM
                now = datetime.utcnow()
                days_until_saturday = (5 - now.weekday()) % 7
                if days_until_saturday == 0:
                    days_until_saturday = 7
                send_datetime = (now + timedelta(days=days_until_saturday)).replace(hour=11, minute=0, second=0, microsecond=0)
                return {
                    "send_datetime": send_datetime,
                    "confidence": "low",
                }
            
            # Map preferred_time to hour
            time_mapping = {
                "morning": 8,
                "lunch": 11,
                "snacks": 16,
                "dinner": 17,
                "late": 19,
            }
            
            send_hour = time_mapping.get(profile.preferred_time, 11)
            
            # Map preferred_day to next occurrence
            day_mapping = {
                "monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
                "friday": 4, "saturday": 5, "sunday": 6,
            }
            
            target_weekday = day_mapping.get(profile.preferred_day, 5)  # Default Saturday
            
            now = datetime.utcnow()
            days_ahead = (target_weekday - now.weekday()) % 7
            if days_ahead == 0:
                days_ahead = 7
            
            send_datetime = (now + timedelta(days=days_ahead)).replace(
                hour=send_hour, minute=0, second=0, microsecond=0
            )
            
            confidence = "high" if profile.visit_count >= 3 else "low"
            
            return {
                "send_datetime": send_datetime,
                "confidence": confidence,
            }
    
    except Exception as e:
        logger.error(f"Error calculating optimal send time: {e}")
        # Fallback
        send_datetime = datetime.utcnow() + timedelta(days=1)
        return {
            "send_datetime": send_datetime,
            "confidence": "low",
        }


# PART D: Bulk Campaign Dispatcher
async def dispatch_campaign(
    restaurant_id: str,
    campaign_name: str,
    base_message: str,
    campaign_type: str,
    segment_filter: List[str] | None = None,
) -> Dict[str, Any]:
    """Dispatch campaign to eligible customers."""
    
    try:
        from uuid import UUID
        import asyncio
        
        # Define segment mappings
        segment_mappings = {
            "win_back": ["at_risk", "lost"],
            "loyalty": ["champion", "loyal"],
            "new_item": ["champion", "loyal", "promising", "at_risk", "lost", "new_customer"],
            "festival_special": ["champion", "loyal", "promising", "at_risk", "lost", "new_customer"],
            "weekend_offer": ["promising", "at_risk"],
            "vip_invite": ["champion"],
            "all": ["champion", "loyal", "promising", "at_risk", "lost", "new_customer"],
        }
        
        target_segments = segment_filter or segment_mappings.get(campaign_type, ["all"])
        if "all" in target_segments:
            target_segments = ["champion", "loyal", "promising", "at_risk", "lost", "new_customer"]
        
        async with await get_session() as session:
            # Create campaign record
            campaign = Campaign(
                restaurant_id=UUID(restaurant_id),
                name=campaign_name,
                message_template=base_message,
                campaign_type=campaign_type,
                segment_target=",".join(target_segments),
            )
            session.add(campaign)
            await session.commit()
            await session.refresh(campaign)
            
            # Get eligible customers
            result = await session.execute(
                select(Customer, CustomerProfile)
                .outerjoin(CustomerProfile, 
                          and_(
                              CustomerProfile.customer_id == Customer.id,
                              CustomerProfile.restaurant_id == Customer.restaurant_id,
                          ))
                .where(
                    and_(
                        Customer.restaurant_id == UUID(restaurant_id),
                        Customer.opted_in_marketing == True,
                        or_(
                            CustomerProfile.rfm_segment.in_(target_segments),
                            CustomerProfile.rfm_segment.is_(None),  # New customers
                        ),
                    )
                )
            )
            
            eligible_customers = result.all()
            total_queued = 0
            by_segment = {}
            
            for customer, profile in eligible_customers:
                # Check if sent campaign in last 7 days
                seven_days_ago = datetime.utcnow() - timedelta(days=7)
                result = await session.execute(
                    select(CampaignEvent).where(
                        and_(
                            CampaignEvent.customer_id == customer.id,
                            CampaignEvent.sent_at >= seven_days_ago,
                        )
                    ).limit(1)
                )
                recent_campaign = result.scalar_one_or_none()
                
                if recent_campaign:
                    continue  # Skip, sent recently
                
                # Get optimal send time
                optimal_time = await get_optimal_send_time(str(customer.id))
                
                # Generate personalised message
                personalised_message = await generate_campaign_message(
                    str(customer.id), restaurant_id, campaign_type, base_message
                )
                
                # Create campaign event
                segment = profile.rfm_segment if profile else "new_customer"
                event = CampaignEvent(
                    campaign_id=campaign.id,
                    customer_id=customer.id,
                    restaurant_id=UUID(restaurant_id),
                    sent_at=optimal_time["send_datetime"],
                )
                session.add(event)
                
                # Update counts
                total_queued += 1
                by_segment[segment] = by_segment.get(segment, 0) + 1
            
            await session.commit()
            
            logger.info(f"Campaign {campaign_name} queued for {total_queued} customers")
            return {
                "total_queued": total_queued,
                "by_segment": by_segment,
            }
    
    except Exception as e:
        logger.error(f"Error dispatching campaign: {e}")
        return {"total_queued": 0, "by_segment": {}}


# PART E: Response Handler
async def handle_campaign_response(
    customer_id: str,
    campaign_id: str,
    response_text: str,
    restaurant_id: str,
) -> None:
    """Handle customer response to campaign message."""
    
    try:
        from uuid import UUID
        from agents.customer.conversation_intelligence import classify_intent
        
        async with await get_session() as session:
            # Classify response intent
            intent_result = await classify_intent(response_text, "campaign_response", {})
            intent = intent_result.get("intent", "unknown")
            
            # Update campaign event
            await session.execute(
                update(CampaignEvent)
                .where(
                    and_(
                        CampaignEvent.customer_id == UUID(customer_id),
                        CampaignEvent.campaign_id == UUID(campaign_id),
                    )
                )
                .values(
                    response_text=response_text,
                    response_intent=intent,
                )
            )
            
            # Route by intent
            if intent in ["affirmative", "on_track"]:
                # Mark as potential conversion
                await session.execute(
                    update(CampaignEvent)
                    .where(
                        and_(
                            CampaignEvent.customer_id == UUID(customer_id),
                            CampaignEvent.campaign_id == UUID(campaign_id),
                        )
                    )
                    .values(converted=True)
                )
                # TODO: Route to booking agent
            
            elif intent == "negative":
                # Don't message for 14 days
                pass
            
            elif intent in ["stop", "unsubscribe"]:
                # Update customer opt-out
                await session.execute(
                    update(Customer)
                    .where(Customer.id == UUID(customer_id))
                    .values(opted_in_marketing=False)
                )
                await send_whatsapp_message(
                    "",  # Need to get phone from customer
                    "Unsubscribed. Reply START to resubscribe.",
                    restaurant_id
                )
            
            elif intent == "enquiry":
                # Route to booking agent
                pass
            
            await session.commit()
            
            # Log conversation event
            from agents.customer.conversation_intelligence import log_conversation_event
            await log_conversation_event(
                restaurant_id, customer_id, f"campaign_{campaign_id}",
                "campaign_response", intent, response_text
            )
    
    except Exception as e:
        logger.error(f"Error handling campaign response: {e}")


# PART F: Campaign Analytics
async def get_campaign_analytics(restaurant_id: str, campaign_id: str) -> Dict[str, Any]:
    """Get comprehensive campaign analytics."""
    
    try:
        from uuid import UUID
        
        async with await get_session() as session:
            # Get campaign
            result = await session.execute(
                select(Campaign).where(
                    and_(
                        Campaign.id == UUID(campaign_id),
                        Campaign.restaurant_id == UUID(restaurant_id),
                    )
                )
            )
            campaign = result.scalar_one_or_none()
            
            if not campaign:
                return {}
            
            # Get all events
            result = await session.execute(
                select(CampaignEvent).where(CampaignEvent.campaign_id == UUID(campaign_id))
            )
            events = result.scalars().all()
            
            # Calculate metrics
            total_sent = len([e for e in events if e.sent_at])
            delivered = len([e for e in events if e.delivered])
            responded = len([e for e in events if e.response_text])
            converted = len([e for e in events if e.converted])
            
            response_rate = (responded / delivered * 100) if delivered > 0 else 0
            conversion_rate = (converted / delivered * 100) if delivered > 0 else 0
            
            # Revenue attributed
            revenue_attributed = sum(
                float(e.revenue_attributed) for e in events 
                if e.revenue_attributed
            )
            
            # By segment
            by_segment = {}
            for event in events:
                if event.customer and event.customer.profile:
                    segment = event.customer.profile.rfm_segment
                else:
                    segment = "new_customer"
                
                if segment not in by_segment:
                    by_segment[segment] = {
                        "sent": 0, "responded": 0, "converted": 0
                    }
                
                if event.sent_at:
                    by_segment[segment]["sent"] += 1
                if event.response_text:
                    by_segment[segment]["responded"] += 1
                if event.converted:
                    by_segment[segment]["converted"] += 1
            
            return {
                "campaign_name": campaign.name,
                "campaign_type": campaign.campaign_type,
                "total_sent": total_sent,
                "delivered": delivered,
                "responded": responded,
                "response_rate": round(response_rate, 1),
                "converted": converted,
                "conversion_rate": round(conversion_rate, 1),
                "revenue_attributed": revenue_attributed,
                "by_segment": by_segment,
            }
    
    except Exception as e:
        logger.error(f"Error getting campaign analytics: {e}")
        return {}
