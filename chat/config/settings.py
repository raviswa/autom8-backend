"""
chat/config/settings.py

MIGRATION CHANGE:
  - Removed DATABASE_URL (pointed at old chat DB — now defunct)
  - Removed separate SUPABASE_API_KEY (was chat-DB-only anon key)
  - All DB access now goes through AUTOM8_SUPABASE_URL + AUTOM8_SUPABASE_SERVICE_KEY
    which point at the unified restaurant DB (same one autom8-backend uses)

Everything else is identical to the original settings.py.
"""

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application configuration from environment variables."""

    # ── Database ─────────────────────────────────────────────────────────────
    # DATABASE_URL removed — chat tables now live in the restaurant DB.
    # Use autom8_supabase_url + autom8_supabase_service_key for all DB access.

    # ── Unified Supabase (restaurant DB — single source of truth) ────────────
    # These are the SAME values used by autom8-backend (server.js).
    # In Railway, both the Node service and this Python service read from
    # the same SUPABASE_URL / AUTOM8_SUPABASE_SERVICE_KEY env vars.
    autom8_supabase_url: str                        # e.g. https://gedfgfwj....supabase.co
    autom8_supabase_service_key: str                # service_role key

    # Convenience alias — lets existing code that reads `settings.database_url`
    # keep working without a find-replace sweep. Points at the Supabase
    # pooler URL derived from autom8_supabase_url at startup.
    # Override by setting DATABASE_URL explicitly in Railway if needed.
    @property
    def database_url(self) -> str:
        # Convert https://XYZ.supabase.co → postgresql+asyncpg pooler URL
        ref = self.autom8_supabase_url.replace("https://", "").replace(".supabase.co", "")
        password = self.autom8_supabase_service_key  # service key doubles as DB password
        return (
            f"postgresql+asyncpg://postgres.{ref}:{password}"
            f"@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres"  # ← fix region
            f"?prepared_statement_cache_size=0"                          # ← add this
         )

    # ── Google AI (ADK + Gemini) ──────────────────────────────────────────────
    google_api_key: str

    # ── WhatsApp (BotBiz — Meta Cloud API) ───────────────────────────────────
    botbiz_api_endpoint: str          = "https://graph.facebook.com/v22.0"
    botbiz_phone_number_id: str       = ""
    botbiz_access_token: str          = ""
    botbiz_webhook_verify_token: str  = ""
    webhook_secret: str               = ""
    whatsapp_phone_number: str        = ""

    # ── WhatsApp Flows ────────────────────────────────────────────────────────
    meta_flow_reservation_id: str     = "999260283048797"

    # ── Payments (Razorpay) ───────────────────────────────────────────────────
    razorpay_key_id: str | None       = None
    razorpay_key_secret: str | None   = None

    # ── App configuration ─────────────────────────────────────────────────────
    environment: str                  = "dev"
    log_level: str                    = "INFO"

    # ── Business logic ────────────────────────────────────────────────────────
    name_confirm_days: int            = 90
    missed_you_days: int              = 45
    feedback_delay_hours: int         = 2
    auto_confirm_minutes: int         = 15

    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


# Singleton instance
settings = get_settings()
