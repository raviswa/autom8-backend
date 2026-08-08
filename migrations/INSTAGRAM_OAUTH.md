# Instagram OAuth Connect (seller-facing)

Facebook Login for Business flow for Instagram Content Publishing.
**Separate from WhatsApp Embedded Signup** — ES cannot grant Instagram scopes.

## Meta Developer App setup

1. Add product **Facebook Login for Business** (or Facebook Login) to the Meta app that already has `META_APP_ID` / `META_APP_SECRET`.
2. Under **Valid OAuth Redirect URIs**, add exactly:
   ```
   https://api.autom8.works/api/instagram/oauth/callback
   ```
   (or your staging API host — must match the env var below).
3. Request / enable permissions used by the dialog:
   - `pages_show_list`
   - `pages_read_engagement`
   - `instagram_basic`
   - `instagram_content_publish`
   - `business_management`

## Server environment

| Variable | Purpose |
|----------|---------|
| `META_APP_ID` | Existing Meta app id |
| `META_APP_SECRET` | Existing Meta app secret (also used to HMAC-sign OAuth `state`) |
| `META_GRAPH_VERSION` | Optional, default `v21.0` |
| `META_INSTAGRAM_OAUTH_REDIRECT_URI` | Full callback URL registered in Meta (recommended explicit) |
| `API_PUBLIC_URL` | Fallback base if redirect URI unset → `{API_PUBLIC_URL}/api/instagram/oauth/callback` |
| `APP_FRONTEND_URL` | Where to send the seller after callback (default `https://app.autom8.works`) → `/settings?tab=business&ig_oauth=…` |

Example:

```bash
META_INSTAGRAM_OAUTH_REDIRECT_URI=https://api.autom8.works/api/instagram/oauth/callback
APP_FRONTEND_URL=https://app.autom8.works
API_PUBLIC_URL=https://api.autom8.works
```

## Routes

- `GET  /api/instagram/oauth/start` — auth + settings → `{ url }` (Meta Login is the verification; no WhatsApp step-up)
- `GET  /api/instagram/oauth/callback` — public Meta redirect
- `GET  /api/instagram/oauth/pending` — multi-Page pick list
- `POST /api/instagram/oauth/select-page` — finish pick `{ page_id }`

Manual paste / `POST /token/exchange` still requires step-up purpose `instagram_bind`.
Settings UI uses Connect Instagram only.
