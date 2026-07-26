# Translation engine constraints for customer WhatsApp copy.
# Used as the source of truth when adding / refreshing locale files.
# Webcart UI chrome i18n is intentionally deferred (future build).

# ---------------------------------------------------------------------------
# STORAGE LANGUAGE POLICY (hard rule)
# ---------------------------------------------------------------------------
# Customer WhatsApp replies may be localized (hi/ta/te/…).
# Database + internal system records MUST stay English-equivalent:
#   - service_type codes: takeaway | delivery | dine_in | …
#   - order_text / cart line names: catalog / merchant source names (not translated)
#   - KDS / Manager / booking meta / prepay payload order fields: English labels
# preferred_language may be stored as a preference code (en/hi/ta/…) for outbound
# messaging only — never use it to rewrite persisted order details.
STORAGE_LANGUAGE = "en"

DO_NOT_TRANSLATE = frozenset({
    # Checkout / payment brands & terms (keep Latin in body copy)
    "Cart",
    "Checkout",
    "OTP",
    "UPI",
    "Paytm",
    "GPay",
    "PhonePe",
    "Razorpay",
    "INR",
    # Bot command tokens customers must type exactly
    "REPEAT",
    "Home",
    "Hi",
    # WhatsApp CTA button label (char-limited; keep consistent across langs)
    "Confirm & Pay",
})

# Preferred phrase map: English source → {locale: target}.
# Extend when adding languages. Values may mix script + Latin brand terms.
PREFERRED_TRANSLATION = {
    "Add to Cart": {
        "hi": "कार्ट में जोड़ें",
        "ta": "கார்ட்டில் சேர்க்கவும்",
        "te": "కార్ట్‌కు జోడించండి",
        "kn": "ಕಾರ್ಟ್‌ಗೆ ಸೇರಿಸಿ",
        "mr": "कार्टमध्ये जोडा",
        "ml": "കാർട്ടിലേക്ക് ചേർക്കുക",
        "gu": "કાર્ટમાં ઉમેરો",
        "bn": "কার্টে যোগ করুন",
    },
    "Cash on Delivery": {
        "hi": "कैश ऑन डिलीवरी (COD)",
        "ta": "கேஷ் ஆன் டெலிவரி",
        "te": "క్యాష్ ఆన్ డెలివరీ (COD)",
        "kn": "ಕ್ಯಾಶ್ ಆನ್ ಡೆಲಿವರಿ (COD)",
        "mr": "कॅश ऑन डिलिव्हरी (COD)",
        "ml": "ക്യാഷ് ഓൺ ഡെലിവറി (COD)",
        "gu": "કૅશ ઑન ડિલિવરી (COD)",
        "bn": "ক্যাশ অন ডেলিভারি (COD)",
    },
}

# Supported customer locale codes (WhatsApp replies).
SUPPORTED_LOCALES = ("en", "hi", "ta", "te", "kn", "mr", "ml", "gu", "bn")

# English labels for persisted / staff-facing service types.
SERVICE_TYPE_LABELS_EN = {
    "takeaway": "Takeaway",
    "delivery": "Delivery",
    "dine_in": "Dine-in",
    "scheduled_takeaway": "Scheduled takeaway",
    "scheduled_delivery": "Scheduled delivery",
    "scheduled_pickup": "Scheduled pickup",
}
