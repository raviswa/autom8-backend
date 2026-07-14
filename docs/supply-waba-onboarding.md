# Munafe Supply — WABA Onboarding Runbook

Hybrid model: **dedicated WhatsApp Business API (WABA) numbers for real suppliers**; shared Munafe number + keyword routing for demos/testing only. Prefer moving every live supplier onto a dedicated number over time.

---

## Path A — Dedicated WABA (recommended for go-live)

Use when onboarding a real supplier who will receive client orders on their own WhatsApp business number.

### Checklist

1. **Meta Business / WABA**
   - Create or attach a WhatsApp Business Account for the supplier.
   - Add and verify a phone number.
   - Complete display name / business verification as required by Meta.
   - Note the **Phone Number ID** (`waba_phone_number_id`) and a long-lived **access token**.

2. **Database**
   - Set on the supplier row in `suppliers`:
     - `waba_phone_number_id` = Meta Phone Number ID
     - Any related token/integration fields used by your deployment (match what `resolveSupplier.js` / `supply_whatsapp.py` read — typically env or per-supplier credentials).
   - Confirm the supplier is `is_active = true`.

3. **Webhook**
   - In Meta App → WhatsApp → Configuration, set the callback URL to the supply backend:
     - `https://<autom8-supply-host>/api/supply/webhook/whatsapp`
   - Verify with the supply webhook verify token (`SUPPLY_WEBHOOK_VERIFY_TOKEN` / Meta hub challenge).
   - Subscribe to `messages` (and status if used).

4. **Chat service**
   - Ensure Meta (or the supply Node server) forwards inbound payloads so Python receives them at `/webhook/supply` with `_supply_context` containing `supplier_id` and optional `client_id`.
   - Dedicated path: Node `server-supply.js` → `resolveSupplierByPhone(phone_number_id)` → chat `main_supply.py` (or shared `main.py` supply webhook).

5. **Env (chat + supply Node)**
   - `SUPPLY_FORM_SIGNING_SECRET` — same value on Node and Python chat (required for Order button → `/s/:token`).
   - `SUPPLY_FORM_BASE_URL` — e.g. `https://order.autom8.works`
   - Dedicated WABA send credentials as used by `chat/tools/supply_whatsapp.py`.

6. **Smoke test**
   - From a phone registered as an active `supply_clients` row for that supplier, send `Hi`.
   - Expect the main menu: **Order / My Balance / Record Payment**.
   - Tap **Order** → receive a `/s/<token>` link → submit a reservation → supplier sees **Requested** with Accept/Reject.

7. **Templates**
   - Confirm Meta-approved templates used by `notify.js` (`supply_order_link`, `supply_order_confirmed`, delivery, invoice, statements, etc.) exist on **this** WABA.

---

## Path B — Shared Munafe number + keyword (demos / testing)

Use while a supplier does not yet have a dedicated number. Clients message Munafe’s restaurant/shared WABA and enter via a keyword (e.g. `Hi fnb`).

### How it works

1. Shared webhook hits restaurant chat (`main.py`).
2. Keyword / LOB router dispatches `lob_type == "supply"`.
3. `_dispatch_to_lob` resolves the real bridge via `supply_clients.munafe_restaurant_id` (not by fabricating supplier_id from restaurant_id).
4. `handle_supply_message` runs with the linked `supplier_id` / `client_id`.

### Checklist

1. Supplier exists in `suppliers`.
2. Client linked with `supply_clients.munafe_restaurant_id` = the demo restaurant tenant id.
3. Short-code / keyword registered for the demo (see SQL under `chat/scripts/` if present).
4. Keep shared-path code (`_dispatch_to_lob` supply branch) maintained — it is not disposable scaffolding while demos exist.

### Limits

- Multiple suppliers cannot cleanly share one inbound number without keyword/bridge logic.
- Migrate demos to Path A before heavy real traffic.

---

## Client onboarding (both paths)

1. Supplier adds client in dashboard (`Clients` → `POST /api/supply/clients`) → welcome WhatsApp.
2. Optional: **Send form link** or client taps **Order** in WhatsApp (agent mints daily cutoff token).
3. Unknown numbers get a polite “not registered” reply; supplier phone is notified to add them.

---

## Related code

| Piece | Location |
|-------|----------|
| Resolve supplier by WABA phone id | `src/helpers/resolveSupplier.js` |
| Supply WhatsApp webhook (Node) | `src/routes/supply/webhook.js` |
| Dedicated chat entry | `chat/main_supply.py` |
| Shared / keyword dispatch | `chat/main.py` `_dispatch_to_lob` |
| Form token signing | `src/routes/supply/supplyFormToken.js` + `chat/tools/supply_form_token.py` |
| Bot menu / Order link | `chat/agents/supply_agent.py` |
