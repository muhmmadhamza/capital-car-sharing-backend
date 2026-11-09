// Pure booking rules: no database, no config import, no clock. Everything is passed in, so it is unit-testable.
//
// Times are WALL-CLOCK in the business time zone ("YYYY-MM-DDTHH:mm", no offset), the same convention as the
// frontend (src/lib/date.ts). They are compared as strings or parsed as UTC, so results never depend on the
// server's own time zone or on daylight saving.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const isDateString = (v) => {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const isTimeString = (v) => typeof v === 'string' && TIME_RE.test(v);

const parseWall = (value) => new Date(`${value}:00Z`);
const wall = (date, time) => `${date}T${time}`;

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Billable days: every started 24 hours counts as a day, minimum one (same as the frontend's rentalDays()).
const rentalDays = (pickupAt, returnAt) =>
  Math.max(1, Math.ceil((parseWall(returnAt) - parseWall(pickupAt)) / DAY_MS));

/**
 * Why a requested rental window is not acceptable, as a list of messages (empty = acceptable).
 * `now` is the current wall-clock time in the business time zone ("YYYY-MM-DDTHH:mm").
 */
function validateWindow({ pickupDate, pickupTime, returnDate, returnTime }, now, rules) {
  const errors = [];
  if (!isDateString(pickupDate)) errors.push('Pickup date must be a valid date (YYYY-MM-DD)');
  if (!isTimeString(pickupTime)) errors.push('Pickup time must be a valid time (HH:mm)');
  if (!isDateString(returnDate)) errors.push('Return date must be a valid date (YYYY-MM-DD)');
  if (!isTimeString(returnTime)) errors.push('Return time must be a valid time (HH:mm)');
  if (errors.length) return errors;

  const pickupAt = wall(pickupDate, pickupTime);
  const returnAt = wall(returnDate, returnTime);

  if (pickupAt < now) return ['Pickup must be in the future'];
  if (returnAt <= pickupAt) return ['Return must be after pickup'];

  const hours = (parseWall(returnAt) - parseWall(pickupAt)) / HOUR_MS;
  if (hours < rules.minHours) return [`Rentals start at ${rules.minHours} hours`];
  if (rentalDays(pickupAt, returnAt) > rules.maxDays) return [`Rentals can be up to ${rules.maxDays} days`];
  if (pickupDate > addDays(now.slice(0, 10), rules.maxAdvanceDays)) {
    return [`Pickup can be at most ${rules.maxAdvanceDays} days from today`];
  }
  return [];
}

// Money is computed in integer cents so 0.1 + 0.2 style float errors can never reach the database.
const toCents = (amount) => Math.round(Number(amount) * 100);
const fromCents = (cents) => cents / 100;
const percentOf = (cents, percent) => Math.round((cents * percent) / 100);

/**
 * Price breakdown from the car's stored daily price (never from the client).
 * total = subtotal + service fee + tax, exactly (the database CHECKs the same identity).
 */
function computePrice(dailyPrice, pickupAt, returnAt, rules) {
  const days = rentalDays(pickupAt, returnAt);
  const daily = toCents(dailyPrice);
  const subtotal = daily * days;
  const serviceFee = percentOf(subtotal, rules.serviceFeePercent);
  const tax = percentOf(subtotal + serviceFee, rules.taxPercent);
  return {
    dailyPrice: fromCents(daily),
    rentalDays: days,
    subtotal: fromCents(subtotal),
    serviceFee: fromCents(serviceFee),
    tax: fromCents(tax),
    total: fromCents(subtotal + serviceFee + tax),
    serviceFeePercent: rules.serviceFeePercent,
    taxPercent: rules.taxPercent,
  };
}

// ------------------------------------------------------------------------------------------ status workflow
// from -> to -> the roles allowed to make that change. Anything not listed is an invalid transition.
const TRANSITIONS = {
  pending: { confirmed: ['partner', 'admin'], rejected: ['partner', 'admin'], cancelled: ['customer', 'admin'] },
  confirmed: { completed: ['partner', 'admin'], cancelled: ['customer', 'admin'] },
  completed: {},
  cancelled: {},
  rejected: {},
};
const STATUSES = Object.keys(TRANSITIONS);
const HOLDING = ['pending', 'confirmed'];
const REASON_MAX = 500;

/**
 * Whether `role` may move a booking from `from` to `to` right now.
 * Returns { ok: true } or { ok: false, status, message } (status = the HTTP status to answer with).
 * `pickupAt` / `now` are wall-clock ("YYYY-MM-DDTHH:mm") in the business time zone.
 */
function checkTransition({ from, to, role, pickupAt, now, reason }, rules) {
  const next = TRANSITIONS[from] && TRANSITIONS[from][to];
  if (!next) {
    const label = { completed: 'completed', cancelled: 'cancelled', rejected: 'rejected' }[from];
    return { ok: false, status: 409, message: label ? `This booking is already ${label} and can no longer be changed` : `A ${from} booking cannot become ${to}` };
  }
  if (!next.includes(role)) return { ok: false, status: 403, message: `You are not allowed to mark a ${from} booking as ${to}` };

  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length > REASON_MAX) return { ok: false, status: 422, message: `The reason can be at most ${REASON_MAX} characters` };
  if (to === 'rejected' && text.length < 3) return { ok: false, status: 422, message: 'Please give the customer a reason for rejecting the booking' };
  if (to === 'cancelled' && role === 'admin' && text.length < 3) return { ok: false, status: 422, message: 'Please give a reason for cancelling the booking' };

  if (to === 'completed' && pickupAt > now) return { ok: false, status: 409, message: 'A booking can only be completed once its pickup time has passed' };
  if (to === 'confirmed' && pickupAt < now) return { ok: false, status: 409, message: 'The pickup time has already passed, so this booking can no longer be approved' };
  if (to === 'cancelled' && role === 'customer') {
    if (pickupAt <= now) return { ok: false, status: 409, message: 'This booking has already started and can no longer be cancelled' };
    const hours = (parseWall(pickupAt) - parseWall(now)) / HOUR_MS;
    if (from === 'confirmed' && hours < rules.cancelMinHours) {
      return { ok: false, status: 409, message: `Confirmed bookings can be cancelled until ${rules.cancelMinHours} hours before pickup` };
    }
  }
  return { ok: true };
}

/** Can this customer cancel right now? Same rules as checkTransition, for showing the button. */
const customerCanCancel = (booking, now, rules) =>
  checkTransition({ from: booking.status, to: 'cancelled', role: 'customer', pickupAt: booking.pickupAt, now }, rules).ok;

// Why booking is blocked for a customer whose verification is not approved. Shown to the customer as-is.
const BLOCKED_MESSAGES = {
  not_submitted: 'Verify your identity before booking. Upload your documents on the Verification page and we will review them.',
  pending_review: 'Your identity verification is still under review. You can book as soon as it has been approved.',
  rejected: 'Your identity verification was rejected, so you cannot book yet. Open the Verification page to see why and submit it again.',
  resubmission_required: 'We need more information for your identity verification before you can book. Open the Verification page and resubmit.',
};
const bookingBlockedMessage = (status) =>
  BLOCKED_MESSAGES[status] || 'Your identity must be verified and approved before you can book.';

module.exports = { TRANSITIONS, STATUSES, HOLDING, REASON_MAX, checkTransition, customerCanCancel, bookingBlockedMessage, isDateString, isTimeString, wall, addDays, rentalDays, validateWindow, computePrice };
