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
    "cuisine_default": "Great food, made for you.",
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
    "lob_psl_hook": "Pizza, ice cream, and more — something for everyone.",
    "lob_food_products_hook": "Fresh baked goods and sweets, made with care. Take a look!",
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
        "Please review your repeat order before confirming.\n\n"
        "Order number: {order_ref}\n"
        "Queue number: {token_label}\n"
        "Total: ₹{total:.0f}\n\n"
        "{order_preview}\n\n"
        "Tap Confirm and Pay to complete your payment securely."
    ),
    "short_redirect": (
        "Please use the menu link we sent to browse and pay. Need a new link? Reply *Hi*."
    ),
    "short_redirect_repeat": (
        "Please use the menu link we sent to browse and pay. Need a new link? Reply *Hi*.\n"
        "Reply *REPEAT* to order the same items again."
    ),

    # Webcart Confirm & Pay (after cart submit)
    "webcart_confirm_header": "Please review your order",
    "webcart_confirm_body": (
        "Please review your order before confirming.\n\n"
        "Order number: {order_ref}\n"
        "Queue number: {token_label}\n"
        "Total: ₹{total:.0f}\n\n"
        "Items ordered:\n"
        "{order_preview}\n\n"
        "Tap Confirm and Pay to complete your payment securely."
    ),
    "webcart_confirm_button": "Confirm and Pay",
    "webcart_confirm_footer": "Secure payment with {gateway_label}",
    "webcart_confirm_fallback": (
        "Please review your order before confirming.\n"
        "Order number: {order_ref}\n"
        "Total: ₹{total:.0f}\n\n"
        "Confirm and Pay:\n"
        "{payment_link}"
    ),
    "webcart_confirm_more_items": "- +{count} more item(s)",
    "payment_final_note": "Once paid, this order cannot be changed.",
    "pay_cta_label": "Tap to pay and confirm your order:",

    # Payment reminder
    "prepay_reminder_body": (
        "Hi {name}! 👋\n\n"
        "Your {service_label} order is still waiting for payment.\n\n"
        "Tap Confirm and Pay to finish paying safely.\n\n"
        "If your payment link has expired, reply *Home* or *Hi* "
        "and we will start a fresh order for you."
    ),
    "prepay_reminder_fallback": (
        "Hi {name}! 👋\n\n"
        "Your {service_label} order is still waiting for payment."
        "{pay_line}\n\n"
        "If your payment link has expired, reply *Home* or *Hi* "
        "and we will start a fresh order for you."
    ),
    "prepay_reminder_header": "Payment still pending",
    "prepay_reminder_button": "Confirm and Pay",
    "prepay_reminder_footer": "Secure payment with {gateway_label}",
    "webcart_footer": "Secure payment on our online menu",

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
    "payment_received": "Payment received. ✅",
    "token_line": "Queue number: {token}",
    "receipt_message": (
        "Your receipt — Queue number {token}\n\n"
        "{url}\n\n"
        "This link will expire in 48 hours. Please save it if you need it later."
    ),
    "prepay_footer_kitchen": (
        "_Your order will be sent to the kitchen after payment is received._"
    ),
    "prepay_footer_shipped": (
        "_Your order will be prepared after payment is received._"
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
    "confirmed_delivery_dispatch": (
        "Your delivery order is confirmed. We are preparing it for dispatch."
    ),
    "confirmed_takeaway_pickup_prep": (
        "Your order is confirmed. We are preparing it for pickup."
    ),
    "confirmed_generic_prep": "Your order is confirmed. We are preparing it now.",
    "confirmed_kitchen_delivery": (
        "Your delivery order is confirmed and sent to the kitchen."
    ),
    "confirmed_kitchen_takeaway": (
        "Your takeaway order is confirmed and sent to the kitchen."
    ),
    "confirmed_kitchen_dinein": (
        "Your order is confirmed and sent to the kitchen.\nEnjoy your meal! 🍽️"
    ),
    "confirmed_kitchen_generic": "Your order is confirmed and sent to the kitchen.",
    "confirmed_scheduled_takeaway": (
        "Your scheduled takeaway is confirmed for *{slot}*."
    ),
    "confirmed_scheduled_delivery": (
        "Your scheduled delivery is confirmed for *{slot}*."
    ),
    "confirmed_help_delivery": (
        "Your delivery order is confirmed. We are preparing it for dispatch. "
        "Please message us if you need help."
    ),
    "confirmed_help_generic": (
        "Your order is confirmed. We are preparing it now. "
        "Please message us if you need help."
    ),

    # Dine-in / queue (warm, translation-safe; prefer "guests" over "party")
    "service_selected_dine_in": "Great! You have selected Dine-in.",
    "party_size_ask_dine_in": "How many guests are dining today?",
    "party_size_ask_retry": "No problem! How many guests will be dining today?",
    "party_size_ask_queue": "How many guests are in your group?",
    "party_size_invalid": "Please reply with the number of guests (e.g. *2* or *4*).",
    "party_size_invalid_short": "Please enter a valid number of guests (e.g. 2).",
    "table_finding_guests": (
        "Thank you! We will find a table for {n} guests. 🙏\n\n"
        "Your queue number: {token}\n\n"
        "We will send you the table details within {wait_window}."
    ),
    "table_finding_with_estimate": (
        "Thank you! We will find a table for {n} guests. 🙏\n\n"
        "Your queue number: {token}\n"
        "Estimated wait: {estimate}\n\n"
        "We will send you a message as soon as your table is ready."
    ),
    "table_finding_ready_now": (
        "Thank you! A table is available for {n} guests. 🙏\n\n"
        "Your queue number: {token}\n\n"
        "Please come to the reception — our team will seat you shortly."
    ),
    "table_finding_host": (
        "Thank you! We have noted your visit for {n} guests. 🙏\n\n"
        "Your queue number: {token}\n\n"
        "Please speak with the host. Our team will assist you shortly."
    ),
    "table_finding_still": (
        "Thank you for waiting. 🙏\n\n"
        "We are still finding your table.\n"
        "Queue number: {token}\n\n"
        "We will message you when it is ready."
    ),
    "table_ready_customer": (
        "Your table is ready! ✅\n\n"
        "Queue number: {token}\n"
        "Table: Table {table}\n\n"
        "Please proceed to your table. We look forward to serving you."
    ),
    "table_ready_browse": (
        "Your table is ready! ✅\n\n"
        "Queue number: {token}\n"
        "Table: Table {table}\n\n"
        "Browse our menu below and place your order. 🍽️"
    ),
    "table_ready_continue": (
        "Your table is ready! ✅\n\n"
        "Table: Table {table}\n\n"
        "You can continue adding items from the menu above, "
        "or type *MENU* to reopen it. 🍽️"
    ),
    "table_cancelled": (
        "Your queue number {token} has been cancelled.\n\n"
        "Reply *Home* anytime to start a new booking."
    ),
    "table_cancelled_generic": (
        "Your table request has been cancelled.\n"
        "Reply *Home* anytime to start a new booking."
    ),
    "table_confirming_guests": (
        "Thank you! We are confirming a table for {n} guests. 🙏\n\n"
        "Queue number: {token}\n\n"
        "We will send you the table details within {wait_window}."
    ),
    "table_confirming_still": (
        "Thank you for waiting. We are still confirming your table. 🙏\n\n"
        "We will message you as soon as it is ready."
    ),
    "menu_cta_dine_in_body": (
        "📍 {display}\n"
        "🍽️ Dine-in\n\n"
        "Tap below to browse our full menu, add items to your cart, "
        "and place your order."
    ),
    "menu_cta_header": "Browse our menu",
    "menu_cta_button": "View Menu",

    # Takeaway / delivery / schedule
    "delivery_need_address": (
        "🚚 *Delivery order*\n\nWe need your delivery address."
    ),
    "delivery_share_location": "📍 Please share your delivery location",
    "delivery_share_or_type": (
        "Please share your location pin, or type your full delivery address."
    ),
    "delivery_type_address": (
        "Please type your full delivery address "
        "(house no., street, area, city, pincode)."
    ),
    "delivery_confirm_address_header": "Confirm your delivery address",
    "delivery_found_addresses": (
        "We found these addresses near your location. Please choose one."
    ),
    "delivery_thank_browse": "Thank you! Browse today's menu below.",
    "schedule_pick_pickup": (
        "Hi {name}! Tap below to choose your pickup date and time."
    ),
    "schedule_pick_delivery": (
        "Hi {name}! Tap below to choose your delivery date and time."
    ),
    "schedule_slot_pickup": (
        "Got it — we will have your order ready for pickup on *{when}*."
    ),
    "schedule_slot_delivery": "Got it — we will deliver on *{when}*.",
    "schedule_confirming_time": (
        "We are confirming your preferred time.\n"
        "We will message you when you can pay."
    ),
    "schedule_waiting_confirm": (
        "⏳ We are confirming your preferred time.\n"
        "We will message you shortly."
    ),
    "eta_ready_mins": "⏱ Usually ready in {range} minutes.",
    "eta_deliver_mins": "⏱ Usually delivered in {lo} to {hi} minutes.",
    "takeaway_ready": (
        "✅ *Your takeaway order is ready!*\n\n"
        "Queue number: *{token}*\n"
        "Order: *{order}*\n\n"
        "Please pick up at the counter. Show your receipt QR when you collect."
    ),
    "delivery_ready": (
        "✅ *Your delivery order is ready!*\n\n"
        "{token_line}"
        "Order: *{order}*\n\n"
        "Your order is packed and on its way to you shortly. 🛵"
    ),
    "order_ready_dine_in": (
        "✅ *Your order is ready!*\n\n"
        "Order: *{order}*\n"
        "{table_line}\n"
        "Your food will be served at your table shortly. Enjoy! 🍽️"
    ),

    # Token / queue (style only — existing product states)
    "queue_joined": (
        "You have joined the queue at *{outlet}*. 🙏\n\n"
        "Queue number: {token}\n"
        "Guests: {n}\n\n"
        "We will send you a message as soon as we can assist you.\n"
        "Thank you for your patience."
    ),
    "queue_joined_noted": (
        "You have joined the queue at *{outlet}*. 🙏\n\n"
        "Guests: {n}\n\n"
        "We have noted your visit. Our team will assist you shortly.\n"
        "Thank you for your patience."
    ),

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
