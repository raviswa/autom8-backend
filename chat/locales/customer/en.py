REPLIES = {
    # Time periods
    "period_morning": "morning",
    "period_afternoon": "afternoon",
    "period_evening": "evening",
    "period_night": "night",

    # Restaurant greeting / menu
    "greet_good_period": "Good {period} 👋",
    "greet_good_period_named": "Good {period}, {first} 👋",
    "welcome_new": "Welcome to *{display}* 🍽️",
    "welcome_back": "Welcome back to *{display}* 🍽️",
    "welcome_new_named": "Welcome, {first}! *{display}* 🍽️",
    "welcome_back_named": "Welcome back, {first}! *{display}* 🍽️",
    "cuisine_default": "Good food, your way.",
    "cuisine_veg": "Serving fresh, flavourful vegetarian food every day!",
    "cuisine_non_veg": "Serving fresh, flavourful non-vegetarian favourites every day!",
    "cuisine_asian": "Serving bold, wok-fresh Asian flavours every day!",
    "cuisine_continental": "Serving fresh, flavourful continental classics every day!",
    "cuisine_fast_food": "Serving hot, fresh comfort bites every day!",
    "menu_hook_default": "Fresh and made to order.",
    "menu_hook_veg": "Everything on our menu is 100% vegetarian.",
    "menu_hook_non_veg": "From starters to mains — all made fresh.",
    "menu_hook_asian": "Wok-fresh, every order.",
    "menu_hook_continental": "Made to order, plated with care.",
    "menu_hook_fast_food": "Fast, fresh, and exactly how you like it.",
    "menu_intro_header": "🍽️ *{display}*",
    "menu_intro_named": "Here's what's on today, {first}:\n",
    "menu_intro_cta": "Browse the menu below, pick your items, and we'll take care of the rest.",

    # Minimal LOB hooks
    "lob_psl_hook": "Pizza, ice cream & more — browse and order online.",
    "lob_food_products_hook": "Fresh bakes & treats — browse and order online.",
    "lob_retail_hook": "Shop our catalog — browse and order online.",
    "lob_cta_header_order": "Start Your Order",
    "lob_cta_header_shop": "Start Shopping",
    "lob_cta_button_order": "Browse & Order",
    "lob_cta_button_shop": "Browse Catalog",

    "welcome_returning_named": "Welcome back, {first}! *{display}* {icon}",
    "welcome_named": "Welcome, {first}! *{display}* {icon}",
    "welcome_anon": "Welcome to *{display}* {icon}",
    "welcome_browse_cta": (
        "Tap below to browse, pick items, and pay securely — all on our online menu."
    ),
    "welcome_repeat_hint": (
        "Ordered before? Reply *REPEAT* anytime to reorder your last purchase."
    ),
    "menu_link_failed": (
        "Sorry, we couldn't open the menu right now. Please try again in a moment. 🙏"
    ),
    "repeat_unavailable": (
        "We couldn't find a previous order for you at *{display}*. 🙏\n\n"
        "Tap the menu link when we send it, or reply *Hi* to get started."
    ),
    "repeat_confirm": (
        "Your repeat order is almost ready.\n\n"
        "Order ref: {order_ref}\n"
        "Token: {token_label}\n"
        "Total: INR {total:.0f}\n\n"
        "{order_preview}\n\n"
        "Tap Confirm & Pay to complete payment securely via {gateway_label}."
    ),
    "short_redirect": (
        "Browse and checkout on the menu link we sent. Need a fresh link? Reply *Hi*."
    ),
    "short_redirect_repeat": (
        "Browse and checkout on the menu link we sent. Need a fresh link? Reply *Hi*.\n"
        "Reply *REPEAT* to reorder your last purchase."
    ),

    # Payment reminder
    "prepay_reminder_body": (
        "Hi {name}! 👋\n\n"
        "Your {service_label} order is still awaiting payment.\n\n"
        "Tap Confirm & Pay to complete payment securely via {gateway_label}.\n\n"
        "Just a quick follow-up regarding your pending order! "
        "If your payment link has expired, no worries at all - just reply "
        "*Home* (or *Hi*) and we'll be happy to set up a fresh order for you."
    ),
    "prepay_reminder_fallback": (
        "Hi {name}! 👋\n\n"
        "Your {service_label} order is still awaiting payment."
        "{pay_line}\n\n"
        "Just a quick follow-up regarding your pending order! "
        "If your payment link has expired, no worries at all - just reply "
        "*Home* (or *Hi*) and we'll be happy to set up a fresh order for you."
    ),
    "prepay_reminder_header": "Payment Pending",
    "prepay_reminder_button": "Confirm & Pay",
    "prepay_reminder_footer": "Secure payment powered by {gateway_label}",
    "webcart_footer": "Secure checkout on our online menu",

    # Abandoned cart
    "abandoned_cart_body": (
        "Hi {name}! 👋\n\n"
        "You left items in your cart at *{store_name}*. "
        "Tap below to finish your order whenever you're ready."
    ),
    "abandoned_cart_header": "Your cart is waiting",
    "abandoned_cart_button": "Continue Order",
    "abandoned_cart_footer": "One gentle reminder — we won't message again.",
}
