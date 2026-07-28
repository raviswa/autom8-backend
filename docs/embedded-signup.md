# WhatsApp Embedded Signup (Autom8)

Additive onboarding so clients connect WhatsApp inside the app without Meta for Developers.

## Meta App Dashboard checklist (App `981393887874957`)

1. Confirm Tech Provider / Solution Partner status is active.
2. **Facebook Login for Business** → create a **WhatsApp Embedded Signup** configuration → copy `config_id`.
3. If using a Partner Solution, copy `solution_id`.
4. **WhatsApp → Configuration**: keep existing webhook URL + verify token; subscribe `messages` and `account_update`.
5. Ensure the Settings page host uses valid SSL (required by Meta for Embedded Signup).
6. **Facebook Login → Settings → Allowed Domains for the JavaScript SDK** — **origin only** (no path/query/fragment). Meta rejects entries like `…/setup` with “JSSDK Host domain urls cannot contain any query, path or fragment information.” Domains must match the browser host **exactly** (e.g. `automb.works` does **not** cover `app.autom8.works`):
   - `https://app.autom8.works/` (owner portal) — **required**
   - `https://autom8.works/` and/or `https://www.autom8.works/` (registration hosts, if used)
   - Do **not** put `/setup` or any other path here
7. **App settings → Basic → App Domains**: `app.autom8.works`, `autom8.works` (no `https://` prefix here).
8. **Facebook Login for Business → Settings → Valid OAuth Redirect URIs** (paths **are** allowed here; Strict Mode is usually on). Put portal pages used as `fallback_redirect_uri` — a lone Railway webhook URI is **not** enough:
   - `https://app.autom8.works/`
   - `https://app.autom8.works/setup`
   - (optional) registration hosts if Embedded Signup runs there
   - Click **Save Changes** after edits (blue Save with no confirmation = settings not applied)
9. Set **Force Web OAuth reauthentication** to **No** for Embedded Signup (Yes often yields Meta’s blank “Sorry, something went wrong” popup).
10. Confirm `META_EMBEDDED_SIGNUP_CONFIG_ID` matches a **WhatsApp Embedded Signup** configuration under **Facebook Login for Business → Configurations**. If that row shows **“Some permissions have been restricted…”**, fix/re-approve those permissions (or switch Railway to a healthy config such as `Munafe_WhatsApp_Onboarding`) — restricted configs often yield Meta’s “Sorry, something went wrong” popup even when domains/redirects are correct.
11. **App settings → Basic**: Privacy Policy URL set; App Domains includes `app.autom8.works`.
12. After saving, wait 1–2 minutes, hard-refresh the portal (or try an Incognito window), and retry Connect WhatsApp. A CSP “inline script” warning inside Facebook’s own `dialog/oauth` console is usually unrelated noise.

## Backend environment variables

| Variable | Required | Purpose |
|---|---|---|
| `META_APP_ID` | Yes | `981393887874957` |
| `META_APP_SECRET` | Yes | App secret (server only) |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | Yes | Facebook Login for Business config ID |
| `META_EMBEDDED_SIGNUP_SOLUTION_ID` | If partner solution | Passed into `FB.login` extras |
| `META_GRAPH_VERSION` | No | Default `v21.0` |
| `WHATSAPP_REGISTER_PIN` | No | Fixed 6-digit Cloud API register PIN; else a random PIN is generated per tenant |

Existing webhook env (`META_WEBHOOK_VERIFY_TOKEN`) is unchanged.

## API

- `GET /api/whatsapp/embedded-signup/config` — public appId / configId / solutionId / graphVersion (no secrets). Returns `{ enabled: false }` if config ID is missing.
- `POST /api/whatsapp/embedded-signup/complete` — authenticated owner/settings; exchanges code, subscribes WABA, registers phone, writes `tenants` + `tenant_integrations`.

## Client flow

### Website registration (`autom8.works/register`)
1. Business details + owner login email/password.
2. Services.
3. **Connect WhatsApp** (Embedded Signup — no Meta Developer Console).
4. Optional menu upload.
5. Submit → account created, WhatsApp linked, redirect to app login.

### After login (Settings)
Owners can also use **Settings → WhatsApp → Connect WhatsApp** to reconnect or finish linking.

## Rebuild WordPress plugin bundle

```bash
cd autom8-frontend-main
npm run build:register
# copy dist-register/register.bundle.js → munafe-register-loader/assets/
```

