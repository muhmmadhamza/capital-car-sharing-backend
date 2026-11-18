// Unit tests for the advance-reservation rules (pure functions: no database, no network).
//   npm run test:advance:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/utils/bookingRules');

const RULES = { minHours: 4, maxDays: 30, maxAdvanceDays: 365, advanceMinHours: 24, serviceFeePercent: 0, taxPercent: 0 };
const NOW = '2026-11-18T10:00';
const win = (over = {}) => ({ pickupDate: '2026-11-25', pickupTime: '10:00', returnDate: '2026-11-28', returnTime: '10:00', ...over });

test('bookingTypeFor: exactly the minimum lead time is advance, one minute less is standard', () => {
  assert.equal(R.bookingTypeFor('2026-11-19T10:00', NOW, RULES), 'advance'); // 24 h 00 min
  assert.equal(R.bookingTypeFor('2026-11-19T09:59', NOW, RULES), 'standard'); // 23 h 59 min
  assert.equal(R.bookingTypeFor('2026-11-18T14:00', NOW, RULES), 'standard');
  assert.equal(R.bookingTypeFor('2027-06-01T10:00', NOW, RULES), 'advance');
});

test('bookingTypeFor follows the configured minimum', () => {
  assert.equal(R.bookingTypeFor('2026-11-19T10:00', NOW, { ...RULES, advanceMinHours: 48 }), 'standard');
  assert.equal(R.bookingTypeFor('2026-11-20T10:00', NOW, { ...RULES, advanceMinHours: 48 }), 'advance');
});

test('leadHours', () => {
  assert.equal(R.leadHours('2026-11-19T10:00', NOW), 24);
  assert.equal(R.leadHours('2026-11-18T09:00', NOW), -1);
});

test('validateAdvanceWindow accepts a normal future window', () => {
  assert.deepEqual(R.validateAdvanceWindow(win(), NOW, RULES), []);
});

test('validateAdvanceWindow rejects a pickup that is too soon, in the past, or malformed', () => {
  assert.match(R.validateAdvanceWindow(win({ pickupDate: '2026-11-19', pickupTime: '09:00', returnDate: '2026-11-19', returnTime: '18:00' }), NOW, RULES)[0], /at least 24 hours/);
  assert.match(R.validateAdvanceWindow(win({ pickupDate: '2026-11-10', returnDate: '2026-11-12' }), NOW, RULES)[0], /future/);
  assert.ok(R.validateAdvanceWindow(win({ pickupDate: 'tomorrow' }), NOW, RULES).length > 0);
});

test('validateAdvanceWindow keeps every ordinary rental rule', () => {
  assert.match(R.validateAdvanceWindow(win({ returnDate: '2026-11-25', returnTime: '12:00' }), NOW, RULES)[0], /start at 4 hours/);
  assert.match(R.validateAdvanceWindow(win({ returnDate: '2026-12-31' }), NOW, RULES)[0], /up to 30 days/);
  assert.match(R.validateAdvanceWindow(win({ pickupDate: '2028-01-01', returnDate: '2028-01-03' }), NOW, RULES)[0], /at most 365 days/);
});

test('validateAdvanceSearch: earliest pickup date is the date of now + minimum lead', () => {
  const s = (pickupDate, returnDate) => R.validateAdvanceSearch({ pickupDate, returnDate }, NOW, RULES);
  assert.deepEqual(s('2026-11-19', '2026-11-20'), []); // tomorrow: allowed
  assert.match(s('2026-11-18', '2026-11-20')[0], /earliest pickup date: 2026-11-19/); // today
  assert.match(s('2026-11-01', '2026-11-03')[0], /at least 24 hours/); // past
  assert.deepEqual(R.validateAdvanceSearch({ pickupDate: '2026-11-18', returnDate: '2026-11-20' }, '2026-11-17T23:00', RULES), []); // 25 h earlier: today is far enough
});

test('validateAdvanceSearch: order, format, horizon and length', () => {
  const s = (a, b, rules = RULES) => R.validateAdvanceSearch({ pickupDate: a, returnDate: b }, NOW, rules);
  assert.match(s('2026-11-25', '2026-11-24')[0], /on or after/);
  assert.match(s('25/11/2026', '2026-11-26')[0], /YYYY-MM-DD/);
  assert.match(s(undefined, '2026-11-26')[0], /YYYY-MM-DD/);
  assert.match(s('2028-01-01', '2028-01-02')[0], /at most 365 days/);
  assert.match(s('2026-12-01', '2027-01-15')[0], /up to 30 days/);
  assert.deepEqual(s('2026-12-01', '2026-12-31'), []); // exactly 30 days
});

test('BOOKING_TYPES is exactly standard and advance', () => {
  assert.deepEqual(R.BOOKING_TYPES, ['standard', 'advance']);
});

test('pricing for an advance window uses the existing price rules (daily x started days, fee, tax)', () => {
  const p = R.computePrice(100, '2026-11-25T10:00', '2026-11-28T10:00', { ...RULES, serviceFeePercent: 10, taxPercent: 5 });
  assert.equal(p.rentalDays, 3);
  assert.equal(p.subtotal, 300);
  assert.equal(p.serviceFee, 30);
  assert.equal(p.tax, 16.5);
  assert.equal(p.total, 346.5);
  assert.equal(R.computePrice(100, '2026-11-25T10:00', '2026-11-28T10:30', RULES).rentalDays, 4); // 3 days 30 min -> 4
});

test('advance does not change the status workflow', () => {
  // Same transition table for every booking type: it takes no booking type as input at all.
  assert.deepEqual(Object.keys(R.TRANSITIONS.pending).sort(), ['cancelled', 'confirmed', 'rejected']);
  assert.equal(R.checkTransition({ from: 'pending', to: 'confirmed', role: 'partner', pickupAt: '2026-11-25T10:00', now: NOW }, RULES).ok, true);
  assert.equal(R.checkTransition({ from: 'pending', to: 'confirmed', role: 'customer', pickupAt: '2026-11-25T10:00', now: NOW }, RULES).status, 403);
});
