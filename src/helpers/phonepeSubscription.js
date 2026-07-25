'use strict';

/**
 * PhonePe Pay Page (classic PG) helper for subscription checkout.
 *
 * Env:
 *   PHONEPE_MERCHANT_ID
 *   PHONEPE_SALT_KEY
 *   PHONEPE_SALT_INDEX   (default 1)
 *   PHONEPE_BASE_URL     (default https://api.phonepe.com/apis/hermes;
 *                         sandbox: https://api-preprod.phonepe.com/apis/pg-sandbox)
 *   API_PUBLIC_URL or BACKEND_PUBLIC_URL — callback host
 *   FRONTEND_URL — redirect after payment
 */

const crypto = require('crypto');

const MONTHLY_PRICE_INR = 1000;

function phonepeConfigured() {
  return Boolean(process.env.PHONEPE_MERCHANT_ID && process.env.PHONEPE_SALT_KEY);
}

function phonepeBaseUrl() {
  return (process.env.PHONEPE_BASE_URL || 'https://api.phonepe.com/apis/hermes').replace(/\/$/, '');
}

function saltIndex() {
  return String(process.env.PHONEPE_SALT_INDEX || '1');
}

function publicApiBase() {
  return (
    process.env.API_PUBLIC_URL
    || process.env.BACKEND_PUBLIC_URL
    || process.env.PUBLIC_API_URL
    || 'https://api.autom8.works'
  ).replace(/\/$/, '');
}

function frontendBase() {
  return (process.env.FRONTEND_URL || 'https://app.autom8.works').replace(/\/$/, '');
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function buildXVerify(base64Payload, path) {
  const salt = process.env.PHONEPE_SALT_KEY;
  return `${sha256(base64Payload + path + salt)}###${saltIndex()}`;
}

function verifyXVerify(base64Payload, path, xVerifyHeader) {
  if (!xVerifyHeader) return false;
  const expected = buildXVerify(base64Payload, path);
  const given = String(xVerifyHeader).trim();
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  } catch {
    return expected === given;
  }
}

function applyOfferDiscount(baseInr, offer) {
  const base = Number(baseInr) || MONTHLY_PRICE_INR;
  if (!offer) return { amountInr: base, discountInr: 0 };
  let discount = 0;
  if (offer.discount_type === 'percent') {
    discount = (base * Number(offer.discount_value)) / 100;
  } else if (offer.discount_type === 'flat') {
    discount = Number(offer.discount_value) || 0;
  }
  discount = Math.max(0, Math.min(base, discount));
  const amountInr = Math.max(1, Math.round((base - discount) * 100) / 100);
  return { amountInr, discountInr: Math.round(discount * 100) / 100 };
}

function newMerchantTxnId(restaurantId) {
  const short = String(restaurantId || 'r').replace(/-/g, '').slice(0, 8);
  return `sub_${short}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a PhonePe Pay Page session.
 * @returns {{ redirectUrl: string, merchantTransactionId: string, amountInr: number, amountPaise: number }}
 */
async function createSubscriptionPayPage({
  restaurantId,
  amountInr,
  merchantTransactionId,
}) {
  if (!phonepeConfigured()) {
    const err = new Error('PhonePe is not configured (PHONEPE_MERCHANT_ID / PHONEPE_SALT_KEY)');
    err.status = 503;
    throw err;
  }

  const amountPaise = Math.round(Number(amountInr) * 100);
  if (!Number.isFinite(amountPaise) || amountPaise < 100) {
    const err = new Error('Invalid subscription amount');
    err.status = 400;
    throw err;
  }

  const txnId = merchantTransactionId || newMerchantTxnId(restaurantId);
  const payload = {
    merchantId: process.env.PHONEPE_MERCHANT_ID,
    merchantTransactionId: txnId,
    merchantUserId: String(restaurantId).replace(/-/g, '').slice(0, 36),
    amount: amountPaise,
    redirectUrl: `${frontendBase()}/billing?payment=return&txn=${encodeURIComponent(txnId)}`,
    redirectMode: 'REDIRECT',
    callbackUrl: `${publicApiBase()}/api/subscription/phonepe/callback`,
    paymentInstrument: { type: 'PAY_PAGE' },
  };

  const base64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const path = '/pg/v1/pay';
  const xVerify = buildXVerify(base64, path);

  const res = await fetch(`${phonepeBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VERIFY': xVerify,
      Accept: 'application/json',
    },
    body: JSON.stringify({ request: base64 }),
    signal: AbortSignal.timeout(30_000),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = data?.message || data?.code || `PhonePe pay failed (${res.status})`;
    const err = new Error(msg);
    err.status = 502;
    err.phonepe = data;
    throw err;
  }

  const redirectUrl =
    data?.data?.instrumentResponse?.redirectInfo?.url
    || data?.data?.redirectUrl
    || null;

  if (!redirectUrl) {
    const err = new Error('PhonePe did not return a redirect URL');
    err.status = 502;
    err.phonepe = data;
    throw err;
  }

  return {
    redirectUrl,
    merchantTransactionId: txnId,
    amountInr: amountPaise / 100,
    amountPaise,
    raw: data,
  };
}

/**
 * Status check for a merchant transaction.
 */
async function checkPaymentStatus(merchantTransactionId) {
  if (!phonepeConfigured()) {
    const err = new Error('PhonePe is not configured');
    err.status = 503;
    throw err;
  }
  const merchantId = process.env.PHONEPE_MERCHANT_ID;
  const path = `/pg/v1/status/${merchantId}/${merchantTransactionId}`;
  const xVerify = `${sha256(path + process.env.PHONEPE_SALT_KEY)}###${saltIndex()}`;

  const res = await fetch(`${phonepeBaseUrl()}${path}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'X-VERIFY': xVerify,
      'X-MERCHANT-ID': merchantId,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  return data;
}

function isPhonePePaymentSuccess(statusPayload) {
  const code = statusPayload?.code || statusPayload?.data?.state || statusPayload?.data?.responseCode;
  const state = String(statusPayload?.data?.state || statusPayload?.code || '').toUpperCase();
  return (
    statusPayload?.success === true
    || state === 'COMPLETED'
    || state === 'PAYMENT_SUCCESS'
    || code === 'PAYMENT_SUCCESS'
  );
}

module.exports = {
  MONTHLY_PRICE_INR,
  phonepeConfigured,
  applyOfferDiscount,
  newMerchantTxnId,
  createSubscriptionPayPage,
  checkPaymentStatus,
  isPhonePePaymentSuccess,
  verifyCallbackBody(base64Response, xVerify) {
    return verifyXVerify(base64Response, '/pg/v1/status', xVerify)
      || verifyXVerify(base64Response, '', xVerify);
  },
};
