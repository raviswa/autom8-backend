# Translation engine constraints for customer WhatsApp copy.
# Used as the source of truth when adding / refreshing locale files.
# Webcart UI chrome i18n is intentionally deferred (future build).
#
# CONFIDENCE POLICY
# ------------------
# Every term below is tagged in comments as one of:
#   [SOLID]  - genuinely how urban/bilingual speakers say this in casual speech.
#              Verified against native-speaker judgment for that language.
#   [DRAFT]  - plausible transliteration/rendering, but NOT confirmed as the
#              natural colloquial choice. Needs a native-speaker review pass
#              before shipping to production copy.
#
# [SOLID] confidence currently exists for: hi, ta, bn, mr (see conversation
# history — these were sanity-checked against real spoken usage).
# [DRAFT] for: te, kn, ml, gu — these are reasonable transliterations but
# have NOT been validated colloquially. Flagged inline; get a native
# speaker to confirm before these ship to a live customer-facing bot.
#
# CHANGE LOG (this revision)
# ---------------------------------------------------------------------------
# - "Dine-in" is no longer kept in Latin script. Replaced with a
#   "restaurant + eat" framing (loanword "restaurant" + native verb).
#   ta confirmed directly by user ("உணவகத்தில் சாப்பிட"); all other
#   locales mirrored to the same pattern but remain [DRAFT].
# - "Scheduled delivery" / "Scheduled takeaway" are no longer kept in
#   Latin script. Replaced with "Scheduled" as a transliterated loanword
#   + native noun (parcel/delivery), matching how the file already
#   treats other English business terms (Combo, Extra, GST, etc.).
#   ta wording for "Scheduled takeaway" is user-specified exactly
#   ("திட்டமிடப்பட்ட பார்சல்") — note this is a literal-translation
#   register, not the loanword-transliteration pattern used elsewhere;
#   this is an intentional per-locale inconsistency, not an oversight.
# - Added SCHEDULED_ORDER_MAX_DAYS_AHEAD + footnote template system for
#   the "you can pre-book up to N days ahead" helper text. The day count
#   is NOT hardcoded into any translated string — it's injected at
#   render time via get_scheduled_order_footnote(), so changing the
#   config value propagates everywhere without touching translations.
# - "Dine-in", "Scheduled delivery", "Scheduled takeaway" removed from
#   DO_NOT_TRANSLATE since they now have real translated forms instead
#   of falling back to Latin script.
#
# GENERAL PRINCIPLE (applies across every language, not just Tamil):
# Compound business/UI labels ("Scheduled pickup" still, for now) do not
# have a natural single-phrase spoken equivalent in ANY of these
# languages — they are category labels, not spoken phrases, even in
# English. Default to keeping these in Latin script embedded in the
# native sentence, rather than forcing a script transliteration that
# reads as stiff/bookish — UNLESS a clearer alternative has been
# explicitly worked out and confirmed (as done here for Dine-in /
# Scheduled delivery / Scheduled takeaway). Terms that genuinely ARE
# spoken as loanwords in daily life (delivery, parcel, book/booking,
# GST, extra, combo, scheduled) should stay transliterated into native
# script since that's how people actually say them.

# ---------------------------------------------------------------------------
# STORAGE LANGUAGE POLICY (hard rule)
# ---------------------------------------------------------------------------
# Customer WhatsApp replies may be localized (hi/ta/te/kn/ml/mr/bn/gu/…).
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
    "GST",
    # Bot command tokens customers must type exactly
    "REPEAT",
    "Home",
    "Hi",
    # WhatsApp CTA button label (char-limited; keep consistent across langs)
    "Confirm & Pay",
    # Category/business labels with no natural spoken equivalent —
    # keep in Latin script embedded within the native sentence.
    # NOTE: "Dine-in", "Scheduled delivery", "Scheduled takeaway" were
    # removed from this set — they now have real translated entries in
    # PREFERRED_TRANSLATION below instead of falling back to Latin.
    "Scheduled pickup",
})

# ---------------------------------------------------------------------------
# ADVANCE BOOKING WINDOW (config-driven, not hardcoded per string)
# ---------------------------------------------------------------------------
# Single source of truth for how many days ahead a scheduled
# delivery/takeaway/pickup can be pre-booked. Change here only — never
# hardcode this number into a translated string.
SCHEDULED_ORDER_MAX_DAYS_AHEAD = 7

# Footnote templates use {n} — filled from SCHEDULED_ORDER_MAX_DAYS_AHEAD
# at render time via get_scheduled_order_footnote(), not hardcoded.
# [DRAFT] all locales except ta (user-specified exact wording).
SCHEDULED_ORDER_FOOTNOTE = {
    "en": "You can pre-book up to {n} days ahead",
    "hi": "{n} दिन पहले तक बुक कर सकते हैं",
    "ta": "{n} நாட்கள் வரை முன்பதிவு செய்யலாம்",  # user-specified
    "bn": "{n} দিন আগে পর্যন্ত বুক করতে পারবেন",
    "mr": "{n} दिवस आधी बुक करू शकता",
    "te": "{n} రోజుల ముందు వరకు బుక్ చేసుకోవచ్చు",
    "kn": "{n} ದಿನಗಳ ಮೊದಲು ಬುಕ್ ಮಾಡಬಹುದು",
    "ml": "{n} ദിവസം മുൻപ് വരെ ബുക്ക് ചെയ്യാം",
    "gu": "{n} દિવસ પહેલા સુધી બુક કરી શકાય",
}


def get_scheduled_order_footnote(locale: str) -> str:
    """Render the 'pre-book up to N days ahead' footnote for a locale.

    Always routes the day count through SCHEDULED_ORDER_MAX_DAYS_AHEAD
    at render time. Never hardcode the number directly into a template
    string — changing the config value here should propagate everywhere
    without touching any translation string.
    """
    template = SCHEDULED_ORDER_FOOTNOTE.get(locale, SCHEDULED_ORDER_FOOTNOTE["en"])
    return template.format(n=SCHEDULED_ORDER_MAX_DAYS_AHEAD)


# ---------------------------------------------------------------------------
# SERVICE TYPES (order fulfillment mode)
# ---------------------------------------------------------------------------
# English labels for persisted / staff-facing service types (DB/KDS layer —
# never localize these; see STORAGE_LANGUAGE policy above).
SERVICE_TYPE_LABELS_EN = {
    "takeaway": "Takeaway",
    "delivery": "Delivery",
    "dine_in": "Dine-in",
    "reserve_table": "Reserve a table",
    "scheduled_takeaway": "Scheduled takeaway",
    "scheduled_delivery": "Scheduled delivery",
    "scheduled_pickup": "Scheduled pickup",
}

# Preferred phrase map: English source → {locale: target}.
# Extend when adding languages. Values may mix script + Latin brand terms.
PREFERRED_TRANSLATION = {

    # --- Service types --------------------------------------------------
    "Dine-in": {
        # [SOLID] ta confirmed directly by user: "restaurant" loanword +
        # native verb "to eat" ("unavagathil saapida").
        "ta": "உணவகத்தில் சாப்பிட",
        # [DRAFT] mirrored to same "restaurant + eat" pattern; unverified
        # colloquially — get native speaker confirmation before shipping.
        "hi": "रेस्टोरेंट में खाना",
        "bn": "রেস্টুরেন্টে খাওয়া",
        "mr": "रेस्टॉरंटमध्ये जेवण",
        "te": "రెస్టారెంట్‌లో తినడం",
        "kn": "ರೆಸ್ಟೋರೆಂಟ್‌ನಲ್ಲಿ ತಿನ್ನುವುದು",
        "ml": "റെസ്റ്റോറന്റിൽ കഴിക്കൽ",
        "gu": "રેસ્ટોરન્ટમાં જમવું",
    },
    "Delivery": {
        # [SOLID] genuinely spoken as a loanword across all these languages.
        "hi": "डिलीवरी",
        "ta": "டெலிவரி",
        "bn": "ডেলিভারি",
        "mr": "डिलिव्हरी",
        # [DRAFT] transliteration pattern consistent with above; unverified colloquially.
        "te": "డెలివరీ",
        "kn": "ಡೆಲಿವರಿ",
        "ml": "ഡെലിവറി",
        "gu": "ડિલિવરી",
    },
    "Takeaway": {
        # [SOLID] "parcel" is the actual colloquial word used, not a literal
        # translation of "takeaway".
        "hi": "पार्सल",
        "ta": "பார்சல்",
        "bn": "পার্সেল",
        "mr": "पार्सल",
        # [DRAFT]
        "te": "పార్సెల్",
        "kn": "ಪಾರ್ಸೆಲ್",
        "ml": "പാഴ്സൽ",
        "gu": "પાર્સલ",
    },
    "Reserve a table": {
        # [SOLID] "book/booking" is a genuine loanword; "table book karna"
        # style phrasing is how this is actually said.
        "hi": "टेबल बुक करें",
        "ta": "மேசை பதிவு செய்யவும்",
        "bn": "টেবিল বুক করুন",
        "mr": "टेबल बुक करा",
        # [DRAFT]
        "te": "టేబుల్ బుక్ చేయండి",
        "kn": "ಟೇಬಲ್ ಬುಕ್ ಮಾಡಿ",
        "ml": "ടേബിൾ ബുക്ക് ചെയ്യുക",
        "gu": "ટેબલ બુક કરો",
    },
    "Scheduled delivery": {
        # [DRAFT] "Scheduled" as transliterated loanword + native
        # "delivery" — consistent with how the file already transliterates
        # other English business terms (Combo, Extra, GST). All locales
        # unverified colloquially; needs native-speaker review before
        # shipping, especially since this replaces the earlier Latin-only
        # fallback.
        "hi": "शेड्यूल्ड डिलीवरी",
        "ta": "திட்டமிடப்பட்ட டெலிவரி",
        "bn": "শিডিউলড ডেলিভারি",
        "mr": "शेड्यूल्ड डिलिव्हरी",
        "te": "షెడ్యూల్డ్ డెలివరీ",
        "kn": "ಶೆಡ್ಯೂಲ್ಡ್ ಡೆಲಿವರಿ",
        "ml": "ഷെഡ്യൂൾഡ് ഡെലിവറി",
        "gu": "શેડ્યૂલ્ડ ડિલિવરી",
    },
    "Scheduled takeaway": {
        # [DRAFT] ta is user-specified exact wording (literal translation
        # register, not loanword-transliteration — intentional
        # inconsistency vs. other locales here, kept per user decision).
        # Other locales use "Scheduled" as transliterated loanword +
        # native "parcel", mirroring the Scheduled delivery pattern.
        "ta": "திட்டமிடப்பட்ட பார்சல்",  # user-specified
        "hi": "शेड्यूल्ड पार्सल",
        "bn": "শিডিউলড পার্সেল",
        "mr": "शेड्यूल्ड पार्सल",
        "te": "షెడ్యూల్డ్ పార్సెల్",
        "kn": "ಶೆಡ್ಯೂಲ್ಡ್ ಪಾರ್ಸೆಲ್",
        "ml": "ഷെഡ്യൂൾഡ് പാഴ്സൽ",
        "gu": "શેડ્યૂલ્ડ પાર્સલ",
    },

    # --- Cart / checkout --------------------------------------------------
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

    # --- Dietary / spice ----------------------------------------------------
    "Veg": {
        # [SOLID] "veg/non-veg" is near-universally spoken as-is or lightly
        # transliterated; this is one of the most stable loanword pairs in
        # Indian English-mixed speech.
        "hi": "वेज", "ta": "வெஜ்", "bn": "ভেজ", "mr": "व्हेज",
        # [DRAFT]
        "te": "వెజ్", "kn": "ವೆಜ್", "ml": "വെജ്", "gu": "વેજ",
    },
    "Non-Veg": {
        "hi": "नॉन-वेज", "ta": "நான்-வெஜ்", "bn": "নন-ভেজ", "mr": "नॉन-व्हेज",
        # [DRAFT]
        "te": "నాన్-వెజ్", "kn": "ನಾನ್-ವೆಜ್", "ml": "നോൺ-വെജ്", "gu": "નોન-વેજ",
    },
    "Jain": {
        # [SOLID] "Jain" (no onion/garlic) is spoken as-is; no vernacular
        # equivalent exists — it's a proper-noun dietary tag.
        "hi": "जैन", "ta": "ஜைன்", "bn": "জৈন", "mr": "जैन",
        "te": "జైన్", "kn": "ಜೈನ್", "ml": "ജൈൻ", "gu": "જૈન",
    },
    "Spice level": {
        # [SOLID] "teekha/spicy" framing is more natural than a literal
        # "spice level" label in hi/mr; kept as a spoken question style.
        "hi": "कितना तीखा चाहिए?",
        "ta": "எவ்வளவு காரம் வேண்டும்?",
        "bn": "কতটা ঝাল চান?",
        "mr": "किती तिखट हवं?",
        # [DRAFT]
        "te": "ఎంత కారం కావాలి?",
        "kn": "ಎಷ್ಟು ಖಾರ ಬೇಕು?",
        "ml": "എത്ര എരിവ് വേണം?",
        "gu": "કેટલું તીખું જોઈએ?",
    },
    "Mild": {
        "hi": "हल्का तीखा", "ta": "குறைவான காரம்", "bn": "কম ঝাল", "mr": "कमी तिखट",
        "te": "తక్కువ కారం", "kn": "ಕಡಿಮೆ ಖಾರ", "ml": "കുറഞ്ഞ എരിവ്", "gu": "ઓછું તીખું",
    },
    "Extra Spicy": {
        "hi": "एक्स्ट्रा तीखा", "ta": "எக்ஸ்ட்ரா காரம்", "bn": "এক্সট্রা ঝাল", "mr": "एक्स्ट्रा तिखट",
        "te": "ఎక్స్ట్రా కారం", "kn": "ಎಕ್ಸ್ಟ್ರಾ ಖಾರ", "ml": "എക്സ്ട്രാ എരിവ്", "gu": "એક્સ્ટ્રા તીખું",
    },

    # --- Add-ons / combos / portion ------------------------------------------
    "Combo": {
        # [SOLID] "combo" is a pure loanword everywhere — never translated.
        "hi": "कॉम्बो", "ta": "காம்போ", "bn": "কম্বো", "mr": "कॉम्बो",
        "te": "కాంబో", "kn": "ಕಾಂಬೊ", "ml": "കോംബോ", "gu": "કોમ્બો",
    },
    "Add-on": {
        # [SOLID] spoken as "extra" far more often than a literal "add-on".
        "hi": "एक्स्ट्रा", "ta": "எக்ஸ்ட்ரா", "bn": "এক্সট্রা", "mr": "एक्स्ट्रा",
        "te": "ఎక్స్ట్రా", "kn": "ಎಕ್ಸ್ಟ್ರಾ", "ml": "എക്സ്ട്രാ", "gu": "એક્સ્ટ્રા",
    },
    "Portion size": {
        "hi": "साइज़", "ta": "அளவு", "bn": "সাইজ", "mr": "साइज",
        # [DRAFT]
        "te": "సైజ్", "kn": "ಗಾತ್ರ", "ml": "സൈസ്", "gu": "સાઇઝ",
    },
    "Half": {
        "hi": "हाफ", "ta": "ஹாஃப்", "bn": "হাফ", "mr": "हाफ",
        "te": "హాఫ్", "kn": "ಹಾಫ್", "ml": "ഹാഫ്", "gu": "હાફ",
    },
    "Full": {
        "hi": "फुल", "ta": "ஃபுல்", "bn": "ফুল", "mr": "फुल",
        "te": "ఫుల్", "kn": "ಫುಲ್", "ml": "ഫുൾ", "gu": "ફુલ",
    },

    # --- Menu categories ----------------------------------------------------
    "Starter": {
        # [SOLID] spoken as-is, never translated.
        "hi": "स्टार्टर", "ta": "ஸ்டார்ட்டர்", "bn": "স্টার্টার", "mr": "स्टार्टर",
        "te": "స్టార్టర్", "kn": "ಸ್ಟಾರ್ಟರ್", "ml": "സ്റ്റാർട്ടർ", "gu": "સ્ટાર્ટર",
    },
    "Main Course": {
        "hi": "मेन कोर्स", "ta": "மெயின் கோர்ஸ்", "bn": "মেইন কোর্স", "mr": "मेन कोर्स",
        "te": "మెయిన్ కోర్స్", "kn": "ಮೇನ್ ಕೋರ್ಸ್", "ml": "മെയിൻ കോഴ്സ്", "gu": "મેઇન કોર્સ",
    },
    "Dessert": {
        "hi": "डेज़र्ट", "ta": "இனிப்பு", "bn": "ডেজার্ট", "mr": "डेझर्ट",
        # ta uses native word here since "இனிப்பு" (sweet) is genuinely how
        # it's said, more than a transliteration of "dessert". [SOLID]
        "te": "డెజర్ట్", "kn": "ಡೆಸರ್ಟ್", "ml": "ഡെസേർട്ട്", "gu": "ડેઝર્ટ",
    },
    "Beverages": {
        "hi": "ड्रिंक्स", "ta": "குடிபானங்கள்", "bn": "ড্রিংকস", "mr": "ड्रिंक्स",
        "te": "డ్రింక్స్", "kn": "ಡ್ರಿಂಕ್ಸ್", "ml": "ഡ്രിങ്ക്സ്", "gu": "ડ્રિંક્સ",
    },
    "Thali": {
        "hi": "थाली", "ta": "தாலி", "bn": "থালি", "mr": "थाळी",
        "te": "థాలి", "kn": "ಥಾಲಿ", "ml": "താലി", "gu": "થાળી",
    },
    "Buffet": {
        "hi": "बुफे", "ta": "பஃபே", "bn": "বুফে", "mr": "बुफे",
        "te": "బఫే", "kn": "ಬುಫೆ", "ml": "ബുഫേ", "gu": "બુફે",
    },

    # --- Charges / payments --------------------------------------------------
    "Packaging charge": {
        "hi": "पैकिंग चार्ज", "ta": "பேக்கிங் சார்ஜ்", "bn": "প্যাকিং চার্জ", "mr": "पॅकिंग चार्ज",
        "te": "ప్యాకింగ్ ఛార్జ్", "kn": "ಪ್ಯಾಕಿಂಗ್ ಚಾರ್ಜ್", "ml": "പാക്കിംഗ് ചാർജ്", "gu": "પેકિંગ ચાર્જ",
    },
    "Delivery charge": {
        "hi": "डिलीवरी चार्ज", "ta": "டெலிவரி சார்ஜ்", "bn": "ডেলিভারি চার্জ", "mr": "डिलिव्हरी चार्ज",
        "te": "డెలివరీ ఛార్జ్", "kn": "ಡೆಲಿವರಿ ಚಾರ್ಜ್", "ml": "ഡെലിവറി ചാർജ്", "gu": "ડિલિવરી ચાર્જ",
    },
    "Discount": {
        "hi": "डिस्काउंट", "ta": "தள்ளுபடி", "bn": "ছাড়", "mr": "सूट",
        # Native words used for hi/ta/bn/mr since these ARE the colloquial
        # choice for "discount" in day-to-day shopping talk. [SOLID]
        "te": "డిస్కౌంట్", "kn": "ಡಿಸ್ಕೌಂಟ್", "ml": "ഡിസ്കൗണ്ട്", "gu": "ડિસ્કાઉન્ટ",
    },
    "Coupon code": {
        "hi": "कूपन कोड", "ta": "கூப்பன் கோட்", "bn": "কুপন কোড", "mr": "कूपन कोड",
        "te": "కూపన్ కోడ్", "kn": "ಕೂಪನ್ ಕೋಡ್", "ml": "കൂപ്പൺ കോഡ്", "gu": "કૂપન કોડ",
    },
    "Refund": {
        "hi": "रिफंड", "ta": "பணத்தைத் திரும்பப் பெறு", "bn": "রিফান্ড", "mr": "परतावा",
        "te": "రీఫండ్", "kn": "ರೀಫಂಡ್", "ml": "റീഫണ്ട്", "gu": "રિફંડ",
    },
    "Cancel order": {
        "hi": "ऑर्डर कैंसिल करें", "ta": "ஆர்டரை ரத்து செய்யவும்", "bn": "অর্ডার বাতিল করুন", "mr": "ऑर्डर रद्द करा",
        "te": "ఆర్డర్ క్యాన్సిల్ చేయండి", "kn": "ಆರ್ಡರ್ ಕ್ಯಾನ್ಸಲ್ ಮಾಡಿ", "ml": "ഓർഡർ ക്യാൻസൽ ചെയ്യുക", "gu": "ઓર્ડર કેન્સલ કરો",
    },

    # --- Order lifecycle / status --------------------------------------------
    "Order placed": {
        "hi": "ऑर्डर हो गया", "ta": "ஆர்டர் செய்யப்பட்டது", "bn": "অর্ডার হয়ে গেছে", "mr": "ऑर्डर झाली",
        "te": "ఆర్డర్ పెట్టబడింది", "kn": "ಆರ್ಡರ್ ಮಾಡಲಾಗಿದೆ", "ml": "ഓർഡർ ചെയ്തു", "gu": "ઓર્ડર થઈ ગયો",
    },
    "Preparing": {
        "hi": "बन रहा है", "ta": "தயார் செய்யப்படுகிறது", "bn": "তৈরি হচ্ছে", "mr": "तयार होत आहे",
        "te": "తయారవుతోంది", "kn": "ತಯಾರಾಗುತ್ತಿದೆ", "ml": "തയ്യാറാക്കുന്നു", "gu": "તૈયાર થઈ રહ્યું છે",
    },
    "Packed": {
        "hi": "पैक हो गया", "ta": "பேக் செய்யப்பட்டது", "bn": "প্যাক হয়ে গেছে", "mr": "पॅक झालं",
        "te": "ప్యాక్ చేయబడింది", "kn": "ಪ್ಯಾಕ್ ಆಗಿದೆ", "ml": "പാക്ക് ചെയ്തു", "gu": "પેક થઈ ગયું",
    },
    "Out for delivery": {
        "hi": "डिलीवरी के लिए निकल गया", "ta": "டெலிவரிக்கு கிளம்பியது", "bn": "ডেলিভারির জন্য বেরিয়েছে", "mr": "डिलिव्हरीसाठी निघालं",
        "te": "డెలివరీ కోసం బయలుదేరింది", "kn": "ಡೆಲಿವರಿಗೆ ಹೊರಟಿದೆ", "ml": "ഡെലിവറിക്ക് പുറപ്പെട്ടു", "gu": "ડિલિવરી માટે નીકળી ગયું",
    },
    "Ready for pickup": {
        "hi": "पिकअप के लिए तैयार", "ta": "எடுத்துக்கொள்ள தயார்", "bn": "পিকআপের জন্য প্রস্তুত", "mr": "पिकअपसाठी तयार",
        "te": "పికప్ కోసం సిద్ధంగా ఉంది", "kn": "ಪಿಕಪ್‌ಗೆ ಸಿದ್ಧ", "ml": "പിക്കപ്പിന് തയ്യാർ", "gu": "પિકઅપ માટે તૈયાર",
    },
    "Delivered": {
        "hi": "डिलीवर हो गया", "ta": "டெலிவரி செய்யப்பட்டது", "bn": "ডেলিভার হয়ে গেছে", "mr": "डिलिव्हर झालं",
        "te": "డెలివర్ చేయబడింది", "kn": "ಡೆಲಿವರ್ ಆಗಿದೆ", "ml": "ഡെലിവർ ചെയ്തു", "gu": "ડિલિવર થઈ ગયું",
    },

    # --- Feedback / ratings ---------------------------------------------------
    "Rate your order": {
        "hi": "अपने ऑर्डर को रेट करें", "ta": "உங்கள் ஆர்டரை மதிப்பிடுங்கள்", "bn": "আপনার অর্ডার রেট করুন", "mr": "तुमच्या ऑर्डरला रेट करा",
        "te": "మీ ఆర్డర్‌ను రేట్ చేయండి", "kn": "ನಿಮ್ಮ ಆರ್ಡರ್ ಅನ್ನು ರೇಟ್ ಮಾಡಿ", "ml": "നിങ്ങളുടെ ഓർഡർ റേറ്റ് ചെയ്യുക", "gu": "તમારા ઓર્ડરને રેટ કરો",
    },
    "Feedback": {
        "hi": "फीडबैक", "ta": "கருத்து", "bn": "মতামত", "mr": "अभिप्राय",
        "te": "అభిప్రాయం", "kn": "ಪ್ರತಿಕ್ರಿಯೆ", "ml": "അഭിപ്രായം", "gu": "પ્રતિભાવ",
    },
}

# Supported customer locale codes (WhatsApp replies).
SUPPORTED_LOCALES = ("en", "hi", "ta", "te", "kn", "mr", "ml", "gu", "bn")

# Languages whose entries above are [DRAFT] — plausible but colloquially
# unverified. Surface this in tooling / linting so nothing ships silently.
# NOTE: this list tracks te/kn/ml/gu as a whole (original scope). The new
# Dine-in / Scheduled delivery / Scheduled takeaway entries introduce
# [DRAFT] status into hi/bn/mr as well for THOSE THREE KEYS ONLY — see
# SPECIAL_REVIEW_KEYS below rather than expanding this tuple, since it
# would otherwise misrepresent hi/bn/mr as unverified across the board.
NEEDS_NATIVE_REVIEW = ("te", "kn", "ml", "gu")

# Keys where [DRAFT] status applies to locales beyond the usual
# NEEDS_NATIVE_REVIEW set, because the phrasing pattern itself is new
# and unverified (except where explicitly user-confirmed — see inline
# comments in PREFERRED_TRANSLATION above).
SPECIAL_REVIEW_KEYS = {
    "Dine-in": {
        "confirmed": ("ta",),
        "draft": ("hi", "bn", "mr", "te", "kn", "ml", "gu"),
    },
    "Scheduled delivery": {
        "confirmed": (),
        "draft": ("hi", "ta", "bn", "mr", "te", "kn", "ml", "gu"),
    },
    "Scheduled takeaway": {
        "confirmed": ("ta",),
        "draft": ("hi", "bn", "mr", "te", "kn", "ml", "gu"),
    },
}
