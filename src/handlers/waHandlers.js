// src/handlers/waHandlers.js
// Imported by both server.js and webhook.js — no circular dependency

const { supabaseAdmin }        = require('../config/supabase');
const { broadcastToRestaurant } = require('../websocket');

// Re-export sendWhatsAppMessage so webhook.js doesn't need server.js
async function sendWhatsAppMessage(toNumber, message, restaurantId = null) {
  // paste the full sendWhatsAppMessage body from server.js here
}

async function handleWhatsAppOrder(message, metadata) {
  // paste the full handleWhatsAppOrder body from server.js here
}

async function handleFeedbackReply(customerPhone, message, restaurantId) {
  // paste the full handleFeedbackReply body from server.js here
}

async function validateReferralCode(customerPhone, code, restaurantId) {
  // paste the full validateReferralCode body from server.js here
}

module.exports = {
  sendWhatsAppMessage,
  handleWhatsAppOrder,
  handleFeedbackReply,
  validateReferralCode,
};
