"""
agents/customer/conversation_helpers.py
─────────────────────────────────────────
Thin async wrappers that isolate booking flows from conversation_intelligence
and personalisation_tools. All functions return safe defaults on failure so
they never block the booking state machine.
"""

import asyncio
import logging
from typing import Dict, Any

from agents.customer.conversation_intelligence import (
    load_conversation_context,
    classify_intent,
    log_conversation_event,
)
from tools.personalisation_tools import (
    build_personalised_greeting,
    build_order_suggestion,
)

logger = logging.getLogger(__name__)


async def safe_classify_intent(message: str, flow: str, context: dict) -> str:
    try:
        result = await classify_intent(message, flow, context)
        return result.get("intent", "unknown")
    except ModuleNotFoundError as e:
        logger.debug(f"classify_intent skipped — missing module ({e}).")
        return "unknown"
    except Exception as e:
        logger.debug(f"classify_intent failed (non-fatal): {e}")
        return "unknown"


async def safe_load_context(restaurant_id: str, customer_id: str) -> dict:
    try:
        return await load_conversation_context(restaurant_id, customer_id)
    except TypeError as e:
        logger.debug(f"load_conversation_context AsyncSession issue: {e}")
        return {}
    except Exception as e:
        logger.debug(f"load_conversation_context failed: {e}")
        return {}


async def safe_log_event(
    restaurant_id: str, customer_id: str, session_id: str,
    event_type: str, intent: str, message: str,
) -> None:
    try:
        await log_conversation_event(
            restaurant_id, customer_id, session_id, event_type, intent, message
        )
    except TypeError as e:
        logger.debug(f"log_conversation_event AsyncSession issue: {e}")
    except Exception as e:
        logger.debug(f"log_conversation_event failed: {e}")


async def safe_build_greeting(customer_id: str, restaurant_id: str) -> str:
    try:
        return await build_personalised_greeting(customer_id, restaurant_id)
    except TypeError as e:
        logger.debug(f"build_personalised_greeting AsyncSession issue: {e}")
        return ""
    except Exception as e:
        logger.debug(f"build_personalised_greeting failed: {e}")
        return ""


async def safe_build_order_suggestion(customer_id: str, restaurant_id: str) -> str:
    try:
        return await build_order_suggestion(customer_id, restaurant_id)
    except TypeError as e:
        logger.debug(f"build_order_suggestion AsyncSession issue: {e}")
        return ""
    except Exception as e:
        logger.debug(f"build_order_suggestion failed: {e}")
        return ""


async def background_analytics(
    restaurant_id: str,
    customer_id: str,
    message: str,
    step: str,
) -> None:
    try:
        context = await safe_load_context(restaurant_id, customer_id)
        intent  = await safe_classify_intent(message, "booking_flow", context)
        await safe_log_event(
            restaurant_id, customer_id,
            f"booking_{step}", "booking_message", intent, message,
        )
    except Exception as e:
        logger.debug(f"[background-analytics] non-fatal: {e}")
