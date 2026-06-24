# Munafe Platform — Technical Specification
**Version:** 1.4  
**Maintained by:** Autom8 Works  
**Last updated:** 23 June 2026  
**Purpose:** Authoritative reference for engineers, technical support, and the AI chatbot. All feature specs, API contracts, data models, agent flow states, and scheduler ownership documented here are derived directly from the production codebase (`autom8-backend` + `autom8-frontend` on GitHub).

**Chatbot usage:** When answering questions about Munafe, prefer this document over assumptions. If code and this doc disagree, the deployed code wins — file a doc update. Key rule: **Node.js owns staff API, feedback scheduler, marketing scheduler, and the primary WhatsApp webhook ingress; Python owns conversational booking flows and session state.**

---

## Table of Contents

1. [Platform Overview](#1-platform-overview)
2. [Architecture Overview](#2-architecture-overview)
3. [Infrastructure & Configuration](#3-infrastructure--configuration)
4. [Authentication & Authorization](#4-authentication--authorization)
5. [WhatsApp Ordering Engine](#5-whatsapp-ordering-engine)
6. [Walk-in Token System](#6-walk-in-token-system)
7. [Table Management & KDS](#7-table-management--kds)
8. [POS Order Management](#8-pos-order-management)
9. [Menu Management & Catalog Sync](#9-menu-management--catalog-sync)
10. [Table Reservations](#10-table-reservations)
11. [Feedback System](#11-feedback-system)
12. [Referral System](#12-referral-system)
13. [Delivery Management](#13-delivery-management)
14. [Marketing & CRM](#14-marketing--crm)
15. [Staff Management](#15-staff-management)
16. [Subscription & Feature Gating](#16-subscription--feature-gating)
17. [Brand & Chain Management](#17-brand--chain-management)
18. [Restaurant Settings](#18-restaurant-settings)
19. [Receipt & Invoice Generation](#19-receipt--invoice-generation)
20. [Registration & Onboarding](#20-registration--onboarding)
21. [Owner Dashboard](#21-owner-dashboard)
22. [Background Schedulers](#22-background-schedulers)
23. [Real-time WebSocket Events](#23-real-time-websocket-events)
24. [Upcoming: Item Preferences & Personalisation](#24-upcoming-item-preferences--personalisation)
25. [Proposed New Features](#25-proposed-new-features)

---

## 1. Platform Overview

Munafe is a multi-tenant WhatsApp-first SaaS platform for restaurant operations. It combines a customer-facing conversational ordering agent (WhatsApp bot) with a full restaurant management suite (POS, KDS, reservations, marketing, analytics).

**Core value proposition:**
- Customers order, reserve tables, and track pickups entirely via WhatsApp — no app download, no website login.
- Restaurant staff manage the full operation from a single web dashboard (app.autom8.works).
- Brand/chain owners get a consolidated view across multiple outlets.

**Tenancy model:** Each outlet is a row in the `restaurants` table. Outlets may be grouped under a `brands` record. A single WhatsApp Business Account (WABA) can serve one brand with multiple numbers or one number per outlet.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  Customer (WhatsApp)                                                  │
│        ↕ Meta Cloud API (webhook / send)                             │
├──────────────────────────────────────────────────────────────────────┤
│  Node.js Express Service  (api.autom8.works)  ← PRIMARY WEBHOOK      │
│  POST /api/whatsapp/webhook → feedback / referral / catalog order    │
│                            → forward conversational msgs to Python   │
│  Routes: auth, dashboard, marketing, brands, kds, catalog,           │
│          tokens, feedback, referrals, delivery, enterprise,          │
│          invoices, subscription, pos, onboarding, takeaway, staff    │
│  Schedulers: feedback, marketing, slot release, accounting sync    │
├──────────────────────────────────────────────────────────────────────┤
│  Python FastAPI Service  (chat.autom8.works)                         │
│  ┌────────────────┐  ┌─────────────────┐  ┌──────────────────────┐  │
│  │ Identity Agent │  │  Booking Agent  │  │ Manager Commands     │  │
│  └────────────────┘  └─────────────────┘  └──────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  Root Agent (route_message)  ←  cart_tools, feature_gate    │    │
│  └──────────────────────────────────────────────────────────────┘    │
│  Receives proxied webhooks from Node at POST /webhook/botbiz       │
├──────────────────────────────────────────────────────────────────────┤
│  Supabase (PostgreSQL + PostgREST + Auth + Realtime + Storage)       │
├──────────────────────────────────────────────────────────────────────┤
│  React SPA  (app.autom8.works)                                       │
│  Pages: OwnerDashboard, OwnerInsights, ManagerPortal, KDSScreen,   │
│         MarketingDashboard, BrandDashboard, CaptainPortal, MenuPage│
│         WalkInForm, LoginPage, ForgotPasswordPage, ResetPasswordPage │
│         SettingsPanel                                                │
└──────────────────────────────────────────────────────────────────────┘
```

**Service separation rule:**
- **Node.js** owns staff-facing REST API, POS operations, dashboard queries, WhatsApp webhook ingress (production), feedback queue + scheduler, marketing broadcasts + automations, and all Node background schedulers.
- **Python** owns customer-facing WhatsApp conversation flows, `booking_step` session state, cart/catalog ordering, Razorpay payment links, and reservation reminders (active Python scheduler jobs only).
- Both services share the same Supabase Postgres database; Python uses SQLAlchemy async ORM; Node uses Supabase PostgREST JS client.

**Dual data model (important):** Python booking agent uses `bookings` + `table_status` (SQLAlchemy models). Node POS/tokens layer primarily uses `walk_in_tokens` + `tables` + `orders`. Both coexist; Python session `context` JSON stores `booking_step` in `conversation_states`.

### WhatsApp message ingress (production)

```
Meta Cloud API
    ↓
POST api.autom8.works/api/whatsapp/webhook   (Node)
    ↓
1. Auto-reply filter → silently ignore
2. type=order        → handleWhatsAppOrder() (catalog basket)
3. Feedback reply    → handleFeedbackReply() (Node feedbackFlow.js)
4. Referral code     → validateReferralCode()
5. All other msgs    → forwardToChatService()
                           ↓
                    POST chat.autom8.works/webhook/botbiz   (Python)
                           ↓
                    route_message() → identity / cart / booking flows
```

**Alternate path:** Meta may also POST directly to Python `POST /webhook/meta|botbiz|whatsapp` (HMAC-verified). Production routing is typically Node-first.

---

## 3. Infrastructure & Configuration

### Deployment
| Service | Platform | Domain |
|---|---|---|
| Node.js API | Railway | api.autom8.works |
| React SPA | Railway | app.autom8.works |
| Python chat agent | Railway | chat.autom8.works |
| Database | Supabase (ap-southeast-1) | — |
| File storage | Supabase Storage | Receipts bucket |
| Marketing site + registration form | Hostinger WordPress (Astra theme) | autom8.works |

### Environment Variables (Node.js)
| Variable | Purpose |
|---|---|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key for admin client |
| `SUPABASE_ANON_KEY` | Public anon key (some auth flows) |
| `AUTOM8_KDS_SECRET` | Internal service auth (**required in production**); shared with Python |
| `WHATSAPP_ACCESS_TOKEN` | Meta Cloud API bearer token (global fallback) |
| `WHATSAPP_PHONE_NUMBER_ID` | Default phone number ID |
| `WHATSAPP_PHONE_NUMBER` | Display number; used for auto-reply context detection |
| `META_WEBHOOK_VERIFY_TOKEN` | Webhook verification challenge |
| `CHAT_SERVICE_URL` | Python chat base URL (default `http://localhost:8001`; prod: `https://chat.autom8.works`) |
| `DEFAULT_RESTAURANT_ID` | Dev/staging fallback tenant when phone_number_id lookup fails |
| `MANAGER_WHATSAPP_NUMBER` | Accounting sync notification recipient |
| `FRONTEND_URL` | Allowed CORS origin (default `https://app.autom8.works`) |
| `GROQ_API_KEY` | Marketing AI copy endpoints (`/ai-suggest`, `/ai-rewrite`, `/ai-generate`) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Transactional email fallback for password reset |
| `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`, `ZOHO_ORG_ID` | Nightly Zoho Books invoice sync |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Payment gateway (Node receipt paths) |
| `REGION` | `IN` / `AE` / `EU` — currency, timezone |
| `META_ACCESS_TOKEN`, `META_CATALOG_ID`, `META_DATA_SOURCE_ID` | Catalog sync / feed |
| `API_BASE_URL` | Receipt verify URLs |
| `RAILWAY_GIT_COMMIT_SHA` | Deploy fingerprint in `/health` |

### Environment Variables (Python)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Direct asyncpg connection string |
| `AUTOM8_SUPABASE_URL` | Supabase URL (fallback DB URL builder) |
| `AUTOM8_SUPABASE_SERVICE_KEY` | Service key (fallback DB URL builder) |
| `GOOGLE_API_KEY` | Gemini 2.0 Flash (conversation intelligence) |
| `BOTBIZ_PHONE_NUMBER_ID` | Default Meta phone number ID |
| `BOTBIZ_ACCESS_TOKEN` | Default Meta access token |
| `BOTBIZ_WEBHOOK_VERIFY_TOKEN` | Webhook verification |
| `WEBHOOK_SECRET` | HMAC signature validation |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Payment links |
| `META_FLOW_RESERVATION_ID` | Meta Flow ID for reservation widget |

### Per-restaurant WhatsApp credentials
Stored in `restaurant_integrations` table (provider = `meta`, channel = `whatsapp`). The Python agent calls `get_restaurant_integration(restaurant_id)` to retrieve `phone_number_id` and `access_token` at runtime, allowing each outlet to use its own WhatsApp number.

---

## 4. Authentication & Authorization

### JWT Flow
- Supabase Auth issues JWTs on login.
- All Node.js protected routes use `authenticateToken` middleware: validates the Bearer token via `supabaseAdmin.auth.getUser(token)`, attaches `req.user = { sub, email }`.
- `getRestaurantId` middleware then queries `employees` for the authenticated user's `restaurant_id`, `brand_id`, `role`, and `is_active`. Attaches `req.restaurant_id`, `req.brand_id`, `req.user_role`, `req.scope`.

### Roles
```
employees.role CHECK: brand_owner | brand_manager | owner | manager 
                      | kitchen_staff | captain | waiter | marketing
```

| Role | Scope | Access |
|---|---|---|
| `brand_owner` | Brand | All outlets under brand; brand settings; menu push |
| `brand_manager` | Brand | Read/manage all outlets; no billing |
| `owner` | Outlet | Full outlet access; subscription management |
| `manager` | Outlet | Queue, orders, tables, menu; no billing |
| `kitchen_staff` | Outlet | KDS screen only |
| `captain` | Outlet | Walk-in form, captain portal (takeaway scan) |
| `waiter` | Outlet | Walk-in form only |
| `marketing` | Outlet | Marketing dashboard only |

### Frontend Auth
- `AuthContext.jsx` stores the Supabase session and user profile; supports token refresh via `POST /api/auth/refresh`.
- `SubscriptionContext.jsx` fetches `GET /api/subscription` on mount; exposes `hasFeature(name)`, `hasAnyOf([...])`, `hasAllOf([...])`.
- `FeatureWall.jsx` renders a feature-locked screen if a route's required feature is not in the subscription.

### Password Reset
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/forgot-password` | Triggers Supabase reset email; manager fallback via Resend with recovery link |
| `POST` | `/api/auth/refresh` | Refresh JWT using `refreshToken` |
| `POST` | `/api/staff/:id/send-password-reset` | Owner/manager triggers reset for staff member |

**Frontend:** `/forgot-password` (`ForgotPasswordPage`), `/reset-password` (`ResetPasswordPage` — Supabase recovery URL hash).

**Implementation:** `src/helpers/passwordReset.js`, `src/routes/auth.js`, `src/routes/staff.js`.

## 5. WhatsApp Ordering Engine

### Overview
Customer WhatsApp messages enter via **Node webhook** (`POST /api/whatsapp/webhook`), which filters auto-replies and routes feedback/referrals locally before proxying conversational messages to the **Python FastAPI** service. Session state is persisted per `(restaurant_id, customer_phone)` in `conversation_states`.

### Webhook Endpoints

**Node (primary ingress — `api.autom8.works`)**
```
GET  /api/whatsapp/webhook   — Meta webhook verification (hub.challenge)
POST /api/whatsapp/webhook   — Inbound message handler + proxy to Python
```

**Python (conversational agent — `chat.autom8.works`)**
```
GET  /webhook/meta|botbiz|whatsapp   — Meta webhook verification
POST /webhook/meta|botbiz|whatsapp   — Inbound handler (direct or proxied from Node)
GET  /r/{token}                      — Receipt redirect via Supabase Storage
```

Python `_process_meta_payload()` deduplicates via in-memory `message_id` cache (1000 entries), extracts message body, resolves restaurant by `metadata.phone_number_id` or WhatsApp number, and dispatches to `route_message()`.

### Auto-reply suppression (Node + Python)

When a customer's WhatsApp Business account has an auto-response configured (e.g. *"Hi, thanks for contacting us. We've received your message…"*), responding to it creates a confusing loop. Both services filter these **before** any routing.

**Detection signals** (`src/helpers/whatsappAutoReply.js`, `chat/tools/auto_reply_filter.py`):
1. Meta `system` messages → always ignore
2. Text matches known auto-reply regex patterns (thanks for contacting, received your message, out of office, business hours, automated response, etc.)
3. Quoted reply to restaurant number (`context.from`) **plus** weak auto-reply keywords and message length ≥ 25 chars

**Preserved (never filtered):** Short customer replies — ratings `1`–`5`, `SKIP`, `MENU`, `YES`/`NO`, interactive button/list replies.

**Applied at:**
- Node `src/routes/webhook.js` — before feedback, referral, or chat proxy
- Python `chat/main.py` — before `route_message()`
- Node `handleFeedbackReply()` — safety net during feedback flow

**Log signature:** `[WA Webhook] Ignoring auto-reply from {phone}` or `[auto-reply] Ignoring auto-reply from {phone}`

### Agent Routing (root_agent.py → `route_message()`)

```
Incoming message
    ↓
0. Deduplication (wamid in-memory cache)
    ↓
0b. Extract interactive reply ID (button/list reply unwrap)
    ↓
1. Is sender == restaurant_manager_phone?
   YES → parse_manager_command()
    ↓
2. Does session have customer_id? (needs_identity check)
   NO → handle_identity_flow()
       ↓ on "identified" → chain to handle_booking_flow()
    ↓
3. Cart pre-router (cart_tools.handle_incoming_message)
   Owns: awaiting_quantity, awaiting_item_selection,
         all CAT: / ITEM: / CART: interactive replies
    ↓ not handled →
4. Booking flow (booking_agent.handle_booking_flow)
   Owns: all other booking_step states
   Intercepts: awaiting_feedback_rating|aspects|comment (feedback_flow.py)
```

### Booking step reference (Python `booking_step` in session context)

| Category | Steps |
|---|---|
| **Router** | `ask_service`, `awaiting_service_selection`, `awaiting_reset_confirmation`, `visit_complete` |
| **Dine-in** | `awaiting_party_size` → `awaiting_large_party_response` → `awaiting_manager_approval` → `awaiting_table_assignment` → `awaiting_order` → `awaiting_special_notes` → `visit_complete` |
| **Takeaway / Delivery** | `awaiting_address` (delivery only) → `awaiting_order` → `visit_complete` |
| **Reserve** | `awaiting_party_size` → `awaiting_flow_datetime` → `awaiting_advance_confirmation` → `visit_complete` |
| **Cart sub-flow** | `awaiting_category_selection`, `awaiting_item_selection`, `awaiting_quantity`, `awaiting_cart_action`, `awaiting_numbered_order`, `awaiting_payment` |
| **Feedback session** | `awaiting_feedback_rating`, `awaiting_feedback_aspects`, `awaiting_feedback_comment` |
| **Identity (separate key)** | `identity_step`: `awaiting_name`, `awaiting_name_confirm`, `awaiting_name_text` |

**Key session context keys:** `service_type`, `customer_name`, `cart`, `table_number`, `party_size`, `token_number`, `booking_id`, `special_notes_asked_at`, `parcel_charge_per_item`, `_kitchen_sent`, `_catalog_sent_after_party`

### Identity Agent (`identity_agent.py`)

**States:**
| `identity_step` | Meaning |
|---|---|
| *(none)* | Fresh session, trigger identity flow |
| `awaiting_name` | First-time customer, bot sent name request |
| `awaiting_name_confirm` | Bot sent button confirmation of WA profile name |
| `awaiting_name_text` | Customer rejected profile name, awaiting typed name |

**Flow:**
1. Look up customer by `(restaurant_id, phone)` in `customers` table.
2. **Returning customer:** Call `build_personalised_greeting()` (RFM-aware). Update `last_visit_date` and `visit_count`. Transition to `booking_step = "ask_service"`.
3. **New customer:** Send name confirmation buttons using WhatsApp profile name if available, else ask for name directly. On confirmation, call `create_customer()`. Transition to `booking_step = "ask_service"`.

**Returning customer greeting variations (driven by RFM + visit patterns):**

| Condition | Greeting |
|---|---|
| `visit_streak >= 5` | "You have visited us N weeks in a row — you are truly one of our favourites!" |
| `rfm_segment == "champion"` + favourite_item | "Shall we get your usual {item} started?" |
| `rfm_segment == "loyal"` | "Great to see you again! Always a pleasure having you." |
| `60 <= days_since_visit <= 90` | "It has been a while — we have missed you." |
| `days_since_visit > 90` | "What a lovely surprise. We have missed having you here!" |
| `visit_count == 2` | "So glad you chose us again." |
| Default | "Welcome back!" |

### Booking Agent (`booking_agent.py`)

#### Service menu
After identity, `ask_service` step sends a WhatsApp list message with available service types. Which services appear is gated by `feature_gate.build_service_menu_rows(restaurant_id)` which reads the restaurant's `subscribed_features`.

Services: `dine_in`, `takeaway`, `delivery`, `reserve_table`

#### Dine-in Flow (`handle_dine_in_flow`)

| Step (`booking_step`) | Trigger | Action |
|---|---|---|
| `awaiting_party_size` | User selects Dine In | Ask party size (NLU: numeric + word forms in EN/HI/TA) |
| `awaiting_large_party_response` | party_size > threshold | Send large party alert to manager; wait for approval button |
| `awaiting_manager_approval` | Large party submitted | Poll for table assignment |
| `awaiting_table_assignment` | Manager assigns table | Notify customer of table number |
| `awaiting_order` | Table assigned | Show cart (send_category_list via WhatsApp interactive list) |
| `awaiting_special_notes` | Cart confirmed | Send contextual notes hint (see below) |
| `visit_complete` | Notes submitted / timed out | Confirm booking; send KDS notification; generate receipt |

**Contextual notes hints (`_build_notes_hint`):** Analyses the cart items' names using keyword sets:
- `_VEG_KEYWORDS`, `_MEAT_KEYWORDS`, `_SOUTH_INDIAN_KEYWORDS`, `_SIDES_KEYWORDS`, `_RICE_KEYWORDS`, `_BREAD_KEYWORDS`, `_DESSERT_KEYWORDS`, `_DRINK_KEYWORDS`
- Generates item-specific prompts: biryani → raita/salan, parotta → salna/kurma, idli/dosa → sambar/chutney/butter, meat → cooking preference/no-garlic.
- Always appends: "Any allergies we should know about?"
- **This is independent of item_preferences.py's dietary filter** — it fires after the order is placed, not during menu browsing.

#### Takeaway Flow (`handle_takeaway_flow`)

Same as dine-in but skips party size and table assignment. Token number assigned from `get_next_token_number()`. Customer receives token notification. Manager receives alert when order is ready to collect.

On flow start, `cache_restaurant_pricing()` loads `restaurants.parcel_charge_per_item` into session. Cart summary and checkout use `compute_order_totals()` (see **Takeaway & delivery order pricing** below).

#### Delivery Flow (`handle_delivery_flow`)

| Step | Action |
|---|---|
| `awaiting_address` | Send `send_location_request()` — WhatsApp native location share button |
| `awaiting_order` | Cart interaction (same as dine-in) |
| `awaiting_special_notes` | Same notes flow |
| `visit_complete` | Confirm order; notify kitchen; assign rider (manual via manager command) |

Same parcel/GST pricing as takeaway, plus a flat **delivery charge** (default ₹40). Legacy text-order path in `item_preferences.py` uses the same `order_pricing` module.

#### Takeaway & delivery order pricing (`chat/tools/order_pricing.py`)

Owner-configurable **parcel / packaging charge** applies only to `takeaway` and `delivery` — not dine-in.

| Step | Formula |
|---|---|
| Items subtotal | Sum of `qty × unit_price` per cart line |
| Parcel charge | `Σ (qty × parcel_charge_per_item)` per line |
| Delivery charge | Flat fee (default ₹40) — delivery only |
| Pre-GST total | items + parcel + delivery |
| GST | 5% on pre-GST total |
| Grand total | pre-GST + GST |

**Example** (parcel ₹10/item): 2× Dosa + 3× Idly → parcel = ₹50 (2×10 + 3×10). GST is calculated on items + parcel (+ delivery if applicable).

**Where applied:** `takeaway_flow.py`, `delivery_flow.py`, `cart_tools.py` (cart summary), `generate_receipt.py` (receipt line item), `item_preferences.py` (legacy interactive-list flow).

**Owner setting:** `restaurants.parcel_charge_per_item` — configured in SettingsPanel Kitchen tab; persisted via `PUT /api/restaurants/me`.

#### Special dish of the day (customer-facing)

Managers mark items with `is_special_today = true` in ManagerPortal (see Section 9). This flag is **not** pushed to the Meta WhatsApp catalog.

After the menu or catalog is sent, `send_special_dishes_note()` in `booking_mechanisms.py` sends a friendly WhatsApp suggestion, e.g.:

> 🌟 *Today's specials:* Rava Idly, Kanchipuram Idly  
> Ask us to add any of these while you order — we'd love to serve you! 😊

All `is_special_today` flags reset daily at ~00:00 IST via `resetDailySpecialDishes()` in the Node slot scheduler.

#### Order ready-time messaging (takeaway & delivery)

Owners configure optional soft ETA ranges in Settings; managers toggle **Busy kitchen** during rush hour.

| Setting | Configured by | Stored in |
|---|---|---|
| `takeaway_ready_range` | Owner (Settings → Kitchen) | `restaurants` — e.g. `"20-30"` |
| `delivery_ready_range` | Owner (Settings → Kitchen) | `restaurants` — e.g. `"30-45"` |
| `kitchen_busy` | Manager (Manager Portal) | `restaurants` boolean |

**Customer messages** (`chat/tools/order_timing.py`), appended to order confirmations only — not at address capture, not in Meta catalog:

| Condition | Message |
|---|---|
| Range set, kitchen normal | `⏱ Usually ready/delivered in {range} mins. We'll WhatsApp you when it's ready.` |
| Range set, kitchen busy | `⏱ Normally it takes {range} mins, but due to high volumes there could be some delay in preparing your food. We'll WhatsApp you when it's ready.` |
| No range, kitchen busy | `⏱ Kitchen is busy — please allow a little extra time preparing your order. We'll WhatsApp you when it's ready.` |
| No range, kitchen normal | *(no timing line)* |

`cache_restaurant_pricing()` loads ranges + `kitchen_busy` into session; refreshed again at checkout so busy toggle mid-order is respected.

**API:** `POST /api/catalog/kitchen-busy-toggle` — body `{ "busy": true|false }` (manager/owner).  
`GET /api/catalog/kitchen-status` includes `kitchen_busy`, `takeaway_ready_range`, `delivery_ready_range`.

**Migration:** `migrations/add_kitchen_ready_ranges.sql`

#### Reservation Flow (`handle_reserve_table_flow`)

| Step | Action |
|---|---|
| `awaiting_flow_datetime` | Send Meta Flow widget for date/time picker (Flow ID: `meta_flow_reservation_id`) |
| `awaiting_party_size` | Ask party size |
| `awaiting_advance_confirmation` | If `payment_mode = "prepay"`: send Razorpay payment link; await confirmation |
| `visit_complete` | Booking created in `bookings` table with `service_type = "reserve_table"` |

### Cart Tools (`cart_tools.py`)

**Interactive message types used:**

| Function | WA Message Type | Purpose |
|---|---|---|
| `send_category_list()` | Interactive list | Category selection (`CAT:{name}` IDs) |
| `send_item_list()` | Interactive list | Item selection within category (`ITEM:{id}` IDs) |
| `send_cart_summary_buttons()` | Interactive buttons | `CART:CONFIRM`, `CART:ADD_MORE`, `CART:CLEAR` |
| `send_quantity_buttons()` | Interactive buttons | `QTY:1`, `QTY:2`, `QTY:3`, `QTY:OTHER` |
| `send_done_or_more_buttons()` | Interactive buttons | `CART:DONE`, `CART:ADD_MORE` |

**Cart structure (session_state['cart']):**
```json
{
  "items": [
    { "id": "uuid", "name": "Ghee Roast", "qty": 2, "price": 180.0, "retailer_id": "GHR001" }
  ]
}
```

**Slot-aware filtering:** `cart_tools` calls `applySlotAvailability` logic — items whose `time_slot` does not match the current IST slot (morning/lunch/evening/dinner/all) are excluded from the menu list.

### Manager WhatsApp Commands (`commands_agent.py`)

Any message from `restaurant.manager_phone` bypasses the booking flow and enters command parsing.

| Command | Function | Description |
|---|---|---|
| `today` | `cmd_today()` | List today's bookings |
| `tomorrow` | `cmd_tomorrow()` | List tomorrow's bookings |
| `confirm {N}` | `cmd_confirm()` | Confirm booking token N |
| `reject {N} {reason}` | `cmd_reject()` | Reject booking N |
| `find {name/phone}` | `cmd_find()` | Search customer bookings |
| `block {date} {slot}` | `cmd_block()` | Block a reservation slot |
| `noshow {N}` | `cmd_noshow()` | Mark booking as no-show |
| `tables` | `cmd_tables()` | Show current table status |
| `free {table#}` | `cmd_free()` | Free a table manually |
| `extend {table#} {mins}` | `cmd_extend()` | Extend table occupancy timer |
| `orders` | `cmd_orders()` | Active orders summary |
| `ready {order#}` | `cmd_ready()` | Mark order ready for collection |
| `unpaid {phone} {amount}` | `cmd_unpaid()` | Record unpaid balance |
| `block {phone}` | `cmd_block_customer()` | Block a customer from ordering |

### Database Tables (Conversation State)

**`conversation_states`**
```sql
id              uuid PK
restaurant_id   uuid FK→restaurants
customer_phone  varchar NOT NULL
adk_session_id  varchar NOT NULL
current_state   varchar NOT NULL   -- 'idle' | 'booking' | 'visit_complete'
context         jsonb              -- full session_state dict
updated_at      timestamptz
```

**`customers`**
```sql
id                    uuid PK
restaurant_id         uuid FK→restaurants
phone                 varchar NOT NULL
name                  varchar NOT NULL
whatsapp_profile_name varchar
last_visit_date       varchar
visit_count           integer DEFAULT 0
opted_in_marketing    boolean DEFAULT true
created_at            timestamptz
```

**`bookings`**
```sql
id                    uuid PK
restaurant_id         uuid FK→restaurants
customer_id           uuid FK→customers
service_type          enum: dine_in|takeaway|delivery|reserve_table
table_number          integer
party_size            integer
delivery_address      varchar
booking_datetime      timestamptz
status                enum: pending|confirmed|seated|completed|cancelled|no_show
token_number          varchar
token_advance         numeric          -- advance amount requested
payment_status        enum: pending|paid|partial
razorpay_order_id     varchar
table_confirmed_at    timestamptz
menu_prompt_sent      boolean
reminder_24h_sent     boolean
reminder_1h_sent      boolean
feedback_requested    boolean
advance_paid          numeric DEFAULT 0
advance_applied       boolean DEFAULT false
reservation_booking_id uuid FK→bookings (self-ref for advance linking)
created_at            timestamptz
```

---

## 6. Walk-in Token System

### Overview
Walk-in customers arrive at the restaurant and are issued a token via a tablet/POS running the Walk-in Form. They receive a WhatsApp notification at each stage. The Manager Portal shows a live queue.

### Frontend (`WalkInForm.jsx`, `ManagerPortal.jsx` Queue tab)
- **WalkInForm:** Name, phone, type (dine-in/takeaway/large party), pax. Submits `POST /api/tokens`.
- **ManagerPortal Queue tab:** Live list of `walk_in_tokens` with status. Manager assigns tables, approves large parties, marks completions.

### API Endpoints (`src/routes/tokens.js`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/tokens` | Public | Issue new token; sends WA notification to customer |
| `GET` | `/api/tokens` | `authenticateToken` | List tokens for restaurant (today) |
| `GET` | `/api/tokens/:id` | Public | Get single token status |
| `PUT` | `/api/tokens/:id/assign` | `authenticateToken` | Assign table; notify customer |
| `PUT` | `/api/tokens/:id/approve` | `authenticateToken` | Approve large party request |
| `PUT` | `/api/tokens/:id/reject` | `authenticateToken` | Reject request with reason |
| `PUT` | `/api/tokens/:id/complete` | `authenticateToken` | Mark visit complete; queue feedback |
| `DELETE` | `/api/tokens/:id` | `authenticateToken` | Remove token from queue |
| `PUT` | `/api/tokens/:id/approve-scheduled` | Manager WA / API | Approve `scheduled_takeaway` while `pending_approval` |
| `PUT` | `/api/tokens/:id/reject-scheduled` | Manager WA / API | Reject scheduled takeaway request |

### Monotonic portal token IDs (`T-001`, `T-002`, …)

Token numbers are **never reused** once allocated, even if payment fails or the booking is cancelled.

| Mechanism | Location |
|---|---|
| `restaurants.portal_token_seq` | Integer counter per outlet |
| `allocate_portal_token_seq(restaurant_id)` | Supabase RPC — atomic `UPDATE … RETURNING` |
| `generateTokenId()` | `src/routes/tokens.js` — calls RPC, falls back to legacy `MAX(T-xxx)+1` |
| `_next_portal_token_id()` | `chat/tools/db_tools.py` — same RPC from Python |

**Migration:** `migrations/add_portal_token_sequence.sql` — seeds counter from existing `walk_in_tokens.id` values.

### Scheduled portal token types

| `type` | Flow | KDS bucket |
|---|---|---|
| `scheduled_takeaway` | Customer picks future slot → manager approves → Razorpay prepay → `walk_in_tokens` + `bookings` | KDS **Future** tab until `kitchen_start_at` |
| `scheduled_delivery` | Same + delivery address / transit time in `schedule_meta` | KDS **Future** tab; kitchen starts earlier than takeaway (transit included) |

Token `meta` stores `booking_id`, `order_text`, `cart`, `scheduled_at`, and schedule fields when `bookings.schedule_meta` is empty.

### Token States
```
waiting → (seated | takeaway | pending_approval) → completed
                     ↓
              pending_approval → seated (manager approves)
                              → (rejected)
scheduled_* → pending_approval → (paid booking confirmed) → completed
```

### WhatsApp Notifications Sent
| Event | Message |
|---|---|
| Token issued (dine-in) | "🎟 Token #{N} — you're #{position} in queue. We'll WhatsApp you when your table is ready." |
| Table assigned | "✅ Your table #{table} is ready! Please proceed to the host. Token #{N}." |
| Large party (pending) | "⏳ Your party request is with the manager. We'll confirm shortly." |
| Approved | "✅ Your party has been approved! Table #{N} is being arranged." |
| Rejected | "Sorry, we're unable to accommodate your party right now. {reason}" |

### Database Table (`walk_in_tokens`)
```sql
id              text PK           -- human-readable token e.g. "T-042"
restaurant_id   uuid NOT NULL
name            text NOT NULL
phone           text
type            enum: dinein|takeaway|large_party|scheduled_takeaway|scheduled_delivery
pax             integer DEFAULT 1
status          enum: waiting|seated|takeaway|completed|pending_approval
table_id        uuid FK→tables
table_number    integer
arrived_at      timestamptz DEFAULT now()
seated_at       timestamptz
completed_at    timestamptz
reservation_date text             -- for advance reservations bridged to walk-in
reservation_time text
meta            jsonb DEFAULT '{}'
```

---

## 7. Table Management & KDS

### Table Management

**Database (`tables`)**
```sql
id            uuid PK
restaurant_id uuid NOT NULL
table_number  integer NOT NULL
section       text
capacity      integer DEFAULT 4
is_active     boolean DEFAULT true
status        enum: available|free|occupied|waiting|reserved|dirty
created_at    timestamptz
updated_at    timestamptz
```

**API Endpoints (`src/routes/pos.js`)**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/tables` | List all tables for restaurant |
| `PUT` | `/api/tables/:id/status` | Update table status |
| `POST` | `/api/tables` | Create new table |
| `PUT` | `/api/tables/:id` | Edit table (number, capacity, section) |
| `DELETE` | `/api/tables/:id` | Soft-delete table |

**Frontend:** SettingsPanel `TabTables` — CRUD grid. ManagerPortal `Tables` tab — live status with colour coding (green=available, orange=occupied, red=dirty).

### Kitchen Display System (KDS)

**Overview:** Real-time display of active orders for kitchen staff. Items grouped by KOT ticket. Staff mark items in-progress → ready → served. **Scheduled** prepaid takeaway/delivery appear in a separate **Future** tab until kitchen start time.

**Scheduled orders API (`GET /api/kds/scheduled`, `pos.js`)**

Returns future `bookings` where `service_type ∈ {takeaway, delivery}`, slot is >1 hour away, and payment is `paid` or `pending`. Buckets per order:

| Bucket | Condition |
|---|---|
| `future` | `kitchen_start_at` more than 4 h away |
| `todays_future` | Start within 4 h, not yet sent to live KDS |
| `present` | Start time passed, not yet `kds_sent_at` |
| `live` | `kds_sent_at` set — also on Live tab |

**Kitchen start calculation** (`chat/tools/kitchen_scheduler.py`, `estimateKitchenStartFromTotals()` in `src/helpers/kitchenScheduler.js`):

- **Takeaway:** `kitchen_start_at = slot − (cook + packing + buffer)`, rounded to the **nearest 30 minutes** (IST).
- **Delivery:** `kitchen_start_at = slot − (takeaway lead + transit)`, rounded to the **nearest 15 minutes** (IST). Delivery always starts earlier than takeaway for the same slot.

`schedule_rounding_minutes` on `restaurants` overrides the takeaway boundary (default **30**). Delivery boundary is fixed at **15**.

Enrichment: if `bookings.schedule_meta` lacks `order_text`, API backfills from matching `walk_in_tokens.meta` (`scheduled_takeaway` / `scheduled_delivery`).

**Booking schedule columns** (Python ORM + `bookings` table):

```sql
kitchen_start_at      timestamptz
scheduled_slot_at     timestamptz
total_cook_minutes    integer
total_packing_minutes integer
schedule_meta         jsonb DEFAULT '{}'
kds_sent_at           timestamptz
kds_alert_sent        boolean
```

**Database (`kds_items`)**
```sql
id                uuid PK
restaurant_id     uuid NOT NULL
order_item_id     uuid FK→order_items
kot_ticket_id     uuid FK→kot_tickets
status            enum: pending|in_progress|ready|served|cancelled
time_in_queue_seconds integer DEFAULT 0
priority          enum: low|normal|high|urgent
item_name         text
token_number      text
customer_phone    text
service_type      text
item_category     text DEFAULT ''
special_instructions text
created_at        timestamptz
updated_at        timestamptz
```

**Database (`kot_tickets`)**
```sql
id            uuid PK
restaurant_id uuid NOT NULL
order_id      uuid FK→orders
ticket_number text NOT NULL
status        enum: pending|in_progress|ready|served
priority      enum: low|normal|high|urgent
assigned_to   uuid FK→employees
created_at    timestamptz
completed_at  timestamptz        -- was incorrectly queried as "served_at" (now fixed)
updated_at    timestamptz
```

**API Endpoints**

| Method | Path | File | Description |
|---|---|---|---|
| `GET` | `/api/kds/feed` | pos.js | Fetch active KDS items for restaurant |
| `GET` | `/api/kds/scheduled` | pos.js | Future/present scheduled takeaway & delivery for KDS Future tab |
| `PUT` | `/api/kds/:id/status` | pos.js | Update item status (pending→in_progress→ready→served) |
| `POST` | `/api/kds/notify` | kds.js | Internal: create KDS items from new order |

**KDS notify payload** (called from Python booking agent after order confirmed):
```json
{
  "restaurant_id": "uuid",
  "order_id": "uuid",
  "items": [
    { "order_item_id": "uuid", "item_name": "Ghee Roast", "qty": 2,
      "special_instructions": "less spicy", "category": "Starters" }
  ],
  "token_number": "T-042",
  "customer_phone": "+919876543210",
  "service_type": "dine_in"
}
```

**Frontend (`KDSScreen.jsx`)**
- Tabs: **Live orders**, **Future** (scheduled prepaid), **History**.
- Subscribes to Supabase Realtime on `kds_items` table for restaurant.
- Plays audio beep on new items (Web Audio API).
- Columns: Pending → In Progress → Ready → Served.
- Future cards show token, items, **Start time**, **Slot time**, cook estimate; delivery starts earlier than takeaway for same slot.
- KOT print: `KOTPrint.jsx` triggers browser print dialog with styled KOT ticket HTML.
- Auto-refresh every 30 seconds as fallback.

---

## 8. POS Order Management

### Overview
Staff create and manage orders from the ManagerPortal `Orders` tab. Orders may also originate from WhatsApp (source = `whatsapp`) or delivery aggregators (source = `delivery`).

### Database (`orders`)
```sql
id                uuid PK
restaurant_id     uuid NOT NULL
table_id          uuid FK→tables
order_number      text NOT NULL      -- e.g. "ORD-0042"
status            enum: pending|confirmed|in_progress|ready|completed|cancelled
payment_status    enum: unpaid|paid|partial
total_amount      numeric DEFAULT 0
subtotal          numeric DEFAULT 0
tax               numeric DEFAULT 0
discount          numeric DEFAULT 0
notes             text
source            text DEFAULT 'pos'  -- 'pos'|'whatsapp'|'delivery'
customer_phone    text
delivery_partner  text
rider_name        text
rider_phone       text
tracking_url      text
delivery_charge   numeric DEFAULT 0
takeaway_status   text DEFAULT 'pending'
collected_at      timestamptz
collected_by      text
created_by        uuid FK→employees
created_at        timestamptz
updated_at        timestamptz
```

**Database (`order_items`)**
```sql
id                   uuid PK
order_id             uuid FK→orders
menu_item_id         uuid FK→menu_items
quantity             integer NOT NULL DEFAULT 1
unit_price           numeric NOT NULL
special_instructions text
status               enum: pending|in_progress|ready|served|cancelled
booking_id           uuid FK→bookings  -- links WA order to booking record
created_at           timestamptz
updated_at           timestamptz
```

**Database (`payments`)**
```sql
id             uuid PK
restaurant_id  uuid NOT NULL
order_id       uuid FK→orders
amount         numeric NOT NULL
payment_method enum: cash|card|upi|wallet
status         enum: pending|completed|failed|refunded
transaction_id text
processed_by   uuid FK→employees
created_at     timestamptz
```

### API Endpoints (`src/routes/pos.js`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/orders` | List orders (filtered by status, date) |
| `GET` | `/api/orders/:id` | Single order with items |
| `POST` | `/api/orders` | Create order with items; triggers KDS |
| `PUT` | `/api/orders/:id/status` | Update order status; broadcasts WS event |
| `POST` | `/api/orders/:id/complete` | Mark completed; generate invoice; send receipt |
| `DELETE` | `/api/orders/:id` | Cancel and soft-delete |
| `POST` | `/api/payments` | Record payment for order |
| `GET` | `/api/reports/sales` | Daily/weekly sales summary |

**Frontend (`ManagerPortal.jsx` — Orders tab)**
- New order form: select table → add items from menu → confirm.
- Status update buttons per order row.
- Payment modal (cash / UPI / card).
- Orders auto-refresh via WebSocket `ORDER_NEW` / `ORDER_UPDATED` events.

---

## 9. Menu Management & Catalog Sync

### Overview
Menu items are stored in `menu_items`. Each item has a `time_slot` field for scheduling visibility. The Meta Catalog is kept in sync so customers ordering via WhatsApp see the same menu. Owners can also upload menus via Excel.

Managers can toggle **availability** (syncs to Meta catalog) and **special dish of the day** (WhatsApp suggestion only). Owners configure **parcel/packaging charge per item** for takeaway and delivery orders.

### Database (`menu_items`)
```sql
id                  uuid PK
restaurant_id       uuid FK→restaurants
name                text NOT NULL
description         text
category            text
price               numeric NOT NULL
image_url           text
is_available        boolean DEFAULT true
is_stocked          boolean DEFAULT true
is_special_today    boolean DEFAULT false  -- manager-marked daily special; NOT in Meta catalog
prep_time_minutes   integer DEFAULT 15
meta_product_id     text           -- Meta Catalog product ID
retailer_id         text           -- unique retailer SKU
last_synced_at      timestamptz
time_slot           text DEFAULT 'all'  -- all|morning|lunch|evening|dinner
fulfillment_section text DEFAULT 'main' -- multi-counter: which section handles this item
brand_override      jsonb          -- per-outlet overrides on brand menu item
created_at          timestamptz
updated_at          timestamptz
```

**Index:** `idx_menu_items_special_today` — partial index on `restaurant_id` where `is_special_today = true`.

### Parcel charge (`restaurants`)
```sql
parcel_charge_per_item  numeric(8,2) NOT NULL DEFAULT 0
-- Extra ₹ per cart line qty for takeaway/delivery, added before GST. 0 = disabled.
```
**Migration:** `migrations/add_catalog_parcel_and_specials.sql`

### Time Slot Schedule (IST)
| Slot | Window |
|---|---|
| `morning` | 06:00 – 11:00 |
| `lunch` | 11:00 – 15:00 |
| `evening` | 15:00 – 19:00 |
| `dinner` | 19:00 – 23:00 |
| `all` | Always visible |

### API Endpoints (`src/routes/catalog.js`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/menu-items` | `authenticateToken` | List items for restaurant (optionally `?ignore_slot=true`) |
| `POST` | `/api/menu-items` | `authenticateToken` | Create single item |
| `PUT` | `/api/menu-items/:id/availability` | `authenticateToken` | Toggle `is_stocked` + `is_available`; push to Meta Catalog (see below) |
| `PUT` | `/api/menu-items/:id/special-today` | `authenticateToken` | Toggle `is_special_today`; **no** Meta catalog push |
| `POST` | `/api/catalog/kitchen-busy-toggle` | `authenticateToken` | Manager rush flag `kitchen_busy` on restaurant |
| `POST` | `/api/catalog/sync` | `authenticateToken` | Pull catalog from Meta; upsert to `menu_items` |
| `POST` | `/api/catalog/slot-sync` | `authenticateToken` | Manual slot override for restaurant |
| `POST` | `/api/catalog/menu-upload` | `authenticateToken` | Excel upload → parse → upsert → push to Meta |
| `GET` | `/api/catalog/feed` | Public | CSV feed for Meta Catalog ingestion |
| `POST` | `/api/catalog/webhook` | Public (HMAC verified) | Meta Catalog event webhook |

**`applySlotAvailability(restaurant_id, slot)`:** Sets `is_available = false` for items whose `time_slot` does not match `slot`, and `is_available = true` for those that do. Runs every minute via slot scheduler.

**`applySlotForAllRestaurants()`:** Iterates all active restaurants and calls `applySlotAvailability` for each.

### Availability toggle → Meta Catalog sync

`PUT /api/menu-items/:id/availability` is the **authoritative** availability endpoint (supersedes any legacy route in `pos.js`).

**Flow:**
1. Updates `menu_items.is_stocked` and `menu_items.is_available` in Supabase.
2. Responds immediately to the dashboard (does not block on Meta).
3. If the item has a `retailer_id` and Meta credentials (`META_ACCESS_TOKEN`, catalog ID) are configured, fire-and-forget `pushSingleItemToMetaCatalog()` calls Meta Batch API `UPDATE` with `availability: 'in stock' | 'out of stock'`.

**Requirements for Meta sync:** Item must have `retailer_id`; restaurant must have valid WABA/Meta integration. If either is missing, DB toggle still succeeds but catalog is unchanged.

**Log signature:** `[meta-single-push] ✅ {retailerId} → in stock|out of stock`

### Special dish of the day (manager toggle)

`PUT /api/menu-items/:id/special-today`  
Body: `{ "is_special_today": true | false }`  
Roles: `owner`, `manager`, `brand_owner`

- Updates `menu_items.is_special_today` only.
- Writes `audit_logs` entry.
- **Does not** call `pushSingleItemToMetaCatalog()` — specials are surfaced via WhatsApp ordering suggestion only (Section 5).
- `GET /api/menu-items` and Python `fetch_menu_items()` include `is_special_today` in responses.
- `resetDailySpecialDishes()` clears all `is_special_today = true` rows once per calendar day (~00:00–00:02 IST) in the Node slot rotation job.

### Takeaway fulfillment (`add_takeaway_fulfillment.sql`)
```sql
restaurants.takeaway_fulfillment_mode  text DEFAULT 'single_counter'  -- single_counter|multi_counter
restaurants.fulfillment_sections     jsonb  -- e.g. ["main","beverages","desserts"]
menu_items.fulfillment_section         text DEFAULT 'main'
```
**Captain Portal** (`CaptainPortal.jsx`): scans takeaway QR via `POST /api/v1/takeaway/scan`; multi-counter mode routes items to fulfillment sections.

### Brand Menu (`brand_menu_items`)
```sql
id           uuid PK
brand_id     uuid FK→brands
name         text NOT NULL
description  text
category     text
base_price   numeric NOT NULL
image_url    text
time_slot    text DEFAULT 'all'
is_active    boolean DEFAULT true
sort_order   integer DEFAULT 0
```
Brand menu items can be pushed to all outlets under a brand via `POST /api/brands/:id/menu/push`.

### Frontend

**`MenuPage.jsx` (owner)**
- Tabs: Items list / Sync from Meta / Upload Excel.
- Toggle availability per item (sends `PUT /api/menu-items/:id/availability`).
- Time slot badge per item.

**`ManagerPortal.jsx` — Menu tab**
- **Availability** toggle per item → `PUT /api/menu-items/:id/availability` (syncs Meta catalog when `retailer_id` present).
- **Special today** toggle per item → `PUT /api/menu-items/:id/special-today` (WhatsApp suggestion only).
- **Mark busy** button → `POST /api/catalog/kitchen-busy-toggle` (rush-hour delay note on confirmations).
- Kitchen open/closed status from `GET /api/catalog/kitchen-status`.
- Excel template download / upload via `POST /api/catalog/menu-upload`.

**`SettingsPanel.jsx` — Kitchen tab**
- **Parcel / packaging charge (₹ per item)** → `PUT /api/restaurants/me` (`parcel_charge_per_item`). Common values: 10, 15, 20; 0 disables.
- **Takeaway ready time / Delivery time** ranges → `PUT /api/restaurants/me` (`takeaway_ready_range`, `delivery_ready_range`). e.g. `20-30`.
- Assign items to fulfillment sections (calls `PUT /api/menu-items/bulk-section` — **route not yet implemented**).

---

## 10. Table Reservations

### Overview
Customers book tables in advance via WhatsApp. The Meta Flow widget collects date/time. If the restaurant is in `prepay` mode, a Razorpay payment link is sent before confirming.

### `payment_mode` on `restaurants`
| Value | Behaviour |
|---|---|
| `prepay` | Advance payment required before booking is confirmed |
| `postpay` | No advance; booking confirmed immediately |

### Booking Flow (Python)

1. Customer selects "Reserve Table" from service menu.
2. Bot sends Meta Flow (reservation widget) for date/time selection.
3. Customer submits flow → bot receives `FLOW:date|time|pax` payload.
4. Availability check: `check_availability(restaurant_id, date, slot)` — queries `bookings` table for conflicts.
5. If `prepay`: generate Razorpay order → send payment link → poll `awaiting_advance_confirmation`.
6. On payment confirmation: `create_booking()` with `payment_status = "paid"`, `advance_paid = amount`.
7. If `postpay`: `create_booking()` immediately.
8. Automated reminders: `reminder_24h_sent`, `reminder_1h_sent` flags on bookings table — scheduler fires WhatsApp reminders.

### Advance Payment Columns (`bookings`)
```sql
advance_paid          numeric DEFAULT 0    -- amount received
advance_applied       boolean DEFAULT false -- applied at billing
reservation_booking_id uuid FK→bookings    -- links walk-in token back to advance booking
```

### API (`src/routes/tokens.js` → `PUT /:id/assign`)
When a reserved customer arrives and is assigned a table, the walk-in token is linked to the original booking via `reservation_booking_id`, and `advance_applied` is set to `true` so the cashier sees the credit at billing.

---

## 11. Feedback System

### Overview
Two hours after a visit ends, the customer receives a single WhatsApp feedback invite. The system is **owned by Node.js** — not the Python scheduler (Python `send_feedback_requests` is a TODO stub).

**Triggers that queue feedback** (`queueFeedbackForTable()` in `src/helpers/feedback.js`):
- `PUT /api/tokens/:id/complete` — manager marks visit done
- Auto-release scheduler — seated token > 90 min
- `PUT /api/tables/:id/status` → `available` — table freed via POS
- `POST /api/payments` — POS checkout
- `POST /api/feedback/queue` — Python agents (takeaway/delivery/dine-in completion) via `KDS_SECRET`

### Queue rules
- One open row per `restaurant_id + customer_phone` (DB unique partial index `feedback_pending_one_open_per_customer`)
- 24-hour cooldown: no re-queue or re-send if invite already sent within 24 h
- Duplicate queue calls from multiple visit-end events (token-complete + auto-release + table-status) are deduplicated

### API (`src/routes/feedback.js`)
```
POST /api/feedback/queue
Auth: Bearer <AUTOM8_KDS_SECRET>  OR  Bearer <Supabase JWT>
Body: { restaurant_id, customer_phone, customer_name, token_number, table_id, source }
```

### Node feedback scheduler (`startFeedbackScheduler()` — every 10 min, runs once on startup)
1. Query `feedback_pending` where `feedback_sent = false` and `freed_at ≤ now() − 2 hours`
2. Group by customer — one send per `restaurant + phone` per tick
3. Acquire 15-min send lease (`feedback_sent_at`) to prevent multi-instance double-send
4. Send WhatsApp interactive list (rating 1–5) via `sendFeedbackInvite()`; fall back to plain text
5. Mark `feedback_sent = true` **only after** confirmed WhatsApp delivery
6. Close all duplicate open rows for same customer without messaging
7. 24-hour send cooldown prevents repeat invites

**Log signatures:** `📣 Feedback scheduler started … 24h dedup`, `✅ Sent to {phone}`, `Skipped … invite already sent within cooldown`

### Multi-step reply flow (Node `feedbackFlow.js`)
When customer replies to a sent invite, Node webhook routes to `handleFeedbackReply()` **before** Python chat:

| Step | State | Customer action |
|---|---|---|
| 1 | `feedback_rating == null` | Tap rating list or reply 1–5 |
| 2 | Aspects not yet captured | Reply numbered aspects or Skip |
| 3 | Comment not yet captured | Free-text comment or Skip |
| Done | `manager_notified = true` | Thank-you message; manager alert on low ratings |

Auto-replies during feedback flow are ignored (not prompted with "Please tap a rating").

### Python feedback session flow (legacy / parallel path)
`chat/agents/customer/feedback_flow.py` handles `awaiting_feedback_rating` → `awaiting_feedback_aspects` → `awaiting_feedback_comment` when customer is in an active feedback session in `conversation_states`. Production post-visit invites are sent by Node scheduler.

### Database (`feedback_pending`)
```sql
id                   uuid PK
restaurant_id        uuid NOT NULL
customer_phone       text NOT NULL
customer_name        text
token_number         text              -- walk_in_tokens.id
table_number         text
freed_at             timestamptz NOT NULL
feedback_sent        boolean DEFAULT false
feedback_sent_at     timestamptz       -- send lease + sent timestamp
feedback_text        text              -- JSON aspects payload or comment
feedback_rating      integer           -- 1–5
feedback_received_at timestamptz
manager_notified     boolean DEFAULT false
updated_at           timestamptz       -- required by set_updated_at() trigger
created_at           timestamptz
```

**Migration:** `migrations/add_feedback_dedup_index.sql` — adds `updated_at`, dedupes existing open rows, creates unique partial index.

---

## 12. Referral System

### Overview
Customers who complete an order are prompted to share a referral link. Referees receive a discount on first order; referrers receive a reward credit.

### API (`src/routes/referrals.js`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/referrals/validate` | Validate a referral code at checkout; apply referee discount |
| `POST` | `/api/referrals/generate` | Generate or retrieve referral code for a customer phone |

### Database

**`referral_codes`**
```sql
id              uuid PK
restaurant_id   uuid NOT NULL
owner_phone     text NOT NULL
code            text NOT NULL
referee_discount text DEFAULT '₹50'
referrer_reward  text DEFAULT '₹30'
max_uses        integer
use_count       integer DEFAULT 0
expires_at      timestamptz
is_active       boolean DEFAULT true
created_at      timestamptz
```

**`referral_uses`**
```sql
id                uuid PK
restaurant_id     uuid NOT NULL
referral_code_id  uuid FK→referral_codes
referrer_phone    text NOT NULL
referee_phone     text NOT NULL
referee_discount  text
referrer_reward   text
status            enum: pending|rewarded|expired DEFAULT 'pending'
applied_at        timestamptz
rewarded_at       timestamptz
```

### Python Integration
`generateReferralSharePrompt()` in `waHandlers.js` is called after `order_completed`. Sends a WhatsApp message with the referral share link. The first-order guard prevents a phone number from applying multiple referral codes.

---

## 13. Delivery Management

### Overview
Delivery orders originate via WhatsApp (customer shares location). The restaurant assigns a rider manually. The customer receives a dispatch notification.

### API (`src/routes/delivery.js`)
```
POST /api/delivery/rider-assigned
Body: { order_id, rider_name, rider_phone, tracking_url }
Auth: Internal (called from manager dashboard or command)
```
Updates `orders` with rider details; sends WhatsApp dispatch notification to customer: "Your order is on the way! Rider: {name}, Contact: {phone}".

### Python: Location Capture
`send_location_request(phone, restaurant_id)` sends a WhatsApp native location-request message. The customer's response (`message.type == "location"`) is parsed in `_process_meta_payload` and stored in session context as `delivery_lat`, `delivery_lng`, `delivery_address`.

### Order totals (WhatsApp delivery)
Delivery orders placed via WhatsApp use `compute_order_totals()` (`chat/tools/order_pricing.py`):

```
grand_total = (items_subtotal + parcel_charge + delivery_charge) × 1.05   -- 5% GST
```

Default delivery charge: ₹40 (`DEFAULT_DELIVERY_CHARGE`). Parcel charge comes from `restaurants.parcel_charge_per_item` (owner setting). Breakdown shown in cart summary, confirmation message, and receipt image.

### Database (`orders` delivery columns)
```sql
delivery_partner     text     -- 'swiggy'|'zomato'|'own'
rider_name           text
rider_phone          text
tracking_url         text
delivery_assigned_at timestamptz
delivery_charge      numeric DEFAULT 0
```

---

## 14. Marketing & CRM

### Overview
Marketing Dashboard provides segmented broadcast messaging, **scheduled campaigns**, **automations**, WhatsApp template management, template drafts, AI-assisted copy (Groq), and **48-hour ROI attribution**.

**Scheduler:** Node `startMarketingScheduler()` — every 5 min — runs `dispatchScheduledCampaigns()` + `runMarketingAutomations()`.

### API (`src/routes/marketing.js` — also mounted at `/api/restaurants`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/marketing/subscribers` | Opted-in customers with visit/spend stats |
| `GET` | `/api/marketing/templates` | Approved WhatsApp templates from Meta |
| `POST` | `/api/marketing/templates/create` | Submit new template to Meta for approval |
| `GET` | `/api/marketing/template-drafts` | List saved template drafts |
| `POST` | `/api/marketing/template-drafts` | Save/update template draft |
| `DELETE` | `/api/marketing/template-drafts/:id` | Delete draft |
| `POST` | `/api/marketing/media/upload` | Upload media for template header |
| `POST` | `/api/marketing/broadcast` | Send now **or** schedule (`scheduled_at` ISO timestamp) |
| `GET` | `/api/marketing/campaigns` | Campaign history with ROI fields |
| `GET` | `/api/marketing/automations` | List marketing automations |
| `POST` | `/api/marketing/automations` | Create/update automation (trigger + segment + template) |
| `POST` | `/api/marketing/ai-suggest` | Generate campaign copy (Groq) |
| `POST` | `/api/marketing/ai-rewrite` | Rewrite existing copy (Groq) |
| `POST` | `/api/marketing/ai-generate` | Full template generation from brief (Groq) |
| `GET` | `/api/marketing/restaurants/:id/waba` | WABA status for restaurant |

### Broadcast segments (`SEGMENT_KEYS` in `marketingCampaign.js`)

| Segment Key | Definition |
|---|---|
| `all` | All customers with phone on file |
| `recent` | Last activity ≤ 7 days |
| `lapsed` | Last activity 14–30 days ago |
| `takeaway` | ≥ 3 takeaway visits |
| `high_value` | Total spend ≥ ₹500 |
| `never_returned` | Exactly 1 visit, last activity > 7 days ago |

Customer map built from `walk_in_tokens` + `orders` (not Python RFM alone).

### Marketing automations (`marketing_automations` table)

| Trigger | Fires when |
|---|---|
| `lapsed_14d` | Customer last active 14–16 days ago |
| `loyalty_5th_order` | ≥ 5 orders and active within 3 days |
| `first_order` | Exactly 1 order, first activity within 3 days |

- Evaluated every 5 min by Node marketing scheduler
- 24-hour per-automation cooldown (`last_run_at`)
- Respects `is_active` toggle from dashboard

### Scheduled campaigns
- `broadcast_campaigns.scheduled_at` set on `POST /broadcast` when `scheduled_at` provided
- Status `scheduled` until `dispatchScheduledCampaigns()` fires at or past `scheduled_at`
- UI: MarketingDashboard compose tab — "Send now" vs schedule picker

### Campaign ROI (48-hour attribution)
After send, `computeCampaignRoi()` matches `recipient_phones` against `orders` in the following 48 hours:
- `roi_orders_48h` — order count attributed
- `roi_revenue_48h` — revenue attributed
- Shown in campaign history cards in MarketingDashboard

### Database

**`broadcast_campaigns`** (extended)
```sql
id               uuid PK
restaurant_id    uuid NOT NULL
name             text NOT NULL
segment_type     text NOT NULL
template_name    text
custom_message   text              -- freeform when no template
recipient_count  integer DEFAULT 0
sent_count       integer DEFAULT 0
failed_count     integer DEFAULT 0
status           text DEFAULT 'draft'  -- draft|scheduled|sending|completed|failed
scheduled_at     timestamptz
sent_at          timestamptz
recipient_phones jsonb             -- [{phone,name}] for ROI attribution
roi_orders_48h   integer DEFAULT 0
roi_revenue_48h  numeric(12,2) DEFAULT 0
created_by       uuid
created_at       timestamptz
```

**`marketing_template_drafts`**
```sql
id              uuid PK
restaurant_id   uuid NOT NULL
name            text NOT NULL
payload         jsonb NOT NULL    -- template compose state
created_by      uuid
created_at      timestamptz
updated_at      timestamptz
```

**`marketing_automations`**
```sql
id              uuid PK
restaurant_id   uuid NOT NULL
name            text NOT NULL
trigger_type    text NOT NULL     -- lapsed_14d|loyalty_5th_order|first_order
segment_type    text NOT NULL
template_name   text
custom_message  text
is_active       boolean DEFAULT true
last_run_at     timestamptz
created_by      uuid
created_at      timestamptz
updated_at      timestamptz
```

**Migration:** `migrations/add_marketing_features.sql`

### Frontend (`MarketingDashboard.jsx`)
- **Compose tab:** segment picker, template or custom message, `{{name}}` variable preview, schedule picker, send now
- **History tab:** campaign list with sent/failed counts, ROI cards, clone/resend actions
- **Templates tab:** Meta templates, drafts, category tooltips, char counter, AI rewrite/generate
- **Automations tab:** create/toggle automations by trigger type
- AI buttons call Groq-powered `/ai-suggest`, `/ai-rewrite`, `/ai-generate`

### Python RFM segments (identity/personalisation — separate from marketing segments)
Used in `identity_agent.py` greetings via `customer_profiles.rfm_segment`:

| Segment | Definition |
|---|---|
| `champion` | High recency + frequency + spend |
| `loyal` | High frequency, moderate recency |
| `at_risk` | Previously frequent; last visit > 30 days |
| `new_customer` | visit_count < 2 |

---

## 15. Staff Management

### API (`src/routes/staff.js`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/staff` | List employees for restaurant |
| `POST` | `/api/staff` | Create employee (sends Supabase Auth invite) |
| `PUT` | `/api/staff/:id` | Update role, phone, name |
| `PUT` | `/api/staff/:id/terminate` | Terminate employee; set `terminated_at` |
| `POST` | `/api/staff/:id/send-password-reset` | Trigger password reset email for staff |
| `GET` | `/api/staff/roles` | List available roles for this restaurant's plan |

### Database (`employees`)
```sql
id               uuid PK (= Supabase auth.users.id)
restaurant_id    uuid FK→restaurants
brand_id         uuid FK→brands
email            text UNIQUE NOT NULL
full_name        text NOT NULL
phone            text
whatsapp_number  text
role             enum: brand_owner|brand_manager|owner|manager
                       |kitchen_staff|captain|waiter|marketing
is_active        boolean DEFAULT true
hired_at         timestamptz DEFAULT now()
terminated_at    timestamptz
termination_note text
last_login       timestamp
created_at       timestamp
```

### Frontend (SettingsPanel `TabStaff`)
- Employee grid with role badge.
- Invite form: email + role → `POST /api/staff` → Supabase Auth invite email sent.
- Terminate button with confirmation modal.

---

## 16. Subscription & Feature Gating

### Backend (`src/routes/subscription.js`)
```
GET /api/subscription
Auth: authenticateToken + getRestaurantId
Returns: { plan, features: [...], trial_ends_at, renews_at, status }
```
Reads from `restaurant_subscriptions` and `restaurants.subscribed_features`.

### Feature Keys
```
dine_in | takeaway | delivery | reserve_table | token_management
kds | analytics | marketing | whatsapp_ordering | catalog_sync | reporting
```

### Python Feature Gate (`tools/feature_gate.py`)
```python
get_features(restaurant_id)      # → list[str], cached 5 min per restaurant
has_feature(features, name)      # → bool
require_feature(restaurant_id, name)  # → raises denial if missing
build_service_menu_rows(restaurant_id)  # → WA list rows for enabled services only
denial_message(feature)          # → human-readable WhatsApp message
invalidate(restaurant_id)        # → clears cache after settings change
```

### React Feature Gate (`SubscriptionContext.jsx`)
```jsx
const { hasFeature, hasAnyOf, hasAllOf, loading } = useSubscription();
// FeatureWall is rendered automatically when a route's feature is not enabled
```

**`FeatureWall.jsx`** — shown for: `token_management`, `dine_in`, `takeaway`, `delivery`, `reserve_table`. Owners see an "upgrade" CTA; non-owners see "ask your owner" message.

### Database (`restaurant_subscriptions`)
```sql
id              uuid PK
restaurant_id   uuid UNIQUE FK→restaurants
billing_cycle   enum: monthly|annual DEFAULT 'monthly'
base_price      numeric NOT NULL DEFAULT 0
discount_pct    numeric NOT NULL DEFAULT 0
final_price     numeric NOT NULL DEFAULT 0
last_meta_cost  numeric DEFAULT 0
last_razorpay_cost numeric DEFAULT 0
last_billed_month varchar
status          enum: trial|active|past_due|cancelled DEFAULT 'trial'
trial_ends_at   timestamptz
renews_at       timestamptz
billing_scope   enum: outlet|brand DEFAULT 'outlet'
brand_id        uuid FK→brands
created_at      timestamptz
updated_at      timestamptz
```

---

## 17. Brand & Chain Management

### Overview
Multi-outlet restaurant groups operate under a `brands` record. Brand staff (`brand_owner`, `brand_manager`) can manage all outlets, push menus, and view consolidated analytics.

### Database (`brands`)
```sql
id                uuid PK
name              text NOT NULL
legal_name        text
logo_url          text
waba_id           text UNIQUE    -- shared WABA for all outlets
meta_business_id  text
contact_email     text UNIQUE NOT NULL
contact_phone     text
plan              enum: standalone|chain|enterprise DEFAULT 'chain'
max_outlets       integer DEFAULT 10
is_active         boolean DEFAULT true
created_at        timestamptz
updated_at        timestamptz
```

### API (`src/routes/brands.js`)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/brands` | Create brand (during onboarding) |
| `GET` | `/api/brands/:id` | Get brand details |
| `PUT` | `/api/brands/:id` | Update brand settings |
| `GET` | `/api/brands/:id/outlets` | List all outlets under brand |
| `POST` | `/api/brands/:id/outlets` | Add outlet to brand |
| `PUT` | `/api/brands/:id/outlets/:oid` | Update outlet settings |
| `DELETE` | `/api/brands/:id/outlets/:oid` | Remove outlet from brand |
| `GET` | `/api/brands/:id/dashboard` | Consolidated revenue + orders across all outlets |
| `POST` | `/api/brands/:id/menu/push` | Push brand menu to selected outlets |
| `POST` | `/api/brands/:id/campaigns/send` | Send broadcast campaign across all outlets |

### Frontend (`BrandDashboard.jsx`)
- Brand KPI cards: total revenue, total orders, occupancy rate across all outlets.
- Outlet drill-down: click outlet → `OutletDrillDown` component showing that outlet's metrics.
- Menu push: select brand menu items → push to outlets.
- Campaign broadcast: send to all-outlet customer base.

---

## 18. Restaurant Settings

### SettingsPanel (`SettingsPanel.jsx`)
Seven tabs; visible tabs depend on role:

| Tab | Roles | API Calls |
|---|---|---|
| **Tables** | owner, manager | `GET/POST/PUT/DELETE /api/tables` |
| **Restaurant** | owner | `GET/PUT /api/restaurants/me` |
| **Services** | owner | `GET/PUT /api/restaurants/me` (services config) |
| **Kitchen** | owner, manager | `GET /api/menu-items`, `PUT /api/restaurants/me` (`parcel_charge_per_item`), `PUT /api/menu-items/bulk-section` (⚠️ not yet implemented) |
| **WhatsApp** | owner | `GET/PUT /api/restaurants/integration` |
| **Staff** | owner | `GET/POST/PUT /api/staff` |
| **Brand** | brand_owner | `GET/PUT /api/brands/:id` |

### Restaurant Fields (key settings)
```sql
restaurants:
  dining_duration_minutes  integer DEFAULT 90   -- auto-release timer
  payment_mode             text DEFAULT 'prepay' -- prepay|postpay
  timezone                 text DEFAULT 'Asia/Kolkata'
  manager_phone            text    -- WhatsApp manager commands target
  waba_id                  text    -- WhatsApp Business Account ID
  whatsapp_number          text    -- display number for customers
  gstin                    varchar -- for invoice GST
  parcel_charge_per_item   numeric DEFAULT 0  -- ₹ per cart qty for takeaway/delivery packaging
  takeaway_ready_range     text               -- optional e.g. 20-30 (soft ETA, takeaway)
  delivery_ready_range     text               -- optional e.g. 30-45 (soft ETA, delivery)
  kitchen_busy             boolean DEFAULT false  -- manager rush toggle
  opening_hours            jsonb   -- e.g. {"mon": "09:00-23:00", ...}
  cuisine_type             varchar
  subscribed_features      text[]  -- feature gate array
```

### WABA Status (`WABAStatus` component in OwnerDashboard)
Calls `GET /api/dashboard/waba` → shows Meta App Review status, phone number verification, WABA health indicators.

---

## 19. Receipt & Invoice Generation

### QR Receipt Flow (Node.js + Python)

1. `POST /api/orders/:id/complete` in pos.js triggers `buildInvoicePayload(order)`.
2. Invoice payload stored in `invoices` table with `accounting_sync_status = "PENDING_DAILY_ROLLUP_ZOHO_TALLY"`.
3. Python `_upload_and_send_receipt()` in booking_agent:
   - Generates receipt image via Pillow/qrcode.
   - For takeaway/delivery: includes **Parcel / packaging** line when `parcel_charge > 0`; GST base = items + parcel + delivery.
   - Uploads to Supabase Storage `Receipts` bucket.
   - Stores token `→` object name mapping.
   - Sends WhatsApp message with receipt image + stable QR URL.

### Receipt Endpoints (`src/routes/receipts.js`)
```
GET /verify/:orderId   — HTML receipt page (human-readable, browser render)
GET /r/:token          — Stable redirect target for QR code
                         → generates fresh Supabase Storage signed URL → 302 redirect
```

The `/r/:token` endpoint in Python `main.py` also handles the redirect (duplicate, Python version searches Storage by prefix).

### GST Engine (Node.js `src/routes/invoices.js`)

**`calculateGST(subtotal, gstRate)`:**
```
tax    = subtotal × gstRate / 100
CGST   = tax / 2      (intra-state)
SGST   = tax / 2
total  = subtotal + tax
```
Default GST rate: 5% (restaurants). Stored in `invoices.gst_rate`.

**Invoice Payload Structure:**
```json
{
  "invoice_number": "INV-20260611-0042",
  "restaurant": { "name": "...", "gstin": "...", "address": "..." },
  "customer": { "name": "...", "phone": "..." },
  "items": [
    { "name": "Ghee Roast", "qty": 2, "unit_price": 180, "total": 360 }
  ],
  "subtotal": 360,
  "gst_rate": 5,
  "cgst": 9,
  "sgst": 9,
  "grand_total": 378,
  "payment_method": "upi",
  "generated_at": "2026-06-11T18:30:00Z"
}
```

### Database (`invoices`)
```sql
id                      uuid PK
restaurant_id           uuid NOT NULL
order_id                uuid NOT NULL
payload                 jsonb NOT NULL    -- full invoice JSON above
gst_rate                numeric DEFAULT 5.0
grand_total             numeric
accounting_sync_status  text DEFAULT 'PENDING_DAILY_ROLLUP_ZOHO_TALLY'
                        -- values: PENDING_DAILY_ROLLUP_ZOHO_TALLY | SYNCED | SYNC_FAILED
generated_at            timestamptz
synced_at               timestamptz
```

### Accounting Sync
`startAccountingSyncScheduler()` fires at 23:30 IST. Calls `pushInvoiceToAccounting(invoice)` in `invoices.js`. **Currently a stub** — exits early unless `ZOHO_CLIENT_ID` env var is set. On completion sends manager WhatsApp with sync summary.

---

## 20. Registration & Onboarding

### FAQ page (`autom8.works/faqs/`)

Static FAQ content in repo root: **`faq-munafe.html`**.

**WordPress embed:** Paste only the `<div id="munafe-faq-embed">…</div>` block into a Custom HTML widget on the FAQs page. Do **not** include the in-file nav — the Astra theme header already provides site navigation. Styles are scoped under `#munafe-faq-embed` with `!important` button resets so Astra/WP theme button colours do not override accordion questions.

Sections: Getting Started, WhatsApp & Meta, Ordering & Menu, Kitchen & Operations (includes scheduled KDS Future tab), Tables & Reservations, Multi-Outlet, Pricing, Meta Ban & Compliance.

### Registration Form (`autom8.works/register/`)
5-step React form embedded in WordPress via Vite build (`src-register/RegistrationForm.jsx`).

**API base:** reads `document.getElementById('munafe-register-form').dataset.api`, falls back to `https://autom8-backend-production.up.railway.app` (Railway legacy URL — WordPress page must set `data-api="https://api.autom8.works"` for production routing).

**Steps:**
1. Business name + outlet type.
2. Contact details (phone, email, city).
3. Logo upload.
4. WhatsApp Business number + WABA ID.
5. Confirm + submit.

### API (`src/routes/onboarding.js`)
```
POST /api/onboarding/register
Body: { name, email, phone, city, logo_url, waba_id, whatsapp_number, features }
```
Creates: `brands` record (if chain) or standalone `restaurants` record + initial `owner` employee + `restaurant_subscriptions` (status: `trial`).

**Slug availability check:**
```
GET /api/v1/slug-check/:slug   — returns { available: bool }
```

---

## 21. Owner Dashboard

### Overview
`OwnerDashboard.jsx` — primary view for the `owner` role. Combines API queries (Node.js), direct Supabase realtime subscriptions, and the **`OwnerInsights`** analytics panel.

### KPI Cards
| Metric | Source | Query |
|---|---|---|
| Today's Revenue | Direct Supabase | `orders` where `payment_status = "paid"`, `created_at >= today` |
| Table Occupancy | Direct Supabase | `tables` count occupied vs total |
| Active KOT Tickets | Direct Supabase | `kot_tickets` where `status IN ("pending","in_progress")` |
| Avg Dining Time | Direct Supabase | `kot_tickets` — `completed_at - created_at` average |
| WA Orders | `GET /api/dashboard/wa-orders` | Orders with `source = "whatsapp"` today |
| Cancellation Rate | `GET /api/dashboard/cancel-stats` | Session abort analytics from `conversation_events` |

### Owner Insights (`OwnerInsights.jsx` + `GET /api/dashboard/insights`)
Returns analytics pack from `src/helpers/dashboardAnalytics.js`:

| Panel | Data |
|---|---|
| Revenue heatmap | Orders by hour-of-day × day-of-week |
| Service split | Dine-in vs takeaway vs delivery revenue share |
| Repeat visit trend | Weekly returning customer rate |
| Customer segments | Visit frequency buckets |
| Stock outages | Items with `is_stocked = false` recently |
| Combo patterns | Frequently co-ordered item pairs |
| Menu quadrant (BCG) | Items classified: `star`, `hidden_gem`, `filler`, `dead_weight` |

### Dashboard API (`src/routes/dashboard.js`)
| Method | Path | Description |
|---|---|---|
| `GET` | `/api/dashboard/waba` | Restaurant + WABA config |
| `GET` | `/api/dashboard/wa-orders` | Walk-in token orders by date range |
| `GET` | `/api/dashboard/cancel-stats` | Conversation abort analytics |
| `GET` | `/api/dashboard/insights` | Owner analytics pack (above) |

### WABA Health Strip (`WABAStatus` component)
Calls `GET /api/dashboard/waba` → shows phone number verification status, WABA tier, messaging limits.

### WhatsApp Orders Panel
Calls `GET /api/dashboard/wa-orders` → lists recent WhatsApp-sourced orders.

### Realtime Subscriptions
OwnerDashboard subscribes to Supabase Realtime on `orders`, `kot_tickets`, `tables`.

### Frontend routes (role gating — `App.jsx`)
| Route | Roles |
|---|---|
| `/dashboard/owner` | `owner` |
| `/dashboard/brand` | `brand_owner`, `brand_manager` |
| `/dashboard/brand/outlet/:outletId` | `brand_owner`, `brand_manager` (scoped OwnerDashboard) |
| `/dashboard/marketing` | `marketing`, `owner`, `brand_owner`, `brand_manager` |
| `/dashboard/manager` | `manager`, `owner` |
| `/dashboard/kitchen` | `kitchen_staff`, `owner`, `manager`, `waiter` |
| `/dashboard/captain` | `captain`, `owner`, `manager` |
| `/forgot-password`, `/reset-password` | Public |

---

## 22. Background Schedulers

### Node schedulers (authoritative — `src/schedulers/index.js`)

Started once via `startAllSchedulers()` at server boot (`server.js`).

| Job | Interval | Owner | What it does |
|---|---|---|---|
| **Slot auto-release** | 5 min | Node | Completes `walk_in_tokens` seated > 90 min; frees `tables`; queues feedback; completes stale `orders` |
| **Slot rotation** | 1 min | Node | `getCurrentSlotIST()` → `applySlotForAllRestaurants()` menu availability; ~00:00 IST → `resetDailySpecialDishes()` |
| **Special notes timeout** | 60 s | Node | Auto-confirms `conversation_states` at `awaiting_special_notes` > 2 min; KDS fallback notify; manager alert |
| **Feedback scheduler** | 10 min | Node | Sends post-visit WhatsApp invites from `feedback_pending` (2 hr delay, 24 hr dedup, send lease) |
| **Accounting sync** | Daily 23:30 IST | Node | Pushes `invoices` with `PENDING_DAILY_ROLLUP_ZOHO_TALLY` to Zoho Books |
| **Marketing scheduler** | 5 min | Node | `dispatchScheduledCampaigns()` + `runMarketingAutomations()` |

**Feedback scheduler details:** Runs immediately on startup + every 10 min. Exactly one invite per customer per 24 h even with multiple API instances. See Section 11.

**Marketing scheduler details:** Dispatches campaigns where `status = scheduled` and `scheduled_at ≤ now`. Runs automations with 24 h cooldown per rule.

### Python APScheduler (`chat/tools/scheduler_tools.py`)

Started on FastAPI lifespan. **Many jobs are TODO stubs** — do not document as production-active.

| Job | Schedule | Status |
|---|---|---|
| `send_reservation_reminders` | Hourly | **Active** — 24 h / 1 h reserve reminders |
| `send_delayed_menu_prompts` | Every minute | **Active** — menu prompt 3 min after table confirm |
| `cleanup_expired_receipts` | Daily 03:00 | **Active** |
| `detect_no_shows` | Every 15 min | **Stub/TODO** |
| `manage_table_auto_release` | Every 5 min | **Stub/TODO** — Node owns real auto-release |
| `send_daily_summary` | Daily 22:00 | **Stub/TODO** |
| `send_feedback_requests` | Every 30 min | **Stub/TODO** — Node owns feedback |
| `send_missed_you_messages` | Daily 11:00 | **Stub/TODO** |
| `update_customer_profiles` | Daily 02:00 | **Stub/TODO** |
| `calculate_customer_segments` | Daily 03:00 | **Stub/TODO** |
| `dispatch_scheduled_campaigns` | Every 2 hr | **Stub/TODO** — Node owns campaigns |
| `track_campaign_conversions` | Every 4 hr | **Stub/TODO** |

**Catalog sync (separate):** Daily 05:55 AM IST + startup-once — `chat/tools/catalog_tools.py`

### Scheduler ownership rule (for chatbot)
> If asked "who sends feedback / marketing / auto-release?": **Node.js schedulers**. Python scheduler stubs log success but perform no action for those jobs.

---

## 23. Real-time WebSocket Events

### Connection
`WebSocketContext.jsx` connects to `wss://api.autom8.works/ws?restaurant_id={id}`.
Server: `src/websocket.js` — `broadcastToRestaurant(restaurant_id, event)`.

### Events

| Event | Trigger | Payload |
|---|---|---|
| `CONNECTED` | WebSocket client joins | `{ restaurant_id }` |
| `ORDER_NEW` | New order created (POS or WhatsApp) | `{ order_id, order_number, table_id, source }` |
| `ORDER_UPDATED` | Order status change | `{ order_id, status }` |
| `ORDER_READY` | Order marked ready | `{ order_id }` |
| `TOKEN_NEW` | New walk-in token issued | `{ token_id, name, type, pax }` |
| `TOKEN_ASSIGNED` | Table assigned to token | `{ token_id, table_id, table_number }` |
| `TOKEN_APPROVED` | Large party approved | `{ token_id }` |
| `TOKEN_REJECTED` | Large party rejected | `{ token_id, reason }` |
| `TOKEN_COMPLETED` | Visit completed | `{ token_id }` |
| `KDS_ITEM_UPDATED` | Kitchen item status change | `{ kds_item_id, status, order_id }` |
| `TABLE_STATUS` | Table status changed | `{ table_id, status }` |

---

## 24. Upcoming: Item Preferences & Personalisation

### Status: In development — `chat/tools/item_preferences.py`

### Feature A: Dietary Filtering (Implemented)
`item_preferences.py` intercepts `_send_menu()` before category/item lists are sent to the customer. It filters out items that conflict with the customer's dietary flag stored in session context.

**Logic:**
- Session key `dietary_flag` set during identity/first order: `"veg"` or `"non_veg"`.
- If `dietary_flag == "veg"`: items whose names match `_MEAT_KEYWORDS` are excluded from the displayed list.
- If `dietary_flag == "non_veg"`: no exclusions (non-veg customers see the full menu).
- The filter runs on the menu items list *before* `send_category_list()` / `send_item_list()` is called.

**Key invariant:** The dietary filter in `item_preferences.py` and the notes hint logic in `booking_agent._build_notes_hint()` are independent. The filter prevents non-matching items from being *seen*; the notes hint runs *after* the cart is confirmed.

### Feature B: Contextual Condiment Suppression (Implemented)
`item_preferences.py` wraps the condiment/combo nudge logic. Before sending an upsell prompt (e.g., "Add raita with your biryani?"), the system checks:
- Does the cart already contain the suggested item?
- Does the cart context make the nudge relevant? (e.g., no raita nudge if the customer only ordered idli)
- Only one upsell nudge fires per order; no chained prompts.

### Feature C: Personalised Item Suggestions (Upcoming)

#### Data Source
`customer_profiles.favourite_items` (jsonb array, already in schema):
```json
[
  { "name": "Ghee Roast", "retailer_id": "GHR001", "count": 7 },
  { "name": "Filter Coffee", "retailer_id": "COF001", "count": 12 }
]
```

#### How `favourite_items` Gets Populated
Add to `personalisation_tools.update_customer_profile()` (runs after every completed booking):
```python
async def _calculate_favourite_items(customer_id, restaurant_id, session):
    result = await session.execute(
        select(MenuItem.name, MenuItem.retailer_id,
               func.sum(OrderItem.quantity).label("total_qty"))
        .join(OrderItem, OrderItem.menu_item_id == MenuItem.id)
        .join(Booking, OrderItem.booking_id == Booking.id)
        .where(Booking.customer_id == UUID(customer_id))
        .where(Booking.restaurant_id == UUID(restaurant_id))
        .where(Booking.status.in_(["confirmed", "completed"]))
        .group_by(MenuItem.name, MenuItem.retailer_id)
        .order_by(desc("total_qty"))
        .limit(10)
    )
    return [{"name": r.name, "retailer_id": r.retailer_id, "count": int(r.total_qty)}
            for r in result]
```
Note: `_calculate_favourite_items` already exists in `personalisation_tools.py` but must be confirmed to use the `order_items → bookings` join path (not just `orders`).

#### Touchpoint 1 — "Order Again?" at menu load (in `item_preferences._send_menu()`)
```python
async def _get_suggestions(customer_id, restaurant_id, dietary_flag):
    profile = await get_customer_profile(customer_id, restaurant_id)
    items = profile.get("favourite_items", [])[:3]
    # Apply dietary filter to suggestions
    if dietary_flag == "veg":
        items = [i for i in items if not any(k in i["name"].lower() for k in _MEAT_KEYWORDS)]
    return items
```
If suggestions exist, prepend to menu message:
```
🔁 *Order again?*
  • Ghee Roast (ordered 7 times)
  • Filter Coffee (ordered 12 times)

👇 Or browse today's full menu
```
Suggestions are rendered as part of the first interactive list section, not as separate messages.

#### Touchpoint 2 — Post-cart suggestion (in `handle_booking_completion()`)
After cart is confirmed, call `build_order_suggestion(customer_id, restaurant_id)` (already implemented in `personalisation_tools.py`):

| Customer state | Suggestion text |
|---|---|
| Has profile + favourite_items | "Shall we add your usual {top_item}?" |
| visit_count == 2 | "Last time you enjoyed {items}. Same again today?" |
| No profile | "Our most popular: {top 3 restaurant-wide items}" |
| No data | No suggestion sent |

One button: `[Yes, add it]` / `[No thanks]`. A single nudge per order maximum.

#### Critical constraint
Dietary filter must apply to both touchpoints. A customer with `dietary_flag = "veg"` must never see a non-veg item in suggestions even if they previously ordered it (e.g., dietary change).

#### No schema changes required
All required columns already exist: `customer_profiles.favourite_items` (jsonb), `customer_profiles.rfm_segment`, `order_items.booking_id`, `bookings.status`.

---

## 25. Proposed New Features

---

### 25.1 Loyalty Points & Wallet

**Description:** Customers accumulate points on every completed order. Points redeemable as wallet credit at checkout.

**DB changes:**
```sql
-- New table
CREATE TABLE loyalty_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  points_balance  integer NOT NULL DEFAULT 0,
  lifetime_points integer NOT NULL DEFAULT 0,
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(customer_id, restaurant_id)
);

CREATE TABLE loyalty_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL,
  customer_id     uuid NOT NULL REFERENCES customers(id),
  order_id        uuid REFERENCES orders(id),
  type            text NOT NULL CHECK (type IN ('earn','redeem','expire','adjust')),
  points          integer NOT NULL,    -- positive = earn, negative = redeem
  description     text,
  created_at      timestamptz DEFAULT now()
);

-- Add to restaurants table
ALTER TABLE restaurants ADD COLUMN points_per_rupee numeric DEFAULT 1.0;
ALTER TABLE restaurants ADD COLUMN redemption_rate  numeric DEFAULT 0.5; -- ₹0.50 per point
ALTER TABLE restaurants ADD COLUMN min_redeem_points integer DEFAULT 100;
```

**Backend:** New `src/routes/loyalty.js` mounted at `/api/loyalty`.
- `GET /api/loyalty/:customer_phone` — balance + history.
- `POST /api/loyalty/earn` — called from `POST /api/orders/:id/complete`; creates earn transaction.
- `POST /api/loyalty/redeem` — validate + apply at checkout; creates redeem transaction.

**Python agent:** After booking confirmed, show points earned: "You earned 36 points! Balance: 180 points (worth ₹90)." Before cart confirmation, if balance ≥ min_redeem: "You have ₹90 wallet credit. Apply? [Yes] [No]"

**Frontend:** SettingsPanel new tab `Loyalty` — configure earn rate, redemption rate, min redemption. OwnerDashboard new KPI: total points outstanding liability.

---

### 25.2 Table-side QR Ordering (Scan-to-Order)

**Description:** QR code on each table → customer scans → opens WhatsApp with pre-filled message that bootstraps the ordering session without phone number registration flow.

**How it works:**
1. Each table gets a unique QR code URL: `https://wa.me/{restaurant_wa_number}?text=TABLE:{table_number}`.
2. Python webhook: if incoming message body matches `TABLE:{N}`, extract `table_number` → inject into session state → skip party size step → proceed directly to cart.
3. No separate app or web page needed — entirely within WhatsApp.

**DB changes:** None — uses existing `walk_in_tokens` and `conversation_states`.

**Backend (Python booking_agent):**
```python
# In handle_booking_flow, after ask_service
if message.startswith("TABLE:"):
    table_number = int(message.split(":")[1])
    session_state["table_number"] = table_number
    session_state["service_type"] = "dine_in"
    session_state["booking_step"] = "awaiting_order"
    # Skip party size, issue token, go to cart
```

**Frontend:** SettingsPanel → Tables tab → add "Print QR" button per table row → generates PDF with styled QR code.

---

### 25.3 Split Bill

**Description:** Multiple customers at the same table each pay a share of the order. Manager initiates split from ManagerPortal; each customer gets their WhatsApp payment link.

**DB changes:**
```sql
CREATE TABLE bill_splits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id),
  restaurant_id   uuid NOT NULL,
  total_amount    numeric NOT NULL,
  split_count     integer NOT NULL,
  amount_per_head numeric NOT NULL,
  status          text DEFAULT 'pending' CHECK (status IN ('pending','partial','settled')),
  created_at      timestamptz DEFAULT now()
);

CREATE TABLE bill_split_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  split_id        uuid NOT NULL REFERENCES bill_splits(id),
  customer_phone  text NOT NULL,
  amount          numeric NOT NULL,
  razorpay_order_id text,
  status          text DEFAULT 'pending' CHECK (status IN ('pending','paid','failed')),
  paid_at         timestamptz
);
```

**Backend:** `POST /api/orders/:id/split` → creates `bill_splits` + individual `bill_split_payments` rows → sends Razorpay payment link to each customer via WhatsApp.

**Frontend:** ManagerPortal Orders tab → "Split Bill" button on completed order → modal: enter number of ways or assign amounts per customer phone.

---

### 25.4 Dynamic Pricing / Happy Hour

**Description:** Automatically adjust item prices or apply discounts during defined time windows (happy hour, off-peak).

**DB changes:**
```sql
CREATE TABLE pricing_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  name            text NOT NULL,           -- e.g. "Happy Hour"
  applies_to      text NOT NULL CHECK (applies_to IN ('all','category','item')),
  target_id       text,                    -- category name or menu_item.id
  discount_type   text CHECK (discount_type IN ('percent','flat')),
  discount_value  numeric NOT NULL,
  active_days     text[],                  -- ['mon','tue','wed','thu','fri']
  start_time      time NOT NULL,           -- '16:00'
  end_time        time NOT NULL,           -- '19:00'
  is_active       boolean DEFAULT true,
  created_at      timestamptz DEFAULT now()
);
```

**Backend:** Add to `catalog.js` slot scheduler — before applying slot availability, check `pricing_rules` for the current time window, temporarily update `menu_items.price` for matching items. Revert at end of window.

**Python:** Cart price lookup uses `menu_items.price` at the time of the message — no change needed in cart_tools. Prices are already fetched per-request.

**Frontend:** SettingsPanel new tab `Pricing Rules` — create/edit rules with day/time selectors.

---

### 25.5 Google Reviews Automation

**Description:** After a customer gives a 4 or 5-star feedback rating, automatically send a Google Reviews deep link asking them to post publicly.

**No DB changes required.** Uses existing `feedback_pending.feedback_rating`.

**Backend change:** In Node `feedbackFlow.js` `completeFeedback()`, after rating is received:
```javascript
if (rating >= 4 && restaurant.google_maps_url) {
  await sendWhatsAppMessage(customer_phone,
    `⭐ Thank you for the great rating! Share on Google:\n${restaurant.google_maps_url}`,
    restaurant_id);
}
```

**DB change:** `restaurants` table already has `google_maps_url` column — just needs to be populated via SettingsPanel.

**Frontend:** SettingsPanel → Restaurant tab → add Google Maps URL field.

---

### 25.6 Inventory / Stock Management

**Description:** Track ingredient stock levels. Menu items auto-hide from the WhatsApp menu when stock runs out. Staff receive low-stock alerts.

**DB changes:**
```sql
CREATE TABLE inventory_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  name            text NOT NULL,
  unit            text NOT NULL,     -- 'kg'|'litre'|'piece'|'portion'
  current_stock   numeric NOT NULL DEFAULT 0,
  low_stock_threshold numeric DEFAULT 5,
  cost_per_unit   numeric DEFAULT 0,
  is_active       boolean DEFAULT true,
  updated_at      timestamptz DEFAULT now()
);

CREATE TABLE menu_item_ingredients (
  menu_item_id    uuid NOT NULL REFERENCES menu_items(id),
  inventory_item_id uuid NOT NULL REFERENCES inventory_items(id),
  quantity_per_portion numeric NOT NULL,
  PRIMARY KEY (menu_item_id, inventory_item_id)
);
```

**Backend:**
- `POST /api/inventory/deduct` — called from `POST /api/orders/:id/complete`; deducts quantities per order items sold.
- `GET /api/inventory` — list items with stock level.
- `PUT /api/inventory/:id` — update stock (after restocking).
- Auto-toggle `menu_items.is_stocked = false` when `current_stock ≤ 0`; this triggers `is_available = false` via existing slot logic.

**Python:** If `is_stocked = false`, item already excluded from menu via `is_available` filter.

**Frontend:** New `Inventory` page accessible from ManagerPortal. Table of ingredients with stock levels, low-stock alerts highlighted in red.

---

### 25.7 Multi-language WhatsApp Support

**Description:** Customers can interact with the bot in Tamil, Hindi, or English. Language detected from first message; subsequent replies in same language.

**How detection works:** First message language detected using a simple heuristic (Unicode range check: Tamil = U+0B80–U+0BFF, Devanagari = U+0900–U+097F). Falls back to English.

**DB changes:**
```sql
-- Add to customers table
ALTER TABLE customers ADD COLUMN preferred_language text DEFAULT 'en'
  CHECK (preferred_language IN ('en','ta','hi'));
```

**Python:** 
- `detect_language(text) → 'en'|'ta'|'hi'` utility function.
- Store in session_state `lang` and persist to `customers.preferred_language`.
- All WA message strings moved to a `messages/` dict:
```python
MESSAGES = {
  'en': { 'welcome': 'Welcome! ...', 'ask_name': 'What is your name?' },
  'ta': { 'welcome': 'வணக்கம்! ...', 'ask_name': 'உங்கள் பெயர் என்ன?' },
  'hi': { 'welcome': 'नमस्ते! ...', 'ask_name': 'आपका नाम क्या है?' },
}
```
- All `send_whatsapp_message()` calls use `MESSAGES[lang][key]` instead of hardcoded strings.

**Frontend:** SettingsPanel → Services tab — enable/disable supported languages per restaurant.

---

### 25.8 Waitlist for Fully-Booked Time Slots

**Description:** When a reservation slot is full, offer the customer a waitlist position. If a booking cancels, notify the first waitlisted customer.

**DB changes:**
```sql
CREATE TABLE reservation_waitlist (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  requested_date  text NOT NULL,
  requested_slot  text NOT NULL,
  party_size      integer NOT NULL,
  position        integer NOT NULL,
  status          text DEFAULT 'waiting' CHECK (status IN ('waiting','offered','confirmed','expired')),
  offered_at      timestamptz,
  expires_at      timestamptz,    -- customer has 30 min to accept offer
  created_at      timestamptz DEFAULT now()
);
```

**Python booking agent:** After `check_availability()` returns `False`:
- Offer waitlist: "This slot is full. Join the waitlist? You're currently #3."
- On booking cancellation (cmd_reject or status update), trigger `notify_waitlist_head()` — sends WhatsApp offer to first waiting customer with 30-minute accept window.

**Backend:** `GET /api/reservations/waitlist` — manager view of current waitlist per date/slot.

---

### 25.9 Advanced Analytics Dashboard

**Description:** Dedicated analytics page with cohort retention, item performance, peak hour heatmap, and customer lifetime value.

**No new DB tables required** — queries existing `orders`, `order_items`, `bookings`, `customers`, `customer_profiles`.

**Backend:** New `src/routes/analytics.js` mounted at `/api/analytics`.
- `GET /api/analytics/cohorts?month=2026-05` — weekly cohort retention table.
- `GET /api/analytics/items?period=30d` — top/bottom items by revenue and quantity.
- `GET /api/analytics/peak-hours` — order count by hour of day, day of week (heatmap data).
- `GET /api/analytics/clv` — average customer lifetime value by segment.
- `GET /api/analytics/repeat-rate?period=30d` — repeat visit percentage.

**Frontend:** New `AnalyticsDashboard.jsx` page (role: `owner`, `manager`). Charts via Recharts:
- Cohort table (7x4 grid).
- Item revenue bar chart.
- Peak hour heatmap (24×7 grid).
- CLV by RFM segment bar.

---

### 25.10 Automated Upsell Engine (WhatsApp)

**Description:** Smart upsell triggers during active ordering sessions, based on cart contents + restaurant-defined combos.

**Different from item_preferences.py condiment suppression:** This feature is restaurant-configurable (owner sets combos), not keyword-based.

**DB changes:**
```sql
CREATE TABLE upsell_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id),
  trigger_item_id uuid REFERENCES menu_items(id),   -- when this item is in cart
  suggest_item_id uuid REFERENCES menu_items(id),   -- suggest this item
  message_template text NOT NULL,                    -- "Add {name} for just ₹{price}?"
  priority        integer DEFAULT 0,
  is_active       boolean DEFAULT true
);
```

**Python:** In `handle_booking_completion()`, before sending order confirmation:
1. Scan cart for items matching `trigger_item_id`.
2. Fetch top-priority active upsell rule where `suggest_item_id` is not already in cart.
3. Send single WA button: "Add Masala Chai for just ₹40? [Yes] [No thanks]"
4. One upsell maximum per order session.

**Frontend:** SettingsPanel `TabKitchen` → Upsell Rules section — define trigger/suggest item pairs.

---

*End of Munafe Technical Specification v1.4*

---

**Document maintenance notes:**
- This document is the **source of truth for the technical support chatbot**. All API paths, state machine keys, DB column names, scheduler ownership, and agent function names should match production code.
- **Code repos:** `github.com/raviswa/autom8-backend` (Node + Python chat), `github.com/raviswa/autom8-frontend` (React SPA).
- **Production URLs:** API `api.autom8.works`, Chat `chat.autom8.works`, App `app.autom8.works`.
- When routes are added or modified, update the corresponding section's API table.
- When DB migrations run, update the schema blocks in the relevant section.

**Migrations in repo (`autom8-backend-main/migrations/`):**
| File | Purpose |
|---|---|
| `add_feedback_dedup_index.sql` | `feedback_pending.updated_at` + unique open-row index |
| `add_marketing_features.sql` | Scheduled campaigns, ROI, drafts, automations |
| `add_takeaway_fulfillment.sql` | `takeaway_fulfillment_mode`, `fulfillment_sections` |
| `add_restaurant_tenant_config.sql` | `meta_catalog_id` per restaurant |
| `add_restaurant_kitchen_settings.sql` | Kitchen workflow settings |
| `add_kot_printer_columns.sql` | KOT printer config columns |
| `add_scheduled_takeaway_engine.sql` | Scheduled takeaway/delivery bookings, KDS columns, portal token types |
| `add_scheduled_delivery_portal_and_kds.sql` | Scheduled delivery portal + KDS integration |
| `add_prepay_fulfillment_payload.sql` | Prepay webhook schedule persistence |
| `add_kds_alert_sent.sql` | KDS alert dedup flag on bookings |
| `add_walk_in_wait_estimate.sql` | Walk-in queue wait estimate |
| `add_portal_token_sequence.sql` | Monotonic `T-xxx` via `allocate_portal_token_seq` RPC |
| `fix_walk_in_tokens_scheduled_delivery_check.sql` | Constraint fix for scheduled delivery tokens |

**Known open items:**
- `PUT /api/menu-items/bulk-section` — SettingsPanel Kitchen tab references this; route may not be fully implemented
- Python APScheduler stubs (`send_feedback_requests`, `dispatch_scheduled_campaigns`, etc.) — Node owns these jobs; stubs log only
- Zoho sync requires `ZOHO_CLIENT_ID` + related credentials or exits early
- Dual data model: `bookings` (Python) vs `walk_in_tokens`/`orders` (Node POS) — both active

**v1.4 changelog (June 2026):**
- Scheduled takeaway & delivery engine: kitchen scheduler, transit time, KDS Future tab (`GET /api/kds/scheduled`)
- Monotonic portal token sequence (`allocate_portal_token_seq`, `add_portal_token_sequence.sql`)
- FAQ page embed docs (`faq-munafe.html` — no duplicate nav, WP theme isolation)
- Booking schedule columns: `kitchen_start_at`, `scheduled_slot_at`, `schedule_meta`, prepay recovery

**v1.1 changelog (June 2026):**
- Documented Node-first WhatsApp webhook ingress + Python proxy path
- Rewrote Feedback System (Node scheduler, dedup, multi-step reply flow)
- Expanded Marketing & CRM (scheduled campaigns, automations, ROI, drafts, Groq AI)
- Added auto-reply filtering (Node + Python synced patterns)
- Added password reset flows, Owner Insights dashboard
- Clarified scheduler ownership (Node vs Python stubs)
- Updated env vars, WebSocket events, frontend routes
