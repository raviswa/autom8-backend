from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):

    # Direct DB URL — reads DATABASE_URL env var automatically (pydantic field)
    database_url: str | None = None

    # Supabase — for REST API calls (customers, menu, tables)
    autom8_supabase_url: str | None = None
    autom8_supabase_service_key: str | None = None
    supabase_region: str = "ap-southeast-1"

    def get_db_url(self) -> str:
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

    google_api_key: str = ""
    google_maps_api_key: str = ""

    botbiz_api_endpoint: str         = "https://graph.facebook.com/v22.0"
    botbiz_phone_number_id: str      = ""
    botbiz_access_token: str         = ""
    botbiz_webhook_verify_token: str = ""
    webhook_secret: str              = ""
    whatsapp_phone_number: str       = ""

    meta_flow_reservation_id: str    = "999260283048797"
    # Reuses the reservation date/time Flow when unset (same Meta Flow screen).
    meta_flow_delivery_schedule_id: str = ""
    meta_flow_takeaway_schedule_id: str = ""

    razorpay_key_id: str | None      = None
    razorpay_key_secret: str | None  = None
    razorpay_webhook_secret: str | None = None
    razorpay_callback_url: str | None = None
    chat_public_url: str              = "https://chat.autom8.works"
    log_level: str                   = "INFO"
    environment: str                 = "production"

settings = Settings()
