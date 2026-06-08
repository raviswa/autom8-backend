"""Scheduler tools - APScheduler background jobs."""

from datetime import datetime, timedelta
import logging
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from tools.whatsapp_tools import send_whatsapp_message
from tools.db_tools import (
    get_todays_bookings,
    get_unpaid_bookings,
    get_table_statuses,
    release_table,
    get_bookings_needing_menu_prompt,
    mark_menu_prompt_sent,
)
from tools.personalisation_tools import update_customer_profile
from tools.campaign_tools import (
    calculate_all_segments,
    dispatch_campaign,
    get_campaign_analytics,
)

logger = logging.getLogger(__name__)

scheduler = AsyncIOScheduler()


async def start_scheduler():
    """Start background job scheduler."""
    logger.info("Starting APScheduler...")
    
    # Schedule all jobs
    scheduler.add_job(
        send_reservation_reminders,
        trigger=CronTrigger(hour="*"),  # Every hour
        id="send_reservation_reminders",
        name="Send 24h and 1h reminders",
    )
    
    scheduler.add_job(
        send_delayed_menu_prompts,
        trigger=CronTrigger(minute="*"),  # Every minute
        id="send_delayed_menu_prompts",
        name="Send delayed menu prompts for Dine-in",
    )
    
    scheduler.add_job(
        detect_no_shows,
        trigger=CronTrigger(minute="*/15"),  # Every 15 minutes
        id="detect_no_shows",
        name="Detect no-shows",
    )
    
    scheduler.add_job(
        manage_table_auto_release,
        trigger=CronTrigger(minute="*/5"),  # Every 5 minutes
        id="manage_table_auto_release",
        name="Manage table auto-release",
    )
    
    scheduler.add_job(
        send_daily_summary,
        trigger=CronTrigger(hour=22),  # 10 PM daily
        id="send_daily_summary",
        name="Send daily summary to managers",
    )
    
    scheduler.add_job(
        send_feedback_requests,
        trigger=CronTrigger(minute="*/30"),  # Every 30 minutes
        id="send_feedback_requests",
        name="Send feedback requests",
    )
    
    scheduler.add_job(
        send_missed_you_messages,
        trigger=CronTrigger(hour=11),  # 11 AM daily
        id="send_missed_you_messages",
        name="Send missed-you messages",
    )
    
    # New personalisation and campaign jobs
    scheduler.add_job(
        update_customer_profiles,
        trigger=CronTrigger(hour=2),  # 2 AM daily
        id="update_customer_profiles",
        name="Update customer profiles",
    )
    
    scheduler.add_job(
        calculate_customer_segments,
        trigger=CronTrigger(hour=3),  # 3 AM daily
        id="calculate_customer_segments",
        name="Calculate RFM segments",
    )
    
    scheduler.add_job(
        dispatch_scheduled_campaigns,
        trigger=CronTrigger(hour="*/2"),  # Every 2 hours
        id="dispatch_scheduled_campaigns",
        name="Dispatch scheduled campaigns",
    )

    scheduler.add_job(
    lambda: asyncio.create_task(cleanup_expired_receipts()),
    'cron', hour=3, minute=0, id='cleanup_receipts',
    replace_existing=True,
    )    
    
    scheduler.add_job(
        track_campaign_conversions,
        trigger=CronTrigger(hour="*/4"),  # Every 4 hours
        id="track_campaign_conversions",
        name="Track campaign conversions",
    )
    
    scheduler.start()
    logger.info("APScheduler started with jobs")


async def send_reservation_reminders():
    """Send 24h and 1h reminders for reservations."""
    logger.info("Running send_reservation_reminders job")
    
    try:
        # TODO: Query bookings where:
        # - booking_datetime is 24 hours away and reminder_24h_sent = false
        # - Send: "Hi [name]! Reminder: your table for [pax] is confirmed at [restaurant] at [time]."
        # - Set reminder_24h_sent = true
        # - Repeat for 1h with reminder_1h_sent
        
        logger.info("Reservation reminders sent")
    
    except Exception as e:
        logger.error(f"Error in send_reservation_reminders: {e}")


async def detect_no_shows():
    """Detect customers 15min past booking time."""
    logger.info("Running detect_no_shows job")
    
    try:
        # TODO: Query confirmed reservations 15 min past booking time
        # Send manager WhatsApp:
        # "[name] (Booking #[id], [time]) has not arrived. 
        #  Reply NOSHOW [id] to free table or EXTEND [table] to wait."
        
        logger.info("No-show detection complete")
    
    except Exception as e:
        logger.error(f"Error in detect_no_shows: {e}")


async def manage_table_auto_release():
    """Manage table auto-release warnings and actual release."""
    logger.info("Running manage_table_auto_release job")
    
    try:
        # Part A - Warning (15 min before release)
        # Find occupied tables where auto_release_at <= now + 15 minutes AND warning_sent = false
        # Send manager: "Table [n] | [name] | [mins] mins elapsed. Auto-releases at [time].
        #               Reply EXTEND [n] to keep occupied."
        # Set warning_sent = true
        
        # Part B - Release
        # Find occupied tables where auto_release_at <= now
        # Call release_table(restaurant_id, table_n, 'auto')
        # Send manager: "Table [n] auto-released. [name] session closed."
        
        logger.info("Table auto-release management complete")
    
    except Exception as e:
        logger.error(f"Error in manage_table_auto_release: {e}")


async def send_daily_summary():
    """Send daily booking summary to manager."""
    logger.info("Running send_daily_summary job")
    
    try:
        # TODO: Get all restaurants
        # For each restaurant:
        # - Aggregate: bookings count by type, total covers, revenue, no-shows, cancellations
        # - Calculate for today
        # - Send to manager_phone:
        # "Daily Summary — [date]
        #  Dine-in: [n] | Takeaway: [n] | Reserve: [n]
        #  Covers: [n] | Revenue: Rs [n]
        #  No-shows: [n] | Cancellations: [n]
        #  Tomorrow bookings: [n]"
        
        logger.info("Daily summaries sent")
    
    except Exception as e:
        logger.error(f"Error in send_daily_summary: {e}")


async def send_feedback_requests():
    """Request feedback 2 hours after completed visit."""
    logger.info("Running send_feedback_requests job")
    
    try:
        # TODO: Query completed bookings where 2h have passed
        # and feedback_requested = false
        # Send: "Hi [name]! Hope you enjoyed your visit.
        #        Rate us: 1 Poor to 5 Excellent"
        # If rating <= 2: immediately WhatsApp manager with complaint
        # Set feedback_requested = true
        
        logger.info("Feedback requests sent")
    
    except Exception as e:
        logger.error(f"Error in send_feedback_requests: {e}")


async def send_missed_you_messages():
    """Send missed-you messages to inactive customers."""
    logger.info("Running send_missed_you_messages job")
    
    try:
        # TODO: Query customers where last_visit > MISSED_YOU_DAYS
        # and opted_in_marketing = true
        # Send: "Hi [name]! We have missed you at [restaurant].
        #        Come visit us soon! Reply STOP to unsubscribe."
        
        logger.info("Missed-you messages sent")
    
    except Exception as e:
        logger.error(f"Error in send_missed_you_messages: {e}")


# NEW JOBS FOR PERSONALISATION AND CAMPAIGNS
async def update_customer_profiles():
    """Update customer profiles with latest booking data."""
    logger.info("Running update_customer_profiles job")
    
    try:
        # This job runs daily to ensure profiles are up to date
        # The actual profile updates happen in real-time via booking_agent
        # This is a safety net for any missed updates
        
        # TODO: Query recent bookings (last 24h) and ensure profiles updated
        # Call update_customer_profile for any missed bookings
        
        logger.info("Customer profiles updated")
    
    except Exception as e:
        logger.error(f"Error in update_customer_profiles: {e}")


async def calculate_customer_segments():
    """Calculate RFM segments for all restaurants."""
    logger.info("Running calculate_customer_segments job")
    
    try:
        # TODO: Get all restaurant IDs
        # For each restaurant:
        # await calculate_all_segments(restaurant_id)
        
        logger.info("Customer segments calculated")
    
    except Exception as e:
        logger.error(f"Error in calculate_customer_segments: {e}")


async def dispatch_scheduled_campaigns():
    """Dispatch campaigns based on schedule."""
    logger.info("Running dispatch_scheduled_campaigns job")
    
    try:
        # TODO: Query campaigns where scheduled_time <= now and status = 'scheduled'
        # For each campaign:
        # await dispatch_campaign(restaurant_id, campaign_name, base_message, campaign_type, segment_filter)
        # Update campaign status to 'dispatched'
        
        logger.info("Scheduled campaigns dispatched")
    
    except Exception as e:
        logger.error(f"Error in dispatch_scheduled_campaigns: {e}")


async def track_campaign_conversions():
    """Track campaign conversions and update analytics."""
    logger.info("Running track_campaign_conversions job")
    
    try:
        # TODO: Query campaigns dispatched in last 7 days
        # For each campaign:
        # - Check for new bookings from campaign recipients in attribution window (24-48h)
        # - Update campaign_events with revenue_attributed
        # - Update campaign analytics
        
        logger.info("Campaign conversions tracked")
    
    except Exception as e:
        logger.error(f"Error in track_campaign_conversions: {e}")

async def send_delayed_menu_prompts():
    """Send WhatsApp menu prompts 3 minutes after table confirmation."""
    logger.info("Running send_delayed_menu_prompts job")
    
    try:
        bookings = await get_bookings_needing_menu_prompt()
        for b in bookings:
            if b.get("phone") and b.get("restaurant_id"):
                message = (
                    f"Hi {b.get('customer_name', '')}! "
                    f"Your table {b.get('table_number')} is ready. "
                    "Here is our menu — tap to browse and pre-order your starters! 🍽️"
                )
                await send_whatsapp_message(b["phone"], message, b["restaurant_id"])
                await mark_menu_prompt_sent(b["id"])
                logger.info(f"Sent delayed menu prompt to {b['phone']} for booking {b['id']}")
        
        logger.info("Delayed menu prompts processing complete")
    
    except Exception as e:
        logger.error(f"Error in send_delayed_menu_prompts: {e}")
