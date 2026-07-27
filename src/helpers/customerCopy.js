'use strict';

/**
 * Minimal customer WhatsApp copy for Node paths (table-ready / wait display).
 * Mirrors chat/locales/customer keys used after portal seating.
 * Falls back to English when a key/lang is missing.
 */

const EN = {
  wait_ready_now: 'Ready to seat now',
  wait_no_table: 'No suitable table available',
  wait_under_15: 'Less than 15 minutes',
  wait_around_20_30: 'Around 20 to 30 minutes',
  wait_approx_range: 'Approximately {lo} to {hi} minutes',
  table_ready_customer:
    'Your table is ready! ✅\n\n'
    + 'Queue number: {token}\n'
    + 'Table: Table {table}\n\n'
    + 'Please proceed to your table. We look forward to serving you{outlet}.',
  table_finding_ready_now:
    'Thank you! A table is available for {n} guests. 🙏\n\n'
    + 'Your queue number: {token}\n\n'
    + 'Please come to the reception — our team will seat you shortly.',
  table_finding_host:
    'Thank you! We have noted your visit for {n} guests. 🙏\n\n'
    + 'Your queue number: {token}\n\n'
    + 'Please speak with the host. Our team will assist you shortly.',
  table_finding_with_estimate:
    'Thank you! We will find a table for {n} guests. 🙏\n\n'
    + 'Your queue number: {token}\n'
    + 'Estimated wait: {estimate}\n\n'
    + 'We will send you a message as soon as your table is ready.',
};

const TA = {
  wait_ready_now: 'இப்போதே அமரலாம்',
  wait_no_table: 'பொருத்தமான மேசை இல்லை',
  wait_under_15: '15 நிமிடங்களுக்குள்',
  wait_around_20_30: 'சுமார் 20 முதல் 30 நிமிடங்கள்',
  wait_approx_range: 'தோராயமாக {lo} முதல் {hi} நிமிடங்கள்',
  table_ready_customer:
    'உங்கள் மேசை தயார்! ✅\n\n'
    + 'வரிசை எண்: {token}\n'
    + 'மேசை: மேசை {table}\n\n'
    + 'தயவுசெய்து உங்கள் மேசைக்குச் செல்லுங்கள். உங்களுக்கு சேவை செய்ய ஆவலாக உள்ளோம்{outlet}.',
  table_finding_ready_now:
    'நன்றி! {n} விருந்தினர்களுக்கு மேசை உள்ளது. 🙏\n\n'
    + 'உங்கள் வரிசை எண்: {token}\n\n'
    + 'வரவேற்புக்கு வாருங்கள் — எங்கள் குழு உங்களை அமர வைக்கும்.',
  table_finding_host:
    'நன்றி! {n} விருந்தினர்களுக்கான வருகையை பதிவு செய்துள்ளோம். 🙏\n\n'
    + 'உங்கள் வரிசை எண்: {token}\n\n'
    + 'வரவேற்பாளரிடம் பேசுங்கள். எங்கள் குழு விரைவில் உதவியளிக்கும்.',
  table_finding_with_estimate:
    'நன்றி! {n} விருந்தினர்களுக்கு மேசை தேடுகிறோம். 🙏\n\n'
    + 'உங்கள் வரிசை எண்: {token}\n'
    + 'மதிப்பிட்ட காத்திருப்பு: {estimate}\n\n'
    + 'மேசை தயாரானதும் செய்தி அனுப்புவோம்.',
};

const HI = {
  wait_ready_now: 'अभी बैठ सकते हैं',
  wait_no_table: 'उपयुक्त टेबल उपलब्ध नहीं',
  wait_under_15: '15 मिनट से कम',
  wait_around_20_30: 'लगभग 20 से 30 मिनट',
  wait_approx_range: 'लगभग {lo} से {hi} मिनट',
  table_ready_customer:
    'आपकी टेबल तैयार है! ✅\n\n'
    + 'कतार नंबर: {token}\n'
    + 'टेबल: टेबल {table}\n\n'
    + 'कृपया अपनी टेबल पर जाएँ। हम आपकी सेवा के लिए उत्सुक हैं{outlet}।',
  table_finding_ready_now:
    'धन्यवाद! {n} मेहमानों के लिए टेबल उपलब्ध है। 🙏\n\n'
    + 'आपका कतार नंबर: {token}\n\n'
    + 'रिसेप्शन पर आएँ — हमारी टीम आपको बैठाएगी।',
  table_finding_host:
    'धन्यवाद! {n} मेहमानों की विज़िट नोट कर ली है। 🙏\n\n'
    + 'आपका कतार नंबर: {token}\n\n'
    + 'होस्ट से बात करें। टीम जल्दी मदद करेगी।',
  table_finding_with_estimate:
    'धन्यवाद! {n} मेहमानों के लिए टेबल ढूँढ रहे हैं। 🙏\n\n'
    + 'आपका कतार नंबर: {token}\n'
    + 'अनुमानित प्रतीक्षा: {estimate}\n\n'
    + 'टेबल तैयार होते ही संदेश भेजेंगे।',
};

const TE = {
  wait_ready_now: 'ఇప్పుడే కూర్చోవచ్చు',
  wait_no_table: 'సరిపోయే టేబుల్ లేదు',
  wait_under_15: '15 నిమిషాల్లోపు',
  wait_around_20_30: 'సుమారు 20 నుండి 30 నిమిషాలు',
  wait_approx_range: 'సుమారు {lo} నుండి {hi} నిమిషాలు',
  table_ready_customer:
    'మీ టేబుల్ సిద్ధం! ✅\n\n'
    + 'క్యూ నంబర్: {token}\n'
    + 'టేబుల్: టేబుల్ {table}\n\n'
    + 'దయచేసి మీ టేబుల్‌కు వెళ్లండి. మీకు సేవ చేయడానికి సిద్ధంగా ఉన్నాము{outlet}.',
  table_finding_ready_now:
    'ధన్యవాదాలు! {n} అతిథులకు టేబుల్ ఉంది. 🙏\n\n'
    + 'మీ క్యూ నంబర్: {token}\n\n'
    + 'రిసెప్షన్‌కు రండి — మా బృందం మిమ్మల్ని కూర్చోబెడుతుంది.',
  table_finding_host:
    'ధన్యవాదాలు! {n} అతిథుల సందర్శన నమోదు చేశాము. 🙏\n\n'
    + 'మీ క్యూ నంబర్: {token}\n\n'
    + 'హోస్ట్‌తో మాట్లాడండి. బృందం త్వరలో సహాయం చేస్తుంది.',
  table_finding_with_estimate:
    'ధన్యవాదాలు! {n} అతిథులకు టేబుల్ వెతుకుతున్నాము. 🙏\n\n'
    + 'మీ క్యూ నంబర్: {token}\n'
    + 'అంచనా వేచి: {estimate}\n\n'
    + 'టేబుల్ సిద్ధమైన వెంటనే సందేశం పంపుతాము.',
};

const KN = {
  wait_ready_now: 'ಈಗಲೇ ಕುಳಿತುಕೊಳ್ಳಬಹುದು',
  wait_no_table: 'ಸೂಕ್ತ ಟೇಬಲ್ ಲಭ್ಯವಿಲ್ಲ',
  wait_under_15: '15 ನಿಮಿಷಗಳೊಳಗೆ',
  wait_around_20_30: 'ಸುಮಾರು 20 ರಿಂದ 30 ನಿಮಿಷಗಳು',
  wait_approx_range: 'ಸುಮಾರು {lo} ರಿಂದ {hi} ನಿಮಿಷಗಳು',
  table_ready_customer:
    'ನಿಮ್ಮ ಟೇಬಲ್ ಸಿದ್ಧ! ✅\n\n'
    + 'ಕ್ಯೂ ಸಂಖ್ಯೆ: {token}\n'
    + 'ಟೇಬಲ್: ಟೇಬಲ್ {table}\n\n'
    + 'ದಯವಿಟ್ಟು ನಿಮ್ಮ ಟೇಬಲ್‌ಗೆ ಹೋಗಿ. ನಿಮಗೆ ಸೇವೆ ಮಾಡಲು ಉತ್ಸುಕರಾಗಿದ್ದೇವೆ{outlet}.',
  table_finding_ready_now:
    'ಧನ್ಯವಾದಗಳು! {n} ಅತಿಥಿಗಳಿಗೆ ಟೇಬಲ್ ಲಭ್ಯವಿದೆ. 🙏\n\n'
    + 'ನಿಮ್ಮ ಕ್ಯೂ ಸಂಖ್ಯೆ: {token}\n\n'
    + 'ರಿಸೆಪ್ಷನ್‌ಗೆ ಬನ್ನಿ — ನಮ್ಮ ತಂಡ ನಿಮ್ಮನ್ನು ಕುಳ್ಳಿರಿಸುತ್ತದೆ.',
  table_finding_host:
    'ಧನ್ಯವಾದಗಳು! {n} ಅತಿಥಿಗಳ ಭೇಟಿ ದಾಖಲಿಸಿದ್ದೇವೆ. 🙏\n\n'
    + 'ನಿಮ್ಮ ಕ್ಯೂ ಸಂಖ್ಯೆ: {token}\n\n'
    + 'ಹೋಸ್ಟ್‌ಜೊತೆ ಮಾತನಾಡಿ. ತಂಡ ಶೀಘ್ರದಲ್ಲೇ ಸಹಾಯ ಮಾಡುತ್ತದೆ.',
  table_finding_with_estimate:
    'ಧನ್ಯವಾದಗಳು! {n} ಅತಿಥಿಗಳಿಗೆ ಟೇಬಲ್ ಹುಡುಕುತ್ತಿದ್ದೇವೆ. 🙏\n\n'
    + 'ನಿಮ್ಮ ಕ್ಯೂ ಸಂಖ್ಯೆ: {token}\n'
    + 'ಅಂದಾಜು ಕಾಯುವಿಕೆ: {estimate}\n\n'
    + 'ಟೇಬಲ್ ಸಿದ್ಧವಾದಾಗ ಸಂದೇಶ ಕಳುಹಿಸುತ್ತೇವೆ.',
};

const CATALOGS = {
  en: EN,
  ta: TA,
  hi: HI,
  te: TE,
  kn: KN,
  // Remaining Indic locales fall back to Hindi for these seating strings
  // until full catalogs are filled in chat/locales.
  mr: HI,
  ml: TA,
  gu: HI,
  bn: HI,
};

function normalizeLang(lang) {
  const raw = String(lang || 'en').trim().toLowerCase();
  if (CATALOGS[raw]) return raw;
  const aliases = {
    tamil: 'ta', hindi: 'hi', hinglish: 'hi', telugu: 'te',
    kannada: 'kn', marathi: 'mr', malayalam: 'ml', gujarati: 'gu',
    gujarathi: 'gu', bengali: 'bn', bangla: 'bn', english: 'en',
  };
  return aliases[raw] || 'en';
}

function formatTemplate(template, vars = {}) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => {
    const val = vars[key];
    return val == null ? '' : String(val);
  });
}

function customerReply(lang, key, vars = {}) {
  const code = normalizeLang(lang);
  const catalog = CATALOGS[code] || EN;
  const template = catalog[key] || EN[key] || key;
  return formatTemplate(template, vars);
}

function preferredLanguageFromSession(session) {
  const ctx = session?.context || session || {};
  return normalizeLang(ctx.preferred_language || ctx.last_order_language || 'en');
}

module.exports = {
  customerReply,
  normalizeLang,
  preferredLanguageFromSession,
  CATALOGS,
};
