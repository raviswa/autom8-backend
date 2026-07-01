"""Receipt maintenance helpers used by scheduler_tools."""

from __future__ import annotations

from datetime import datetime, timezone, timedelta
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


async def cleanup_expired_receipts() -> None:
    """Delete old receipt images from Supabase Storage bucket.

    This keeps the Receipts bucket lean while customer links still expire in 48h.
    Default retention is 3 days and can be overridden via RECEIPT_RETENTION_DAYS.
    """
    base = (os.getenv("AUTOM8_SUPABASE_URL") or "").rstrip("/")
    key = (os.getenv("AUTOM8_SUPABASE_SERVICE_KEY") or "").strip()
    bucket = (os.getenv("RECEIPT_STORAGE_BUCKET") or "Receipts").strip() or "Receipts"
    retention_days = max(2, int(os.getenv("RECEIPT_RETENTION_DAYS") or "3"))

    if not (base and key):
        logger.info("[receipt-cleanup] Skipped — Supabase env not configured")
        return

    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

    deleted = 0
    scanned = 0
    offset = 0
    page_size = 200

    async with httpx.AsyncClient(timeout=20) as client:
        while True:
            resp = await client.post(
                f"{base}/storage/v1/object/list/{bucket}",
                json={
                    "prefix": "",
                    "limit": page_size,
                    "offset": offset,
                    "sortBy": {"column": "created_at", "order": "asc"},
                },
                headers=headers,
            )
            if resp.status_code != 200:
                logger.warning(
                    f"[receipt-cleanup] List failed {resp.status_code}: {resp.text[:200]}"
                )
                return

            rows = resp.json() if isinstance(resp.json(), list) else []
            if not rows:
                break

            to_delete: list[str] = []
            for row in rows:
                scanned += 1
                name = str((row or {}).get("name") or "").strip()
                if not name:
                    continue
                ts = _parse_ts((row or {}).get("created_at") or (row or {}).get("updated_at"))
                if ts and ts < cutoff:
                    to_delete.append(name)

            if to_delete:
                dresp = await client.delete(
                    f"{base}/storage/v1/object/{bucket}",
                    json=to_delete,
                    headers=headers,
                )
                if dresp.status_code not in (200, 204):
                    logger.warning(
                        f"[receipt-cleanup] Delete failed {dresp.status_code}: {dresp.text[:200]}"
                    )
                else:
                    deleted += len(to_delete)

            if len(rows) < page_size:
                break
            offset += page_size

    logger.info(
        f"[receipt-cleanup] scanned={scanned} deleted={deleted} retention_days={retention_days}"
    )
