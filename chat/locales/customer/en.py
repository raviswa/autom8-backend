REPLIES = {
    # Time periods
    "period_morning": "morning",
    "period_afternoon": "afternoon",
    "period_evening": "evening",
    "period_night": "night",

    # Restaurant greeting / menu
    # Keep greetings short and literal so local languages stay natural.
    "greet_good_period": "Good {period} 👋",
    "greet_good_period_named": "Good {period}, {first} 👋",
    "welcome_new": "Welcome to *{display}* 🙏",
    "welcome_back": "Welcome back to *{display}* 🙏",
    "welcome_new_named": "Welcome, {first} — so glad you are here at *{display}* 🙏",
    "welcome_back_named": "Welcome back, {first} — so glad to see you at *{display}* 🙏",
    "cuisine_default": "Good food, made your way.",
    "cuisine_veg": "Fresh vegetarian food, made every day.",
    "cuisine_non_veg": "Fresh non-vegetarian favourites, made every day.",
    "cuisine_asian": "Bold Asian flavours, cooked fresh every day.",
    "cuisine_continental": "Continental classics, cooked fresh every day.",
    "cuisine_fast_food": "Hot comfort food, cooked fresh every day.",
    "menu_hook_default": "Everything is cooked fresh when you order.",
    "menu_hook_veg": "Everything on our menu is fully vegetarian.",
    "menu_hook_non_veg": "From starters to mains — cooked fresh for you.",
    "menu_hook_asian": "Every order is wok-cooked and fresh.",
    "menu_hook_continental": "Cooked to order, finished with care.",
    "menu_hook_fast_food": "Fast, fresh, and just how you like it.",
    "menu_intro_header": "🍽️ *{display}*",
    "menu_intro_named": "Here is what we have today, {first}:\n",
    "menu_intro_cta": "Browse the menu below, choose your items, and we will take care of the rest.",

    # Minimal LOB hooks — plain warm sentences (avoid marketing shorthand).
    "lob_psl_hook": "Pizza, ice cream, and more — we have something for everyone.",
    "lob_food_products_hook": "We make fresh baked goods and sweets with care. Come take a look!",
    "lob_retail_hook": "Browse our catalog and find what you need today.",
    "lob_cta_header_order": "Start ordering",
    "lob_cta_header_shop": "Start shopping",
    "lob_cta_button_order": "Open menu",
    "lob_cta_button_shop": "Open catalog",

    "welcome_returning_named": "Welcome back, {first}! So glad to see you at *{display}* {icon}",
    "welcome_named": "Welcome, {first}! So glad you are here at *{display}* {icon}",
    "welcome_anon": "Welcome! So glad you are here at *{display}* {icon}",
    "welcome_browse_cta": (
        "Open the menu below to choose your items and pay safely online."
    ),
    "welcome_fulfillment_hint": (
        "When you finish ordering, you can pick up at the store or get delivery at home."
    ),
    "welcome_repeat_hint": (
        "Ordered before? Reply *REPEAT* anytime to order the same items again."
    ),
    "menu_link_failed": (
        "Sorry, we could not open the menu right now. Please try again in a moment. 🙏"
    ),
    "repeat_unavailable": (
        "We could not find a previous order for you at *{display}*. 🙏\n\n"
        "Tap the menu link when we send it, or reply *Hi* to get started."
    ),
    "repeat_confirm": (
        "Your repeat order is ready for payment.\n\n"
        "Order ref: {order_ref}\n"
        "Token: {token_label}\n"
        "Total: INR {total:.0f}\n\n"
        "{order_preview}\n\n"
        "Tap Confirm & Pay to finish paying safely with {gateway_label}."
    ),
    "short_redirect": (
        "Please use the menu link we sent to browse and pay. Need a new link? Reply *Hi*."
    ),
    "short_redirect_repeat": (
        "Please use the menu link we sent to browse and pay. Need a new link? Reply *Hi*.\n"
        "Reply *REPEAT* to order the same items again."
    ),

    # Webcart Confirm & Pay (after cart submit)
    "webcart_confirm_header": "Confirm your order",
    "webcart_confirm_body": (
        "Your order is ready for payment.\n\n"
        "Order ref: {order_ref}\n"
        "Token: {token_label}\n"
        "Total: INR {total:.0f}\n\n"
        "{order_preview}\n\n"
        "Tap Confirm & Pay to finish paying safely with {gateway_label}."
    ),
    "webcart_confirm_button": "Confirm & Pay",
    "webcart_confirm_footer": "Safe payment with {gateway_label}",
    "webcart_confirm_fallback": (
        "Your order is ready for payment.\n"
        "Order ref: {order_ref}\n"
        "Total: INR {total:.0f}\n\n"
        "Confirm & Pay:\n"
        "{payment_link}"
    ),
    "webcart_confirm_more_items": "- +{count} more item(s)",

    # Payment reminder
    "prepay_reminder_body": (
        "Hi {name}! 👋\n\n"
        "Your {service_label} order is still waiting for payment.\n\n"
        "Tap Confirm & Pay to finish paying safely with {gateway_label}.\n\n"
        "Just a gentle reminder about your pending order. "
        "If your payment link has expired, no worries — reply "
        "*Home* (or *Hi*) and we will happily start a fresh order for you."
    ),
    "prepay_reminder_fallback": (
        "Hi {name}! 👋\n\n"
        "Your {service_label} order is still waiting for payment."
        "{pay_line}\n\n"
        "Just a gentle reminder about your pending order. "
        "If your payment link has expired, no worries — reply "
        "*Home* (or *Hi*) and we will happily start a fresh order for you."
    ),
    "prepay_reminder_header": "Payment still pending",
    "prepay_reminder_button": "Confirm & Pay",
    "prepay_reminder_footer": "Safe payment with {gateway_label}",
    "webcart_footer": "Safe payment on our online menu",

    # Abandoned cart
    "abandoned_cart_body": (
        "Hi {name}! 👋\n\n"
        "You still have items in your cart at *{store_name}*. "
        "Tap below to finish your order whenever you are ready."
    ),
    "abandoned_cart_header": "Your cart is waiting",
    "abandoned_cart_button": "Continue order",
    "abandoned_cart_footer": "One gentle reminder — we will not message again.",

    # Service picker chrome (list message body/footer/button)
    "service_menu_help": "How can we help you today?",
    "service_menu_footer": "Tap below to start ordering",
    "service_menu_button": "Select Service",
    "service_menu_ready_takeaway": (
        "Your takeaway order *{token}* is ready — pick up at the counter."
    ),
    "service_card_select": "Select",
    "service_choice_unclear": (
        "Sorry, I did not catch that. Please tap one of the options above."
    ),

    # Customer-facing service labels (display only — DB keeps English codes)
    "svc_takeaway": "Takeaway",
    "svc_delivery": "Delivery",
    "svc_dine_in": "Dine-in",
    "svc_scheduled_takeaway": "Scheduled takeaway",
    "svc_scheduled_delivery": "Scheduled delivery",
    "svc_scheduled_pickup": "Scheduled pickup",
    "svc_order": "Order",

    # Post-payment confirmation + receipt (customer copy; DB stays English)
    "payment_received": "Payment received! ✅",
    "token_line": "Token: {token}",
    "receipt_message": (
        "🧾 *Your Receipt — Token {token}*\n\n"
        "{url}\n\n"
        "⏰ _This link expires in 48 hours. Please save a copy if needed._"
    ),
    "totals_items": "Items: ₹{amount}",
    "totals_packaging": "Parcel/packaging: ₹{amount}",
    "totals_delivery": "Delivery: ₹{amount}",
    "totals_gst": "GST ({rate}%): ₹{amount}",
    "totals_total_plain": "*Total: ₹{amount}*",
    "totals_total_incl": "*Total: ₹{amount}* (incl. {parts})",
    "totals_part_packaging": "₹{amount} packaging",
    "totals_part_delivery": "₹{amount} delivery",
    "confirmed_delivery_deferred": "Your delivery order is confirmed.",
    "confirmed_takeaway_deferred": "Your takeaway order is confirmed.",
    "confirmed_generic_deferred": "Your order is confirmed.",
    "confirmed_delivery_dispatch": "Your delivery order is confirmed and we're preparing it for dispatch.",
    "confirmed_takeaway_pickup_prep": "Your order is confirmed and we're preparing it for pickup.",
    "confirmed_generic_prep": "Your order is confirmed and we're preparing it now.",
    "confirmed_kitchen_delivery": "Your delivery order is confirmed and sent to the kitchen.",
    "confirmed_kitchen_takeaway": "Your takeaway order is confirmed and sent to the kitchen.",
    "confirmed_kitchen_dinein": "Your order is confirmed and sent to the kitchen. Enjoy your meal! 🍽️",
    "confirmed_kitchen_generic": "Your order is confirmed and sent to the kitchen.",
    "confirmed_scheduled_takeaway": "Your scheduled takeaway is confirmed for *{slot}*.",
    "confirmed_scheduled_delivery": "Your scheduled delivery is confirmed for *{slot}*.",

    # Identity (name confirm) — first replies after QR greeting / language latch
    "identity_welcome_confirm": "Welcome! Are you *{name}*?",
    "identity_ask_name": "Welcome! What is your name, please?",
    "identity_type_name": "No problem! Please type your name:",
    "identity_missed_confirm": "We missed you! 😊 Is your name still *{name}*?",
    "identity_type_correct_name": "Of course! Please type your correct name:",
    # WhatsApp button titles must be ≤ 20 characters
    "identity_btn_yes": "✅ Yes, that's me",
    "identity_btn_edit": "✏️ Enter my name",
    "identity_btn_diff": "✏️ Different name",
}
