// Booking rules. Read from the environment ONLY here, so the pricing/validation code stays pure and testable.
// Keep minHours / maxDays equal to RENTAL_RULES in the frontend (src/features/availability/rules.ts); the API is the
// authority and the frontend only mirrors them for a faster hint.

const number = (name, fallback, { min = 0, max = Infinity } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max} (got "${raw}")`);
  return n;
};

module.exports = {
  // Shortest and longest rental.
  minHours: number('BOOKING_MIN_HOURS', 4, { min: 1, max: 24 }),
  maxDays: number('BOOKING_MAX_DAYS', 30, { min: 1, max: 366 }),
  // How far ahead a pickup may be.
  maxAdvanceDays: number('BOOKING_MAX_ADVANCE_DAYS', 365, { min: 1, max: 730 }),
  // Customer cancellation: a PENDING booking can be cancelled any time before pickup; a CONFIRMED one up to this many
  // hours before pickup. Set 0 to allow cancelling right up to pickup. No fees or refunds are modelled (no payments yet).
  cancelMinHours: number('BOOKING_CANCEL_MIN_HOURS', 24, { min: 0, max: 720 }),
  // Percentages applied on top of the rental subtotal. Default 0: nothing is charged that the business has not defined.
  // The tax is applied to (subtotal + service fee).
  serviceFeePercent: number('BOOKING_SERVICE_FEE_PERCENT', 0, { max: 100 }),
  taxPercent: number('BOOKING_TAX_PERCENT', 0, { max: 100 }),
};
