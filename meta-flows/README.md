# Meta WhatsApp Flow — Date/Time Calendar

Shared Flow for **scheduled delivery**, **scheduled takeaway**, and **table reservations**.

## Files

| File | Purpose |
|------|---------|
| `reservation_schedule_flow.json` | Flow JSON with dynamic `min_date` / `max_date` on the DatePicker |

## Publish to Meta

1. Open [Meta Business Suite](https://business.facebook.com) → **WhatsApp Manager** → your WABA → **Account tools** → **Flows**.
2. Either **create a new Flow** or **edit** the existing reservation/delivery schedule Flow.
3. Switch to **JSON editor** and paste / merge from `reservation_schedule_flow.json`.
4. Ensure the screen id stays **`RESERVATION_SCREEN`** (matches `send_whatsapp_flow` in the chat service).
5. Field names must stay **`reservation_date`** and **`reservation_time`** (webhook parser expects these).
6. Publish the Flow and copy the Flow ID into Railway env:
   - `META_FLOW_DELIVERY_SCHEDULE_ID`
   - `META_FLOW_TAKEAWAY_SCHEDULE_ID` (optional; falls back to delivery/reservation id)
   - `META_FLOW_RESERVATION_ID`

## Dynamic date limits (backend)

Each calendar invite sends fresh bounds in the navigate payload:

```json
{
  "screen": "RESERVATION_SCREEN",
  "data": {
    "min_date": "2026-06-18",
    "max_date": "2026-06-25"
  }
}
```

The DatePicker binds:

```json
"min-date": "${data.min_date}",
"max-date": "${data.max_date}"
```

**Requires Flow JSON ≥ 5.0** for timezone-safe `YYYY-MM-DD` dates.

## Updating an existing Flow (minimal patch)

If you already have a working Flow and only need the 7-day cap in the UI:

1. On screen `RESERVATION_SCREEN`, add to `data`:

```json
"min_date": { "type": "string", "__example__": "2026-06-18" },
"max_date": { "type": "string", "__example__": "2026-06-25" }
```

2. On the DatePicker component, set:

```json
"min-date": "${data.min_date}",
"max-date": "${data.max_date}"
```

3. Republish. No backend change needed beyond redeploying chat (already sends `data`).

## Env vars (Python chat + Node API)

| Variable | Default | Meaning |
|----------|---------|---------|
| `SCHEDULED_DELIVERY_MIN_BUFFER_HOURS` | `3` | Minimum notice; rounded up to next hour |
| `SCHEDULED_DELIVERY_MAX_DAYS` | `7` | Latest bookable calendar day |
| `SCHEDULED_DELIVERY_SLOT_MINUTES` | `60` | Slot granularity |

Backend still validates slots even if the Flow UI allows a wider range.
