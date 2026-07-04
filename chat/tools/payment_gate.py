"""
tools/payment_gate.py
──────────────────────────────────
Hard server-side gate for Issue 3 (payment approval gating).

Constraint this file exists to satisfy: "Do not send any payment link (customer or
manager-triggered flow) unless token status is pending_approval -> approved and
booking status transition is validated server-side."

This is deliberately a *small, separate* module rather than an addition bolted onto
tools/payment_tools.py, since that file's full contents weren't available for review
here — keeping the gate isolated means it can be wired in without risk of clobbering
existing Razorpay integration logic in payment_tools.py.

Every code path that can end up sending a scheduled-order Razorpay link — the
manager-approval trigger (tools/scheduled_payment.py) and the customer "PAY"-reply
trigger — must call assert_token_approved_for_payment() first and handle
PaymentGateError before building/sending anything.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# Walk-in token types that require an explicit manager approval step
# (pending_approval -> takeaway) before any payment link may be sent.
_APPROVAL_GATED_TOKEN_TYPES = frozenset({"scheduled_takeaway", "scheduled_delivery"})

# Booking states that make sending a *new* payment link inappropriate.
_NON_PAYABLE_BOOKING_STATUSES = frozenset({"cancelled", "rejected"})


class PaymentGateError(Exception):
    """
    Raised when a payment link must not be sent.

    reason values used by callers to branch on user-facing messaging:
      - "token_not_approved" — scheduled token hasn't gone through manager approval
      - "booking_not_found"  — booking_id doesn't resolve to a row
      - "booking_not_payable" — booking is cancelled/rejected
      - "already_paid"       — booking is already paid; caller should show success
                                messaging instead of retrying payment
    """

    def __init__(self, reason: str, detail: str = ""):
        self.reason = reason
        self.detail = detail
        super().__init__(detail or reason)


async def assert_token_approved_for_payment(
    restaurant_id: str,
    token: dict[str, Any] | None,
    booking_id: str | None,
) -> None:
    """
    Refuses to proceed (raises PaymentGateError) unless:

      1. For scheduled_takeaway / scheduled_delivery tokens: the walk_in_tokens row
         shows the approved state (status == 'takeaway'), which is only reachable via
         the atomic `.eq('status', 'pending_approval')` conditional update in
         src/routes/tokens.js (approveScheduledDeliveryToken / approveScheduledTakeawayToken).
         A token still sitting in 'pending_approval' — or one that was rejected
         ('completed' with a rejection reason) — must never reach a payment-link send.

      2. The linked booking (if any) is not already paid, cancelled, or rejected.
         This re-validates server-side state at the moment of sending, rather than
         trusting whatever state the caller believed when it decided to trigger a
         payment send — closing the race where a manager-approval trigger and a
         customer "PAY"-reply trigger fire close together.

    Every code path that can end up building/sending a Razorpay link for a scheduled
    order must call this first. Immediate (non-scheduled) orders don't have a
    pending_approval token gate, so only the booking-status check applies to them.
    """
    token_type = (token or {}).get("type") or ""
    token_id = (token or {}).get("id")

    if token_type in _APPROVAL_GATED_TOKEN_TYPES:
        token_status = (token or {}).get("status")
        if token_status != "takeaway":
            logger.error(
                f"[payment-gate] BLOCKED token={token_id} type={token_type} "
                f"status={token_status!r} restaurant={restaurant_id} — "
                f"not in approved state (expected 'takeaway' after pending_approval "
                f"-> approved transition), refusing to send payment link"
            )
            raise PaymentGateError(
                "token_not_approved",
                f"token {token_id} status={token_status!r} is not approved",
            )

    if booking_id:
        from tools.db_tools import get_booking_with_customer

        booking = await get_booking_with_customer(booking_id)
        if not booking:
            logger.error(
                f"[payment-gate] BLOCKED booking={booking_id} not found "
                f"(token={token_id}, restaurant={restaurant_id})"
            )
            raise PaymentGateError("booking_not_found", f"booking {booking_id} not found")

        booking_status = booking.get("status")
        if booking_status in _NON_PAYABLE_BOOKING_STATUSES:
            logger.error(
                f"[payment-gate] BLOCKED booking={booking_id} status={booking_status!r} "
                f"— refusing to send payment link (token={token_id})"
            )
            raise PaymentGateError(
                "booking_not_payable",
                f"booking {booking_id} status={booking_status!r}",
            )

        if booking.get("payment_status") == "paid":
            logger.info(
                f"[payment-gate] booking={booking_id} already paid — "
                f"skip link generation, caller should show success state instead"
            )
            raise PaymentGateError("already_paid", f"booking {booking_id} already paid")

    logger.info(
        f"[payment-gate] OK token={token_id} type={token_type or 'n/a'} "
        f"booking={booking_id} restaurant={restaurant_id}"
    )