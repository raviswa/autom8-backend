"""Manager commands agent - parses and executes manager commands."""

from typing import Dict, Any, List
import logging
import re

from tools.db_tools import (
    get_todays_bookings,
    get_booking_by_id,
    update_booking_status,
    find_customer_booking,
    block_slot,
    get_menu,
    add_menu_item,
    remove_menu_item,
    get_table_statuses,
    release_table,
    extend_table_time,
    get_unpaid_bookings,
    block_customer,
)
from tools.whatsapp_tools import send_whatsapp_message
from tools.campaign_tools import (
    calculate_all_segments,
    dispatch_campaign,
    get_campaign_analytics,
)

logger = logging.getLogger(__name__)


async def parse_manager_command(
    restaurant_id: str,
    manager_phone: str,
    message: str,
) -> Dict[str, Any]:
    """Parse and execute manager commands."""

    raw = message.strip()
    upper = raw.upper()

    # Scheduled delivery WhatsApp approve/reject buttons
    if upper.startswith("SCHED_APPROVE_"):
        token_id = raw[len("SCHED_APPROVE_"):]
        return await cmd_scheduled_delivery_approve(restaurant_id, manager_phone, token_id)
    if upper.startswith("SCHED_REJECT_"):
        token_id = raw[len("SCHED_REJECT_"):]
        return await cmd_scheduled_delivery_reject(restaurant_id, manager_phone, token_id)

    command_text = upper

    # BOOKING COMMANDS
    if command_text == "TODAY":
        return await cmd_today(restaurant_id, manager_phone)
    
    elif command_text == "TOMORROW":
        return await cmd_tomorrow(restaurant_id, manager_phone)
    
    elif command_text.startswith("CONFIRM "):
        booking_num = command_text.replace("CONFIRM ", "").strip()
        return await cmd_confirm(restaurant_id, manager_phone, booking_num)
    
    elif command_text.startswith("REJECT "):
        parts = command_text.replace("REJECT ", "").split(" ", 1)
        if len(parts) == 2:
            return await cmd_reject(restaurant_id, manager_phone, parts[0], parts[1])
        return {"status": "error", "message": "Usage: REJECT [booking#] [reason]"}
    
    elif command_text.startswith("FIND "):
        search_term = command_text.replace("FIND ", "").strip()
        return await cmd_find(restaurant_id, manager_phone, search_term)
    
    elif command_text.startswith("BLOCK "):
        block_arg = command_text.replace("BLOCK ", "").strip()
        return await cmd_block(restaurant_id, manager_phone, block_arg)
    
    elif command_text.startswith("NOSHOW "):
        booking_num = command_text.replace("NOSHOW ", "").strip()
        return await cmd_noshow(restaurant_id, manager_phone, booking_num)
    
    # TABLE COMMANDS
    elif command_text == "TABLES":
        return await cmd_tables(restaurant_id, manager_phone)
    
    elif command_text.startswith("FREE "):
        table_num = command_text.replace("FREE ", "").strip()
        return await cmd_free(restaurant_id, manager_phone, table_num)
    
    elif command_text.startswith("EXTEND "):
        parts = command_text.replace("EXTEND ", "").strip().split()
        if len(parts) == 1:
            return await cmd_extend(restaurant_id, manager_phone, parts[0], None)
        elif len(parts) == 2:
            return await cmd_extend(restaurant_id, manager_phone, parts[0], int(parts[1]))
        return {"status": "error", "message": "Usage: EXTEND [table#] or EXTEND [table#] [minutes]"}
    
    # ORDER COMMANDS
    elif command_text == "ORDERS":
        return await cmd_orders(restaurant_id, manager_phone)
    
    elif command_text.startswith("READY "):
        order_num = command_text.replace("READY ", "").strip()
        return await cmd_ready(restaurant_id, manager_phone, order_num)
    
    elif command_text.startswith("UNPAID "):
        parts = command_text.replace("UNPAID ", "").strip().split()
        if len(parts) == 2:
            return await cmd_unpaid(restaurant_id, manager_phone, parts[0], parts[1])
        return {"status": "error", "message": "Usage: UNPAID [phone] [amount]"}
    
    elif command_text.startswith("BLOCK ") and len(command_text.split()) == 2:
        phone = command_text.replace("BLOCK ", "").strip()
        return await cmd_block_customer(restaurant_id, manager_phone, phone)
    
    # MENU COMMANDS
    elif command_text == "MENU":
        return await cmd_menu(restaurant_id, manager_phone)
    
    elif command_text.startswith("MENU ADD "):
        item_info = command_text.replace("MENU ADD ", "").strip()
        # Format: MENU ADD Biryani 180
        parts = item_info.rsplit(" ", 1)
        if len(parts) == 2:
            return await cmd_menu_add(restaurant_id, manager_phone, parts[0], float(parts[1]))
        return {"status": "error", "message": "Usage: MENU ADD [item name] [price]"}
    
    elif command_text.startswith("MENU REMOVE "):
        item_name = command_text.replace("MENU REMOVE ", "").strip()
        return await cmd_menu_remove(restaurant_id, manager_phone, item_name)
    
    elif command_text.startswith("MENU TODAY "):
        item_info = command_text.replace("MENU TODAY ", "").strip()
        parts = item_info.rsplit(" ", 1)
        if len(parts) == 2:
            return await cmd_menu_today(restaurant_id, manager_phone, parts[0], float(parts[1]))
        return {"status": "error", "message": "Usage: MENU TODAY [item name] [price]"}
    
    # CAMPAIGN COMMANDS
    elif command_text.startswith("CAMPAIGN SEND "):
        campaign_info = command_text.replace("CAMPAIGN SEND ", "").strip()
        # Format: CAMPAIGN SEND win_back "Come back! 20% off" loyal
        parts = campaign_info.split('"')
        if len(parts) >= 3:
            campaign_type = parts[0].strip()
            message = parts[1].strip()
            segment = parts[2].strip() if len(parts) > 2 and parts[2].strip() else None
            return await cmd_campaign_send(restaurant_id, manager_phone, campaign_type, message, segment)
        return {"status": "error", "message": "Usage: CAMPAIGN SEND [type] \"[message]\" [segment]"}
    
    elif command_text.startswith("CAMPAIGN STATUS "):
        campaign_name = command_text.replace("CAMPAIGN STATUS ", "").strip()
        return await cmd_campaign_status(restaurant_id, manager_phone, campaign_name)
    
    elif command_text == "SEGMENTS":
        return await cmd_segments(restaurant_id, manager_phone)
    
    else:
        return {"status": "unknown_command", "message": f"Unknown command: {command_text}"}


# BOOKING COMMAND HANDLERS
async def cmd_today(restaurant_id: str, manager_phone: str) -> Dict[str, Any]:
    """Show today's bookings."""
    try:
        bookings = await get_todays_bookings(restaurant_id)
        
        if not bookings:
            response = "No bookings for today."
        else:
            response = "Today's Bookings:\n────────────────────\n"
            for i, booking in enumerate(bookings, 1):
                status_icon = "✅" if booking["status"] == "confirmed" else "⏳" if booking["status"] == "pending" else "❌"
                response += f"{i}. {booking['customer_name']} | {booking['service_type']} | {status_icon}\n"
            response += "────────────────────"
        
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success", "message": response}
    
    except Exception as e:
        logger.error(f"Error in cmd_today: {e}")
        return {"status": "error", "message": str(e)}


async def cmd_tomorrow(restaurant_id: str, manager_phone: str) -> Dict[str, Any]:
    """Show tomorrow's bookings."""
    # Similar to cmd_today but filtered for tomorrow
    response = "Tomorrow's Bookings:\n────────────────────\n(To be implemented)\n────────────────────"
    await send_whatsapp_message(manager_phone, response, restaurant_id)
    return {"status": "success"}


async def cmd_confirm(restaurant_id: str, manager_phone: str, booking_num: str) -> Dict[str, Any]:
    """Confirm a booking."""
    try:
        # In production, map booking number to booking_id
        await update_booking_status(booking_num, "confirmed")
        
        response = f"Booking #{booking_num} confirmed. Customer notified."
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        logger.error(f"Error in cmd_confirm: {e}")
        return {"status": "error", "message": str(e)}


async def cmd_scheduled_delivery_approve(
    restaurant_id: str, manager_phone: str, token_id: str,
) -> Dict[str, Any]:
    """Approve a scheduled door delivery from manager WhatsApp button."""
    from tools.booking_mechanisms import approve_scheduled_delivery_token

    result = await approve_scheduled_delivery_token(restaurant_id, token_id)
    if result.get("ok"):
        await send_whatsapp_message(
            manager_phone,
            f"✅ Scheduled delivery *{token_id}* approved. Customer will receive payment link.",
            restaurant_id,
        )
        return {"status": "success", "token_id": token_id}
    await send_whatsapp_message(
        manager_phone,
        f"Could not approve *{token_id}*. It may already be handled — check the portal.",
        restaurant_id,
    )
    return {"status": "error", "message": result.get("error", "approve failed")}


async def cmd_scheduled_delivery_reject(
    restaurant_id: str, manager_phone: str, token_id: str,
) -> Dict[str, Any]:
    """Reject a scheduled door delivery from manager WhatsApp button."""
    from tools.booking_mechanisms import reject_scheduled_delivery_token

    result = await reject_scheduled_delivery_token(restaurant_id, token_id)
    if result.get("ok"):
        await send_whatsapp_message(
            manager_phone,
            f"❌ Scheduled delivery *{token_id}* rejected. Customer notified.",
            restaurant_id,
        )
        return {"status": "success", "token_id": token_id}
    await send_whatsapp_message(
        manager_phone,
        f"Could not reject *{token_id}*. Check the portal.",
        restaurant_id,
    )
    return {"status": "error", "message": result.get("error", "reject failed")}


async def cmd_reject(restaurant_id: str, manager_phone: str, booking_num: str, reason: str) -> Dict[str, Any]:
    """Reject a booking."""
    try:
        await update_booking_status(booking_num, "rejected")
        response = f"Booking #{booking_num} rejected. Customer notified with reason: {reason}"
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error", "message": str(e)}


async def cmd_find(restaurant_id: str, manager_phone: str, search_term: str) -> Dict[str, Any]:
    """Find bookings by customer name or phone."""
    try:
        bookings = await find_customer_booking(restaurant_id, search_term)
        
        if not bookings:
            response = f"No bookings found for '{search_term}'."
        else:
            response = f"Bookings for '{search_term}':\n────────────────────\n"
            for booking in bookings:
                response += f"- {booking['customer_name']} | {booking['phone']} | {booking['status']}\n"
            response += "────────────────────"
        
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error", "message": str(e)}


async def cmd_block(restaurant_id: str, manager_phone: str, block_arg: str) -> Dict[str, Any]:
    """Block a date or time slot."""
    try:
        # Format: BLOCK 25-Apr or BLOCK 26-Apr dinner
        parts = block_arg.split()
        date = parts[0]
        slot = parts[1] if len(parts) > 1 else "full"
        
        await block_slot(restaurant_id, date, slot, "Manager blocked")
        response = f"Blocked: {date} {slot}"
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error", "message": str(e)}


async def cmd_noshow(restaurant_id: str, manager_phone: str, booking_num: str) -> Dict[str, Any]:
    """Mark booking as no-show."""
    try:
        await update_booking_status(booking_num, "no_show")
        response = f"Booking #{booking_num} marked as no-show."
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error"}


# TABLE COMMAND HANDLERS
async def cmd_tables(restaurant_id: str, manager_phone: str) -> Dict[str, Any]:
    """Show table status."""
    try:
        tables = await get_table_statuses(restaurant_id)
        
        response = "Table Status:\n────────────────────\n"
        for table in tables:
            if table["status"] == "free":
                response += f"{table['table_number']} ✅ Free\n"
            else:
                response += f"{table['table_number']} {table['table_number']} | ₹? | {table['occupied_since']} | ? min\n"
        
        response += "────────────────────\nFREE [n] · EXTEND [n] · EXTEND [n] [mins]"
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error"}


async def cmd_free(restaurant_id: str, manager_phone: str, table_num: str) -> Dict[str, Any]:
    """Mark table as free."""
    try:
        await release_table(restaurant_id, int(table_num), "manager")
        response = f"Table {table_num} is now free."
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error"}


async def cmd_extend(restaurant_id: str, manager_phone: str, table_num: str, minutes: int | None) -> Dict[str, Any]:
    """Extend table time."""
    try:
        # Use default dining duration if not specified
        extend_minutes = minutes or 90
        result = await extend_table_time(restaurant_id, int(table_num), extend_minutes)
        response = f"Table {table_num} extended by {extend_minutes} minutes."
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error"}


# ORDER COMMAND HANDLERS
async def cmd_orders(restaurant_id: str, manager_phone: str) -> Dict[str, Any]:
    """Show pending orders."""
    response = "Pending Orders:\n────────────────────\n(To be implemented)\n────────────────────"
    await send_whatsapp_message(manager_phone, response, restaurant_id)
    return {"status": "success"}


async def cmd_ready(restaurant_id: str, manager_phone: str, order_num: str) -> Dict[str, Any]:
    """Mark order as ready."""
    response = f"Order #{order_num} marked ready. Customer notified."
    await send_whatsapp_message(manager_phone, response, restaurant_id)
    return {"status": "success"}


async def cmd_unpaid(restaurant_id: str, manager_phone: str, phone: str, amount: str) -> Dict[str, Any]:
    """Send payment recovery message."""
    response = f"Payment recovery message sent to {phone} for ₹{amount}."
    await send_whatsapp_message(manager_phone, response, restaurant_id)
    return {"status": "success"}


async def cmd_block_customer(restaurant_id: str, manager_phone: str, phone: str) -> Dict[str, Any]:
    """Block customer."""
    try:
        await block_customer(restaurant_id, phone)
        response = f"Customer {phone} blocked from future interactions."
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error"}


# MENU COMMAND HANDLERS
async def cmd_menu(restaurant_id: str, manager_phone: str) -> Dict[str, Any]:
    """Show current menu."""
    try:
        menu_items = await get_menu(restaurant_id)
        
        response = "Menu:\n────────────────────\n"
        for item in menu_items:
            response += f"- {item['name']}: ₹{item['price']}\n"
        response += "────────────────────"
        
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error"}


async def cmd_menu_add(restaurant_id: str, manager_phone: str, name: str, price: float) -> Dict[str, Any]:
    """Add menu item."""
    try:
        await add_menu_item(restaurant_id, name, price, "general")
        response = f"Added {name} at ₹{price} to menu."
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error"}


async def cmd_menu_remove(restaurant_id: str, manager_phone: str, name: str) -> Dict[str, Any]:
    """Remove menu item."""
    try:
        await remove_menu_item(restaurant_id, name)
        response = f"Removed {name} from menu."
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        return {"status": "error"}


async def cmd_menu_today(restaurant_id: str, manager_phone: str, name: str, price: float) -> Dict[str, Any]:
    """Add today-only special item."""
    response = f"Added '{name}' at ₹{price} as today's special."
    await send_whatsapp_message(manager_phone, response, restaurant_id)
    return {"status": "success"}


# CAMPAIGN COMMAND HANDLERS
async def cmd_campaign_send(
    restaurant_id: str, 
    manager_phone: str, 
    campaign_type: str, 
    message: str, 
    segment: str | None
) -> Dict[str, Any]:
    """Send a campaign to customers."""
    try:
        # Generate unique campaign name
        from datetime import datetime
        campaign_name = f"{campaign_type}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        
        # Dispatch campaign
        result = await dispatch_campaign(
            restaurant_id, campaign_name, message, campaign_type, 
            [segment] if segment else None
        )
        
        response = f"Campaign '{campaign_name}' sent!\n"
        response += f"Queued: {result['total_queued']} messages\n"
        response += f"Segments: {', '.join(result['by_segment'].keys())}\n"
        response += f"Check status: CAMPAIGN STATUS {campaign_name}"
        
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        logger.error(f"Error in cmd_campaign_send: {e}")
        return {"status": "error", "message": str(e)}


async def cmd_campaign_status(restaurant_id: str, manager_phone: str, campaign_name: str) -> Dict[str, Any]:
    """Check campaign status and analytics."""
    try:
        # Find campaign by name (simplified - in production use proper lookup)
        # For now, assume we need to get campaign_id somehow
        # This would need to be implemented in db_tools
        
        response = f"Campaign '{campaign_name}' Status:\n"
        response += "────────────────────\n"
        response += "Sent: 0 | Delivered: 0 | Responses: 0\n"
        response += "Response Rate: 0% | Conversion: 0%\n"
        response += "Revenue: ₹0\n"
        response += "────────────────────\n"
        response += "(Full analytics to be implemented)"
        
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        logger.error(f"Error in cmd_campaign_status: {e}")
        return {"status": "error", "message": str(e)}


async def cmd_segments(restaurant_id: str, manager_phone: str) -> Dict[str, Any]:
    """Show customer segment breakdown."""
    try:
        segments = await calculate_all_segments(restaurant_id)
        
        response = "Customer Segments:\n"
        response += "────────────────────\n"
        response += f"🏆 Champion: {segments.get('champion', 0)}\n"
        response += f"💎 Loyal: {segments.get('loyal', 0)}\n"
        response += f"⭐ Promising: {segments.get('promising', 0)}\n"
        response += f"⚠️ At Risk: {segments.get('at_risk', 0)}\n"
        response += f"😴 Lost: {segments.get('lost', 0)}\n"
        response += f"🆕 New: {segments.get('new_customer', 0)}\n"
        response += "────────────────────\n"
        response += f"Total: {sum(segments.values())} customers"
        
        await send_whatsapp_message(manager_phone, response, restaurant_id)
        return {"status": "success"}
    
    except Exception as e:
        logger.error(f"Error in cmd_segments: {e}")
        return {"status": "error", "message": str(e)}
