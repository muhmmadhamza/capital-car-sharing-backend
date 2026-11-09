// Unit tests for the pure booking rules (no database, no network).
//   npm run test:reservations:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/utils/bookingRules');

const RULES = { minHours: 4, maxDays: 30, maxAdvanceDays: 365, serviceFeePercent: 0, taxPercent: 0 };
const NOW = '2026-11-08T12:00';
const ok = (over = {}) => ({ pickupDate: '2026-11-10', pickupTime: '10:00', returnDate: '2026-11-12', returnTime: '10:00', ...over });
const problems = (over, rules = RULES, now = NOW) => R.validateWindow(ok(over), now, rules);

test('rentalDays: every started 24 hours is a day, minimum one', () => {
  assert.equal(R.rentalDays('2026-11-10T10:00', '2026-11-10T14:00'), 1); // 4 hours
  assert.equal(R.rentalDays('2026-11-10T10:00', '2026-11-11T10:00'), 1); // exactly 24 h
  assert.equal(R.rentalDays('2026-11-10T10:00', '2026-11-11T10:30'), 2); // 24 h 30 min
  assert.equal(R.rentalDays('2026-11-10T10:00', '2026-11-12T10:00'), 2);
  assert.equal(R.rentalDays('2026-11-10T10:00', '2026-12-10T10:00'), 30);
});

test('validateWindow accepts a normal future rental', () => {
  assert.deepEqual(problems({}), []);
});

test('validateWindow rejects malformed dates and times', () => {
  for (const bad of [
    { pickupDate: '2026-13-01' }, { pickupDate: '2026-02-30' }, { pickupDate: '10/11/2026' }, { pickupDate: undefined },
    { returnDate: 'tomorrow' }, { pickupTime: '25:00' }, { pickupTime: '9:00' }, { returnTime: '10:60' }, { returnTime: null },
  ]) {
    assert.ok(problems(bad).length > 0, `should reject ${JSON.stringify(bad)}`);
  }
});

test('validateWindow rejects a pickup in the past, but allows "now" itself', () => {
  assert.match(problems({ pickupDate: '2026-11-08', pickupTime: '11:59', returnDate: '2026-11-09' })[0], /future/);
  assert.match(problems({ pickupDate: '2026-11-01', returnDate: '2026-11-03' })[0], /future/);
  assert.deepEqual(problems({ pickupDate: '2026-11-08', pickupTime: '12:00', returnDate: '2026-11-09' }), []);
});

test('validateWindow rejects return not after pickup', () => {
  assert.match(problems({ returnDate: '2026-11-10', returnTime: '10:00' })[0], /after pickup/); // equal
  assert.match(problems({ returnDate: '2026-11-09' })[0], /after pickup/); // earlier day
  assert.match(problems({ returnDate: '2026-11-10', returnTime: '09:00' })[0], /after pickup/); // earlier time
});

test('validateWindow enforces the minimum hours', () => {
  assert.match(problems({ returnDate: '2026-11-10', returnTime: '13:30' })[0], /4 hours/); // 3.5 h
  assert.deepEqual(problems({ returnDate: '2026-11-10', returnTime: '14:00' }), []); // exactly 4 h
});

test('validateWindow enforces the maximum days', () => {
  assert.deepEqual(problems({ returnDate: '2026-12-10' }), []); // exactly 30 days
  assert.match(problems({ returnDate: '2026-12-10', returnTime: '10:30' })[0], /30 days/); // 30 d 30 min -> 31 billable days
  assert.match(problems({ returnDate: '2027-01-30' })[0], /30 days/);
});

test('validateWindow enforces how far ahead a pickup may be', () => {
  assert.deepEqual(problems({ pickupDate: '2027-11-08', returnDate: '2027-11-10' }), []); // exactly 365 days ahead
  assert.match(problems({ pickupDate: '2027-11-09', returnDate: '2027-11-11' })[0], /365 days/);
});

test('computePrice: breakdown with no fees by default', () => {
  const p = R.computePrice(80, '2026-11-10T10:00', '2026-11-13T10:00', RULES);
  assert.deepEqual(p, { dailyPrice: 80, rentalDays: 3, subtotal: 240, serviceFee: 0, tax: 0, total: 240, serviceFeePercent: 0, taxPercent: 0 });
});

test('computePrice: cents are exact (no floating point drift)', () => {
  const p = R.computePrice(49.99, '2026-11-10T10:00', '2026-11-13T10:00', RULES);
  assert.equal(p.subtotal, 149.97);
  assert.equal(p.total, 149.97);
  const q = R.computePrice(0.1, '2026-11-10T10:00', '2026-11-13T10:00', RULES);
  assert.equal(q.subtotal, 0.3); // 0.1 * 3 would be 0.30000000000000004 in floating point
});

test('computePrice: service fee and tax, total is exactly the sum of the parts', () => {
  const rules = { ...RULES, serviceFeePercent: 5, taxPercent: 10 };
  const p = R.computePrice(49.99, '2026-11-10T10:00', '2026-11-13T10:00', rules);
  assert.equal(p.subtotal, 149.97);
  assert.equal(p.serviceFee, 7.5); // 5% of 149.97 = 7.4985 -> 7.50
  assert.equal(p.tax, 15.75); // 10% of 157.47 = 15.747 -> 15.75
  assert.equal(p.total, 173.22);
  assert.equal(Math.round((p.subtotal + p.serviceFee + p.tax) * 100), Math.round(p.total * 100));
});

test('computePrice: a 25 hour rental bills two days', () => {
  assert.equal(R.computePrice(100, '2026-11-10T10:00', '2026-11-11T11:00', RULES).total, 200);
});

test('bookingBlockedMessage explains each verification status differently', () => {
  const statuses = ['not_submitted', 'pending_review', 'rejected', 'resubmission_required'];
  const messages = statuses.map(R.bookingBlockedMessage);
  assert.equal(new Set(messages).size, 4);
  assert.match(R.bookingBlockedMessage('pending_review'), /under review/);
  assert.match(R.bookingBlockedMessage('rejected'), /rejected/);
  assert.match(R.bookingBlockedMessage('not_submitted'), /Verify your identity/);
  assert.ok(R.bookingBlockedMessage('something_new').length > 0);
});
