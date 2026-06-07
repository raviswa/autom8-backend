from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):

    # ── Direct override (set in Railway) — takes priority over derived URL ───
    database_url: str | None = None

    # ── Supabase ──────────────────────────────────────────────────────────────
    autom8_supabase_url: str | None = None
    autom8_supabase_service_key: str | None = None
    supabase_region: str = "ap-southeast-1"   # override per region deployment

    def get_db_url(self) -> str:
        """Always call this instead of .database_url directly."""
        if self.database_url:
            return self.database_url
        if self.autom8_supabase_url and self.autom8_supabase_service_key:
            ref = (
                self.autom8_supabase_url
                .replace("https://", "")
                .replace(".supabase.co", "")
            )
            return (
                f"postgresql+asyncpg://postgres.{ref}:{self.autom8_supabase_service_key}"
                f"@aws-0-{self.supabase_region}.pooler.supabase.com:5432/postgres"
                f"?prepared_statement_cache_size=0"
            )
        raise ValueError(
            "No DB URL configured. Set DATABASE_URL or "
            "AUTOM8_SUPABASE_URL + AUTOM8_SUPABASE_SERVICE_KEY."
        )

    # ── Google AI ─────────────────────────────────────────────────────────────
    google_api_key: str = ""

    # ── WhatsApp ──────────────────────────────────────────────────────────────
    botbiz_api_endpoint: str         = "https://graph.facebook.com/v22.0"
    botbiz_phone_number_id: str      = ""
    botbiz_access_token: str         = ""
    botbiz_webhook_verify_token: str = ""
    webhook_secret: str              = ""
    whatsapp_phone_number: str       = ""

    # ── WhatsApp Flows ────────────────────────────────────────────────────────
    meta_flow_reservation_id: str    = "999260283048797"

    # ── Payments ──────────────────────────────────────────────────────────────
    razorpay_key_id: str | None      = None
    razorpay_key_secret: str | None  = None

    # ── App ───────────────────────────────────────────────────────────────────
    environment: str                 = "production"
    log_level: str                   = "INFO"

    # ── Business logic ────────────────────────────────────────────────────────
    name_confirm_days: int           = 90
    missed_you_days: int             = 45
    feedback_delay_hours: int        = 2
    auto_confirm_minutes: int        = 15

    # ── Legacy ────────────────────────────────────────────────────────────────
    supabase_api_key: str | None     = None

    class Config:
        env_file = ".env"
        case_sensitive = False


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
