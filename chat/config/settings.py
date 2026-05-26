"""Pydantic settings configuration."""

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    """Application configuration from environment variables."""

    # Database
    database_url: str = "postgresql://user:password@localhost:5432/munafe"

    # Google AI (ADK + Gemini)
    google_api_key: str = "your_gemini_api_key_here"

    # Supabase / PostgreSQL
    supabase_api_key: str | None = None

    # Autom8 Supabase — used by get_menu() to read slot-aware menu from the
    # authoritative DB (same one autom8-backend and the portal use).
    # Set these in Railway to avoid the need for a menu sync cron.
    autom8_supabase_url: str | None = None          # e.g. https://xyz.supabase.co
    autom8_supabase_service_key: str | None = None  # service_role key (not anon)

    # WhatsApp (BotBiz — Meta Cloud API)
    # Production sends use restaurant_integrations rows; these are local fallback values.
    botbiz_api_endpoint: str = "https://graph.facebook.com/v22.0"
    botbiz_phone_number_id: str = "your_phone_number_id_here"  # From Meta App dashboard
    botbiz_access_token: str = "your_access_token_here"        # Permanent or temp system token
    botbiz_webhook_verify_token: str = "your_verify_token_here"  # Used for GET /webhook/botbiz
    webhook_secret: str = "your_webhook_secret_here"
    whatsapp_phone_number: str = "919500996033"  # your registered number
    
    # WhatsApp Flows
    meta_flow_reservation_id: str = "999260283048797"  # Flow ID for table reservation date/time picker
    
    # Payments (Razorpay) - Optional for now
    razorpay_key_id: str | None = None
    razorpay_key_secret: str | None = None

    # App configuration
    environment: str = "dev"
    log_level: str = "INFO"

    # Business logic (days/hours)
    name_confirm_days: int = 90
    missed_you_days: int = 45
    feedback_delay_hours: int = 2
    auto_confirm_minutes: int = 15

    class Config:
        env_file = ".env"
        case_sensitive = False
    

@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


# Singleton instance
settings = get_settings()
