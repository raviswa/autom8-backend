# Paid sale ledger (`paid_sales` / `paid_sale_items`)

Durable item-level spend + GST written on payment success for **all LOBs**.
Invoices remain ephemeral (~3 day retention) and are **not** the owner-dashboard source of truth.

## Apply migration (required before deploy)

In Supabase SQL editor, run:

[`migrations/20260729_paid_sale_ledger.sql`](./20260729_paid_sale_ledger.sql)

## After deploy — backfill last 30 days

As an owner/manager (authenticated):

```http
POST /api/dashboard/paid-sales/backfill
Authorization: Bearer <token>
Content-Type: application/json

{ "days": 30 }
```

This freezes existing paid bookings / completed POS orders into the ledger when cart or `order_items` still exist.

## Write hooks

| Path | File |
|------|------|
| Razorpay / PhonePe mark-paid | `chat/tools/payment_tools.py` → `paid_sale_ledger.py` |
| POS counter payment | `src/routes/pos/payments.js` |
| KDS safety net | `src/routes/kds.js` |

## Read path

`src/helpers/paidRevenue.js` prefers `paid_sales` by `paid_at`; falls back to booking/order resolver until ledger has rows.
