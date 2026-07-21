"""
Static walk-in wait estimate at token issuance (mirrors src/helpers/waitEstimate.js).
"""

from __future__ import annotations

import math
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import text

from tools.db_tools import AsyncSessionLocal

DEFAULT_DINING_MINUTES = 45
TURNOVER_MINUTES = 5
MIN_REMAINING_FLOOR = 5
RANGE_BUFFER = 10


def _auto_assign_time_message() -> str:
    """Mirror the Node auto-assign grace-period configuration."""
    try:
        low = max(1, int(os.getenv("DINEIN_AUTO_ASSIGN_MIN_MINUTES", "2")))
    except (TypeError, ValueError):
        low = 2
    try:
        high = max(low, int(os.getenv("DINEIN_AUTO_ASSIGN_MAX_MINUTES", "4")))
    except (TypeError, ValueError):
        high = max(low, 4)
    return f"{low} minutes" if low == high else f"{low}–{high} minutes"


def _dropout_rate(party_size: int) -> float:
    p = max(1, int(party_size or 1))
    if p >= 5:
        return 0.35
    if p >= 3:
        return 0.20
    return 0.15


def format_wait_display(low: int, high: int, estimate_minutes: int) -> str:
    if estimate_minutes == 0:
        return "Ready to seat now"
    if estimate_minutes < 0:
        return "No suitable table available"
    if low < 15:
        return "Less than 15 minutes"
    if low < 30:
        return "Around 20–30 minutes"
    return f"Approximately {low}–{high} minutes"


def build_dinein_customer_message(party_size: int, token_id: str, estimate: dict[str, Any]) -> str:
    pax = max(1, int(party_size or 1))
    people = f"{pax} {'person' if pax == 1 else 'people'}"
    est_min = int(estimate.get("estimate_minutes", 0))

    if est_min == 0:
        return (
            f"Your token is *{token_id}* 🎟\n"
            f"Party of {people}\n"
            f"A suitable table is available. The manager can assign it now; if they "
            f"haven't responded, we'll automatically assign it within about "
            f"*{_auto_assign_time_message()}* and send your table number here."
        )
    if est_min < 0:
        return (
            f"Party of *{pax}* — we've noted your visit! 🍽️\n\n"
            f"*Token: {token_id}*\n\n"
            f"Our team will assist you shortly — please speak with the host. 🙏"
        )
    display = estimate.get("display") or format_wait_display(
        estimate.get("low", 0), estimate.get("high", 0), est_min,
    )
    return (
        f"Your token is *{token_id}* 🎟\n"
        f"Party of {people} · *{display}*\n"
        f"We'll notify you when your table is ready."
    )


async def calculate_wait_estimate(
    restaurant_id: str,
    party_size: int,
    token_arrived_at: str,
    token_id: str | None = None,
) -> dict[str, Any]:
    if AsyncSessionLocal is None:
        return {
            "estimate_minutes": 0,
            "low": 0,
            "high": 0,
            "display": "Ready to seat now",
            "waitlist_depth": 0,
        }

    pax = max(1, int(party_size or 1))
    now = datetime.now(timezone.utc)
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    async with AsyncSessionLocal() as session:
        rest = await session.execute(
            text("SELECT dining_duration_minutes FROM tenants WHERE id = CAST(:rid AS uuid)"),
            {"rid": restaurant_id},
        )
        row = rest.mappings().first()
        dining_minutes = int(row["dining_duration_minutes"] or 0) if row else 0
        if dining_minutes <= 0:
            dining_minutes = DEFAULT_DINING_MINUTES

        tables = await session.execute(
            text("""
                SELECT id, capacity, status, is_active, seated_at, updated_at
                FROM tables
                WHERE restaurant_id = CAST(:rid AS uuid) AND is_active = true
            """),
            {"rid": restaurant_id},
        )
        all_tables = [dict(r) for r in tables.mappings().all()]
        eligible = [t for t in all_tables if int(t.get("capacity") or 4) >= pax]

        if not eligible:
            return {
                "estimate_minutes": -1,
                "low": 0,
                "high": 0,
                "display": format_wait_display(0, 0, -1),
                "waitlist_depth": 0,
            }

        free = [
            t for t in eligible
            if str(t.get("status") or "available").lower() in ("available", "free")
        ]
        if free:
            return {
                "estimate_minutes": 0,
                "low": 0,
                "high": 0,
                "display": format_wait_display(0, 0, 0),
                "waitlist_depth": 0,
            }

        occupied = [t for t in eligible if str(t.get("status") or "").lower() == "occupied"]
        remaining: list[int] = []

        for table in occupied:
            tid = table["id"]
            order_row = await session.execute(
                text("""
                    SELECT created_at FROM orders
                    WHERE restaurant_id = CAST(:rid AS uuid)
                      AND table_id = CAST(:tid AS uuid)
                      AND created_at >= :day_start
                    ORDER BY created_at ASC
                    LIMIT 1
                """),
                {"rid": restaurant_id, "tid": str(tid), "day_start": day_start},
            )
            ord_first = order_row.mappings().first()
            started = None
            if ord_first:
                started = ord_first["created_at"]
            elif table.get("seated_at"):
                started = table["seated_at"]
            elif table.get("updated_at"):
                started = table["updated_at"]

            if started and started.tzinfo is None:
                started = started.replace(tzinfo=timezone.utc)
            elapsed = 0
            if started:
                elapsed = max(0, int((now - started.astimezone(timezone.utc)).total_seconds() // 60))
            remaining.append(max(MIN_REMAINING_FLOOR, dining_minutes - elapsed))

        remaining.sort()

        ahead_sql = """
            SELECT COUNT(*) AS cnt FROM walk_in_tokens
            WHERE restaurant_id = CAST(:rid AS uuid)
              AND status = 'waiting'
              AND type = 'dinein'
              AND pax <= :pax
              AND arrived_at >= :day_start
              AND arrived_at < CAST(:arrived AS timestamptz)
        """
        params: dict[str, Any] = {
            "rid": restaurant_id,
            "pax": pax,
            "day_start": day_start,
            "arrived": token_arrived_at,
        }
        if token_id:
            ahead_sql += " AND id <> :tid"
            params["tid"] = token_id

        ahead_res = await session.execute(text(ahead_sql), params)
        w = int((ahead_res.mappings().first() or {}).get("cnt") or 0)
        effective_w = math.floor(w * (1 - _dropout_rate(pax)))

        if not occupied:
            estimate_min = dining_minutes + TURNOVER_MINUTES
            low = max(5, estimate_min - RANGE_BUFFER)
            high = estimate_min + RANGE_BUFFER
            return {
                "estimate_minutes": estimate_min,
                "low": low,
                "high": high,
                "display": format_wait_display(low, high, estimate_min),
                "waitlist_depth": w,
            }

        n_tables = len(occupied)
        wave = effective_w // n_tables
        table_index = effective_w % n_tables
        base_wait = remaining[table_index] if table_index < len(remaining) else remaining[-1]
        estimate_min = base_wait + wave * dining_minutes + TURNOVER_MINUTES
        low = max(5, estimate_min - RANGE_BUFFER)
        high = estimate_min + RANGE_BUFFER

        return {
            "estimate_minutes": estimate_min,
            "low": low,
            "high": high,
            "display": format_wait_display(low, high, estimate_min),
            "waitlist_depth": w,
        }


async def apply_wait_estimate_to_token(
    restaurant_id: str,
    token_id: str,
    party_size: int,
    arrived_at: str,
) -> dict[str, Any] | None:
    """Compute and persist estimate on walk_in_tokens row."""
    if AsyncSessionLocal is None:
        return None

    estimate = await calculate_wait_estimate(
        restaurant_id, party_size, arrived_at, token_id,
    )
    async with AsyncSessionLocal() as session:
        await session.execute(
            text("""
                UPDATE walk_in_tokens SET
                  capacity_requested = :pax,
                  estimated_wait_minutes = :est,
                  waitlist_depth_at_issue = :depth,
                  estimate_display = :display
                WHERE id = :tid
            """),
            {
                "pax": party_size,
                "est": estimate["estimate_minutes"],
                "depth": estimate["waitlist_depth"],
                "display": estimate["display"],
                "tid": token_id,
            },
        )
        await session.commit()
    return estimate
