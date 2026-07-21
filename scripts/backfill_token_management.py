#!/usr/bin/env python3
"""
One-time backfill: enable token_management for every existing tenant.

Usage (from autom8-backend-main/):
  # Always dry-run first:
  python scripts/backfill_token_management.py --dry-run

  # Apply (writes subscribed_features / services_enabled):
  python scripts/backfill_token_management.py --apply

  # After apply, optionally notify managers (WhatsApp + email):
  python scripts/backfill_token_management.py --notify-only
  # or combined:
  python scripts/backfill_token_management.py --apply --notify

Reuses tools.feature_gate._normalize_services_enabled so parsing matches runtime.
Preserves each row's existing storage format (list / dict / JSON string / CSV).
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections import Counter
from pathlib import Path
from typing import Any

# Allow `from tools.feature_gate import ...` when run from repo root / scripts/
_CHAT_DIR = Path(__file__).resolve().parents[1] / "chat"
if str(_CHAT_DIR) not in sys.path:
    sys.path.insert(0, str(_CHAT_DIR))

# Load .env from backend root (same as Node scripts)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
except Exception:
    pass

import httpx

from tools.feature_gate import _normalize_services_enabled, invalidate

try:
    from db.models import Feature
    TOKEN = Feature.TOKEN_MANAGEMENT  # "token_management"
except Exception:  # pragma: no cover — string matches Feature.TOKEN_MANAGEMENT
    TOKEN = "token_management"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("backfill_token_management")

NOTIFY_WA_TEMPLATE = "token_queue_feature_live"
NOTIFY_TEXT = (
    "New: your customers can now grab a queue token directly on WhatsApp — "
    "no extra setup needed. This shows up as '🎫 Token / Queue' in their "
    "ordering menu alongside your existing options."
)


def _supabase() -> tuple[str, dict]:
    url = (
        os.getenv("SUPABASE_URL")
        or os.getenv("AUTOM8_SUPABASE_URL")
        or ""
    ).rstrip("/")
    key = (
        os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        or os.getenv("AUTOM8_SUPABASE_SERVICE_KEY")
        or ""
    )
    if not url or not key or "your-project" in url:
        raise SystemExit(
            "SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY must be set "
            "(pointing at the target project)."
        )
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    return url, headers


def _detect_source_field(row: dict) -> str:
    """Which column feature_gate would actually read (services_enabled first)."""
    if row.get("services_enabled") not in (None, "", [], {}):
        return "services_enabled"
    return "subscribed_features"


def _detect_format(raw: Any) -> str:
    if raw is None:
        return "null"
    if isinstance(raw, dict):
        return "dict"
    if isinstance(raw, list):
        return "list"
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return "empty_string"
        try:
            parsed = json.loads(s)
            if isinstance(parsed, dict):
                return "json_string_dict"
            if isinstance(parsed, list):
                return "json_string_list"
            return "json_string_other"
        except Exception:
            if "," in s:
                return "csv_string"
            return "plain_string"
    return type(raw).__name__


def _encode_same_format(raw: Any, features: list[str], fmt: str) -> Any:
    """Write features back in the same shape the row already used."""
    if fmt == "dict" or fmt == "json_string_dict":
        # Preserve prior true/false keys where possible; set TOKEN true.
        base: dict[str, bool] = {}
        if isinstance(raw, dict):
            base = {str(k): bool(v) for k, v in raw.items()}
        elif isinstance(raw, str):
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, dict):
                    base = {str(k): bool(v) for k, v in parsed.items()}
            except Exception:
                pass
        for f in features:
            base[f] = True
        base[TOKEN] = True
        return json.dumps(base) if fmt == "json_string_dict" else base

    if fmt == "csv_string":
        return ",".join(features)

    if fmt == "json_string_list" or fmt == "json_string_other" or fmt == "plain_string":
        return json.dumps(features)

    if fmt in ("null", "empty_string"):
        return features  # native JSONB list — matches Node onboarding writes

    # list / unknown → native list (Postgres JSONB)
    return features


def _fetch_all_tenants(url: str, headers: dict) -> list[dict]:
    """Page through tenants (PostgREST max rows)."""
    out: list[dict] = []
    page_size = 500
    offset = 0
    with httpx.Client(timeout=60) as client:
        while True:
            resp = client.get(
                f"{url}/rest/v1/tenants",
                headers=headers,
                params={
                    "select": (
                        "id,name,subscribed_features,services_enabled,"
                        "manager_phone,contact_email,email,is_active"
                    ),
                    "order": "created_at.asc",
                    "limit": str(page_size),
                    "offset": str(offset),
                },
            )
            if resp.status_code == 400 and "services_enabled" in (resp.text or ""):
                # Column may not exist — retry without it.
                resp = client.get(
                    f"{url}/rest/v1/tenants",
                    headers=headers,
                    params={
                        "select": (
                            "id,name,subscribed_features,"
                            "manager_phone,contact_email,email,is_active"
                        ),
                        "order": "created_at.asc",
                        "limit": str(page_size),
                        "offset": str(offset),
                    },
                )
            resp.raise_for_status()
            batch = resp.json() or []
            out.extend(batch)
            if len(batch) < page_size:
                break
            offset += page_size
    return out


def _update_tenant(url: str, headers: dict, tenant_id: str, field: str, value: Any) -> None:
    with httpx.Client(timeout=30) as client:
        resp = client.patch(
            f"{url}/rest/v1/tenants",
            headers=headers,
            params={"id": f"eq.{tenant_id}"},
            json={field: value},
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"PATCH failed {resp.status_code}: {resp.text[:300]}")


def plan_row(row: dict) -> dict:
    """Return plan dict for one tenant; never raises."""
    tid = row.get("id")
    name = row.get("name") or "?"
    try:
        source = _detect_source_field(row)
        raw = row.get(source)
        fmt = _detect_format(raw)
        normalized = _normalize_services_enabled(row)
        has_token = TOKEN in normalized or str(TOKEN) in normalized
        if has_token:
            return {
                "id": tid,
                "name": name,
                "action": "skip",
                "source_field": source,
                "format": fmt,
                "features": normalized,
            }
        new_features = list(normalized) + [TOKEN]
        encoded = _encode_same_format(raw, new_features, fmt)
        return {
            "id": tid,
            "name": name,
            "action": "update",
            "source_field": source,
            "format": fmt,
            "features_before": normalized,
            "features_after": new_features,
            "encoded": encoded,
            "manager_phone": row.get("manager_phone"),
            "email": (row.get("contact_email") or row.get("email") or "").strip() or None,
        }
    except Exception as e:
        return {
            "id": tid,
            "name": name,
            "action": "fail",
            "error": str(e),
        }


def run_backfill(*, dry_run: bool, apply: bool) -> dict:
    url, headers = _supabase()
    tenants = _fetch_all_tenants(url, headers)
    format_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    updated = skipped = failed = 0
    failures: list[str] = []
    would_update: list[dict] = []

    for row in tenants:
        plan = plan_row(row)
        if plan.get("format"):
            format_counts[plan["format"]] += 1
        if plan.get("source_field"):
            source_counts[plan["source_field"]] += 1

        if plan["action"] == "skip":
            skipped += 1
            continue
        if plan["action"] == "fail":
            failed += 1
            failures.append(f"{plan['id']} ({plan['name']}): {plan.get('error')}")
            logger.error("row failed: %s", failures[-1])
            continue

        would_update.append(plan)
        if dry_run or not apply:
            updated += 1  # counted as "would update"
            continue

        try:
            _update_tenant(url, headers, plan["id"], plan["source_field"], plan["encoded"])
            invalidate(str(plan["id"]))
            updated += 1
            logger.info(
                "updated %s (%s) field=%s fmt=%s",
                plan["id"], plan["name"], plan["source_field"], plan["format"],
            )
        except Exception as e:
            failed += 1
            failures.append(f"{plan['id']} ({plan['name']}): {e}")
            logger.error("update failed: %s", failures[-1])

    summary = {
        "total": len(tenants),
        "updated_or_would_update": updated,
        "skipped_already_present": skipped,
        "failed": failed,
        "format_counts": dict(format_counts),
        "source_field_counts": dict(source_counts),
        "failures": failures,
        "sample_updates": [
            {
                "id": p["id"],
                "name": p["name"],
                "field": p["source_field"],
                "format": p["format"],
                "before": p.get("features_before"),
                "after": p.get("features_after"),
            }
            for p in would_update[:15]
        ],
    }
    return summary


def _send_notifications(plans_or_tenants: list[dict]) -> dict:
    """
    Notify managers for tenants that received token_management.
    Reuses Node mailer + WhatsApp via subprocess/http — kept in Node helper
    for TEMPLATES/mailer reuse. This Python path logs intended recipients;
    actual send is scripts/notify_token_queue_feature.js
    """
    # Defer to Node notifier so we reuse notify.js TEMPLATES + mailer exactly.
    raise SystemExit(
        "Use: node scripts/notify_token_queue_feature.js "
        "(after reviewing dry-run / apply). "
        "Python --notify delegates there."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log what would change; no writes (default if neither --apply nor --notify).",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write token_management onto tenants missing it.",
    )
    parser.add_argument(
        "--notify",
        action="store_true",
        help="After apply, send WhatsApp+email via scripts/notify_token_queue_feature.js",
    )
    args = parser.parse_args()

    dry_run = args.dry_run or not args.apply
    if args.apply and args.dry_run:
        raise SystemExit("Pass either --dry-run or --apply, not both.")

    mode = "DRY-RUN" if dry_run else "APPLY"
    logger.info("=== backfill_token_management %s ===", mode)

    summary = run_backfill(dry_run=dry_run, apply=args.apply and not dry_run)

    print("\n========== SUMMARY ==========")
    print(f"mode:                      {mode}")
    print(f"total tenants:              {summary['total']}")
    print(f"would update / updated:     {summary['updated_or_would_update']}")
    print(f"skipped (already had it):   {summary['skipped_already_present']}")
    print(f"failed:                     {summary['failed']}")
    print(f"source field counts:        {summary['source_field_counts']}")
    print(f"storage format counts:      {summary['format_counts']}")
    if len(summary["format_counts"]) > 1:
        print(
            "\n⚠ FLAG: inconsistent services_enabled/subscribed_features "
            "storage formats across tenants — this backfill preserves each "
            "row's format and does NOT normalize them to one shape."
        )
    if summary["sample_updates"]:
        print("\n--- sample changes (up to 15) ---")
        for s in summary["sample_updates"]:
            print(
                f"  {s['name']} ({s['id']}) "
                f"[{s['field']}/{s['format']}]\n"
                f"    before: {s['before']}\n"
                f"    after:  {s['after']}"
            )
    if summary["failures"]:
        print("\n--- failures ---")
        for f in summary["failures"]:
            print(f"  {f}")
    print("=============================\n")

    if args.notify:
        if dry_run:
            print("Skipping --notify during dry-run (no messages sent).")
        else:
            import subprocess
            rc = subprocess.call(
                ["node", "scripts/notify_token_queue_feature.js"],
                cwd=str(Path(__file__).resolve().parents[1]),
            )
            if rc != 0:
                raise SystemExit(rc)


if __name__ == "__main__":
    main()
