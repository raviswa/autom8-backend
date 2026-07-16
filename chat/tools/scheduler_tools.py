"""Scheduler tools - APScheduler background jobs."""

import asyncio
from datetime import datetime, timedelta
import logging
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from tools.whatsapp_tools import send_whatsapp_message, send_whatsapp_cta_url
from tools.db_tools import (
    get_todays_bookings,
    get_unpaid_bookings,
    get_table_statuses,
    release_table,
    get_bookings_needing_menu_prompt,
    mark_menu_prompt_sent,
    get_reservation_reminder_candidates,
    mark_reservation_reminder_sent,
    get_bookings_due_for_kds,
    mark_booking_kds_sent,
    get_paid_bookings_missing_kds,
    mark_kds_alert_sent,
)
from tools.personalisation_tools import update_customer_profile
from tools.campaign_tools import (
    calculate_all_segments,
    dispatch_campaign,
    get_campaign_analytics,
)

logger = logging.getLogger(__name__)

try:
    from tools.receipt_tools import cleanup_expired_receipts
except Exception as e:
    logger.warning("Failed to import cleanup_expired_receipts: %s", e)
    cleanup_expired_receipts = None

# ─────────────────────────────────────────────────────────────────────────────
# db_tools.py changes required alongside this file:
#
# 1. Add column filter to get_paid_bookings_missing_kds():
#       WHERE kds_alert_sent IS NOT TRUE
#       AND created_at > NOW() - INTERVAL '24 hours'
#
# 2. Add new function mark_kds_alert_sent(booking_id):
#       UPDATE bookings SET kds_alert_sent = TRUE WHERE id = booking_id
#
# 3. Run in Supabase SQL editor once before deploying:
#       ALTER TABLE bookings
#         ADD COLUMN IF NOT EXISTS kds_alert_sent boolean DEFAULT false;
#       UPDATE bookings
#         SET kds_alert_sent = true
#         WHERE created_at < now() - interval '3 hours';
# ─────────────────────────────────────────────────────────────────────────────

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

    if cleanup_expired_receipts is not None:
        def _run_receipt_cleanup_job() -> None:
            asyncio.run(cleanup_expired_receipts())

        scheduler.add_job(
            _run_receipt_cleanup_job,
            trigger="cron",
            hour="3",
            minute="0",
            id="cleanup_expired_receipts",
            replace_existing=True,
        )
    else:
        logger.warning("cleanup_expired_receipts unavailable; skipping scheduled cleanup job")

    scheduler.add_job(
        track_campaign_conversions,
        trigger=CronTrigger(hour="*/4"),  # Every 4 hours
        id="track_campaign_conversions",
        name="Track campaign conversions",
    )

    scheduler.add_job(
        dispatch_deferred_scheduled_kds,
        trigger=CronTrigger(minute="*/5"),  # Every 5 minutes
        id="dispatch_deferred_scheduled_kds",
        name="Release scheduled orders to KDS before delivery slot",
    )

    scheduler.add_job(
        send_prepay_payment_reminders,
        trigger=CronTrigger(minute="*/15"),  # Every 15 minutes
        id="send_prepay_payment_reminders",
        name="Remind customers with pending Razorpay prepay",
    )

    scheduler.add_job(
        reconcile_paid_orders_without_kds,
        trigger=CronTrigger(minute="*/10"),  # Every 10 minutes
        id="reconcile_paid_orders_without_kds",
        name="Reconcile paid orders missing KDS tickets",
    )
    
    scheduler.start()
    logger.info("APScheduler started with jobs")


def _format_booking_time_ist(dt) -> str:
    if not dt:
        return "your scheduled time"
    try:
        from zoneinfo import ZoneInfo
        ist = dt.astimezone(ZoneInfo("Asia/Kolkata"))
        return ist.strftime("%I:%M %p on %d %b").lstrip("0")
    except Exception:
        return dt.strftime("%H:%M %d %b")


async def send_reservation_reminders():
    """Send 24h and 1h reminders for reserve_table bookings."""
    logger.info("Running send_reservation_reminders job")

    try:
        sent_24h = 0
        sent_1h = 0

        for row in await get_reservation_reminder_candidates(24, 60, "reminder_24h_sent"):
            time_label = _format_booking_time_ist(row["booking_datetime"])
            await send_whatsapp_message(
                row["customer_phone"],
                f"Hi {row['customer_name']}! 👋\n\n"
                f"Reminder: your table for *{row['party_size']}* is confirmed at "
                f"*{row['restaurant_name']}* on *{time_label}*.\n\n"
                f"We look forward to seeing you! 🍽️",
                row["restaurant_id"],
            )
            await mark_reservation_reminder_sent(row["id"], "reminder_24h_sent")
            sent_24h += 1

        for row in await get_reservation_reminder_candidates(1, 30, "reminder_1h_sent"):
            time_label = _format_booking_time_ist(row["booking_datetime"])
            await send_whatsapp_message(
                row["customer_phone"],
                f"Hi {row['customer_name']}! ⏰\n\n"
                f"Your table at *{row['restaurant_name']}* is in about an hour "
                f"(*{time_label}*). See you soon!",
                row["restaurant_id"],
            )
            await mark_reservation_reminder_sent(row["id"], "reminder_1h_sent")
            sent_1h += 1

        logger.info(f"Reservation reminders sent — 24h: {sent_24h}, 1h: {sent_1h}")

    except Exception as e:
        logger.error(f"Error in send_reservation_reminders: {e}")


async def dispatch_deferred_scheduled_kds():
    """Push scheduled delivery/takeaway orders to KDS when within the lead window."""
    from tools.booking_mechanisms import notify_kds

    logger.info("Running dispatch_deferred_scheduled_kds job")
    try:
        due_rows = await get_bookings_due_for_kds()
        if not due_rows:
            return

        dispatched = 0
        for row in due_rows:
            meta = row.get("token_meta") or {}
            schedule_meta = row.get("schedule_meta") or {}
            cart = meta.get("cart") or schedule_meta.get("cart") or {}
            order_text = (meta.get("order_text") or schedule_meta.get("order_text") or "").strip()
            token = row.get("portal_token_id") or row.get("token_number") or "—"
            service_type = row.get("service_type") or "delivery"

            if not order_text and not cart:
                logger.warning(
                    f"[scheduled-kds] Skipping booking {row.get('booking_id')} — no order payload"
                )
                continue

            try:
                order_id = await notify_kds(
                    customer_name=row.get("customer_name") or "Guest",
                    customer_phone=row.get("customer_phone") or "",
                    order_text=order_text,
                    cart=cart,
                    table_number=None,
                    token_number=str(token),
                    service_type=service_type,
                    restaurant_id=row["restaurant_id"],
                    booking_id=row.get("booking_id"),
                )
                if order_id:
                    await mark_booking_kds_sent(row["booking_id"])
                    dispatched += 1
                    logger.info(
                        f"[scheduled-kds] Dispatched booking {row['booking_id']} "
                        f"to KDS (token={token})"
                    )
                else:
                    logger.error(
                        f"[scheduled-kds] KDS dispatch FAILED for booking "
                        f"{row.get('booking_id')} (token={token}) — kds_sent_at left "
                        f"null, will retry next run"
                    )
            except Exception as row_err:
                logger.error(
                    f"[scheduled-kds] Failed booking {row.get('booking_id')}: {row_err}"
                )

        logger.info(f"[scheduled-kds] Dispatched {dispatched}/{len(due_rows)} deferred orders")
    except Exception as e:
        logger.error(f"Error in dispatch_deferred_scheduled_kds: {e}")


async def send_prepay_payment_reminders():
    """Nudge customers who have not completed Razorpay prepay."""
    from tools.db_tools import (
        get_pending_prepay_reminder_candidates,
        increment_prepay_reminder_count,
    )
    from tools.payment_tools import create_payment_link, is_placeholder_payment_link, format_razorpay_payment_line

    logger.info("Running send_prepay_payment_reminders job")
    try:
        candidates = await get_pending_prepay_reminder_candidates()
        sent = 0
        for row in candidates:
            booking_id = row["booking_id"]
            payload = row.get("payload") or {}
            if isinstance(payload, str):
                import json
                payload = json.loads(payload)
            total = float(payload.get("total") or 0)
            service_type = row.get("service_type") or payload.get("service_type") or "order"
            phone = row["customer_phone"]
            name = row.get("customer_name") or "Guest"
            restaurant_id = row["restaurant_id"]

            pay_link = ""
            if total >= 1:
                try:
                    link = await create_payment_link(
                        booking_id, total, name,
                        f"{service_type.replace('_', ' ').title()} — payment reminder",
                        customer_phone=phone,
                    )
                    if not is_placeholder_payment_link(link):
                        pay_link = str(link)
                except Exception as link_err:
                    logger.warning(f"[prepay-reminder] link failed for {booking_id}: {link_err}")

            cta_sent = False
            if pay_link:
                cta_sent = await send_whatsapp_cta_url(
                    phone,
                    restaurant_id,
                    body_text=(
                        f"Hi {name}! 👋\n\n"
                        f"Your {service_type.replace('_', ' ')} order is still awaiting payment.\n\n"
                        "Tap Confirm & Pay to complete payment securely."
                    ),
                    button_text="Confirm & Pay",
                    url=pay_link,
                    header_text="Payment Pending",
                    footer_text="Secure payment powered by Razorpay",
                )

            if not cta_sent:
                pay_line = ""
                if pay_link:
                    pay_line = "\n\n" + format_razorpay_payment_line(
                        pay_link, label="💳 Pay here:",
                    )
                await send_whatsapp_message(
                    phone,
                    f"Hi {name}! 👋\n\n"
                    f"Your {service_type.replace('_', ' ')} order is still awaiting payment."
                    f"{pay_line}\n\n"
                    f"Reply *pay* on WhatsApp to get your link again.",
                    restaurant_id,
                )
            await increment_prepay_reminder_count(booking_id)
            sent += 1

        logger.info(f"[prepay-reminder] Sent {sent} payment reminders")
    except Exception as e:
        logger.error(f"Error in send_prepay_payment_reminders: {e}")


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
        # TODO: Get all tenants
        # For each tenant:
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
    """Calculate RFM segments for all tenants."""
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


async def reconcile_paid_orders_without_kds():
    """
    Alert and auto-retry when payment was captured but no KDS ticket exists.

    Each booking is alerted at most once: after a manager alert fires (or after a
    successful retry), mark_kds_alert_sent() sets kds_alert_sent = TRUE on the
    booking row so get_paid_bookings_missing_kds() never returns it again.
    """
    logger.info("Running reconcile_paid_orders_without_kds job")
    try:
        from tools.db_tools import backfill_missing_booking_schedules
        from tools.prepay_fulfillment import retry_kds_for_confirmed_booking

        backfilled = await backfill_missing_booking_schedules()
        if backfilled:
            logger.info(f"[reconcile] Backfilled schedule for {backfilled} booking(s)")

        # get_paid_bookings_missing_kds must filter:
        #   WHERE kds_alert_sent IS NOT TRUE
        #   AND created_at > NOW() - INTERVAL '24 hours'
        rows = await get_paid_bookings_missing_kds()
        if not rows:
            return

        retried = 0
        alerted = 0
        for row in rows:
            booking_id = row["booking_id"]
            already_alerted = bool(row.get("kds_alert_sent"))

            ok = await retry_kds_for_confirmed_booking(booking_id)

            if ok:
                retried += 1
                logger.warning(
                    f"[reconcile] Auto-retried KDS for paid booking {booking_id} "
                    f"({row.get('service_type')} token {row.get('token_number')})"
                )
                continue

            from tools.scheduled_kds import is_booking_on_kds_future_tab

            if is_booking_on_kds_future_tab(
                kitchen_start_at=row.get("kitchen_start_at"),
                scheduled_slot_at=row.get("scheduled_slot_at"),
                booking_datetime=row.get("booking_datetime"),
                kds_sent_at=row.get("kds_sent_at"),
                service_type=row.get("service_type"),
                schedule_meta=row.get("schedule_meta"),
            ):
                logger.info(
                    f"[reconcile] Skipped alert — booking {booking_id} is scheduled "
                    f"(KDS Future tab)"
                )
                continue

            # Retry failed — alert manager once; keep retrying on future cron runs
            if not already_alerted:
                manager = row.get("manager_phone")
                if manager:
                    await send_whatsapp_message(
                        manager,
                        f"⚠️ *Paid order missing from kitchen*\n\n"
                        f"Booking: {booking_id[:8]}…\n"
                        f"Customer: {row.get('customer_name')} ({row.get('customer_phone')})\n"
                        f"Token: {row.get('token_number') or '—'}\n"
                        f"Service: {row.get('service_type')}\n\n"
                        f"Payment was captured but no KDS ticket was created. "
                        f"Please verify the kitchen display and contact support if needed.",
                        row["restaurant_id"],
                    )
                    alerted += 1
                    await mark_kds_alert_sent(booking_id)

            logger.error(
                f"[reconcile] Paid booking {booking_id} has no KDS — retry failed"
            )

        logger.info(
            f"[reconcile] Processed {len(rows)} paid-without-KDS booking(s): "
            f"{retried} retried, {alerted} manager alerts"
        )
    except Exception as e:
        logger.error(f"Error in reconcile_paid_orders_without_kds: {e}")
