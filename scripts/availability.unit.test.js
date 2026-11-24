// Pure checks of the availability-management request rules. No database or running API needed.
//   npm run test:availability:unit
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/unit';
const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../src/validators');
const { today, expandDates } = require('../src/services/availability.service');

const plus = (n) => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const check = (body) => rules.availabilityUpdate({ body });

test('legacy { dates, status } body is still valid', () => assert.deepEqual(check({ dates: [plus(1)], status: 'unavailable' }), []));
test('today is allowed, past is refused', () => {
  assert.deepEqual(check({ dates: [today()], status: 'unavailable' }), []);
  assert.match(check({ dates: [plus(-1)], status: 'unavailable' })[0], /past/);
  assert.match(check({ startDate: plus(-1), endDate: plus(2), status: 'available' })[0], /past/);
});
test('range form', () => {
  assert.deepEqual(check({ startDate: plus(1), endDate: plus(5), status: 'unavailable', reason: 'Service' }), []);
  assert.match(check({ startDate: plus(5), endDate: plus(1), status: 'unavailable' })[0], /on or after/);
  assert.match(check({ startDate: plus(1), endDate: plus(400), status: 'unavailable' })[0], /366/);
  assert.match(check({ startDate: 'nope', endDate: plus(1), status: 'unavailable' })[0], /YYYY-MM-DD/);
});
test('dates and range together, or neither, are refused', () => {
  assert.match(check({ dates: [plus(1)], startDate: plus(1), endDate: plus(2), status: 'unavailable' })[0], /not both/);
  assert.match(check({ status: 'unavailable' })[0], /required/);
});
test('invalid dates and status are refused', () => {
  assert.ok(check({ dates: ['2031-02-30'], status: 'unavailable' }).length);
  assert.ok(check({ dates: [], status: 'unavailable' }).length);
  assert.match(check({ dates: [plus(1)], status: 'booked' })[0], /status/);
});
test('reason: only when blocking, max 200 characters, text only', () => {
  assert.deepEqual(check({ dates: [plus(1)], status: 'unavailable', reason: '  Family trip  ' }), []);
  assert.deepEqual(check({ dates: [plus(1)], status: 'available', reason: '   ' }), []);
  assert.match(check({ dates: [plus(1)], status: 'available', reason: 'x' })[0], /only be given when blocking/);
  assert.match(check({ dates: [plus(1)], status: 'unavailable', reason: 'x'.repeat(201) })[0], /200/);
  assert.match(check({ dates: [plus(1)], status: 'unavailable', reason: 5 })[0], /text/);
});
test('expandDates: inclusive range; list is de-duplicated and sorted', () => {
  assert.deepEqual(expandDates({ startDate: plus(1), endDate: plus(3) }), [plus(1), plus(2), plus(3)]);
  assert.deepEqual(expandDates({ dates: [plus(3), plus(1), plus(3)] }), [plus(1), plus(3)]);
});
