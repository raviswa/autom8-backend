from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):

    # Direct DB URL — reads DATABASE_URL env var automatically (pydantic field)
    database_url: str | None = None

    # Supabase — for REST API calls (customers, menu, tables)
    autom8_supabase_url: str | None = None
    autom8_supabase_service_key: str | None = None
    supabase_region: str = "ap-south-1"

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

    # PhonePe Standard Checkout (v2) — sandbox/UAT credentials from PhonePe
    # Business Dashboard → Developer Settings. Leave blank until you have them;
    # phonepe_configured() will report "keys_missing" and checkout falls back
    # to whatever PAYMENT_GATEWAY resolves to.
    phonepe_client_id: str | None       = None
    phonepe_client_secret: str | None   = None
    phonepe_client_version: int         = 1
    phonepe_env: str                    = "sandbox"   # "sandbox" | "production"
    phonepe_webhook_username: str | None = None
    phonepe_webhook_password: str | None = None

    # Which gateway powers the hosted /pay/{booking_id} checkout page.
    # "phonepe" (default) | "razorpay"
    payment_gateway: str               = "phonepe"

    chat_public_url: str              = "https://chat.autom8.works"
    log_level: str                   = "INFO"
    environment: str                 = "production"

    supply_waba_phone_number_id: str      = ''
    supply_waba_access_token:    str      = ''
    supply_waba_api_endpoint:    str      = 'https://graph.facebook.com/v19.0'
    supply_webhook_verify_token: str      = ''
    supply_webhook_secret:       str      = ''

    # Public order form (/s/:token) — must match Node SUPPLY_FORM_* env vars
    supply_form_signing_secret: str = ''
    supply_form_base_url: str = 'https://order.autom8.works'


settings = Settings()
