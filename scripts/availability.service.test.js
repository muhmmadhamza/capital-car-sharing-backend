// Transaction and SQL-parameter checks of availability.service with a SCRIPTED database (no PostgreSQL needed).
// They prove the logic around the database: lock order, rollback on conflict, what is written and with whose id,
// that nothing is written when a request is refused. They do NOT prove SQL semantics: for that run the
// integration scripts against PostgreSQL (npm run test:availability:manage).
//   npm run test:availability:service
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://u:p@localhost:5432/unit';
const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
let handler = () => ({ rows: [], rowCount: 0 });
const record = (via, text, params) => calls.push({ via, text: String(text).replace(/\s+/g, ' ').trim(), params });
const fakePg = {
  types: { setTypeParser() {} },
  Pool: class {
    on() {}
    async query(t, p) { record('pool', t, p); return handler(t, p); }
    async connect() {
      return {
        query: async (t, p) => { record('tx', t, p); return /^\s*(BEGIN|COMMIT|ROLLBACK)/.test(t) ? { rows: [], rowCount: 0 } : handler(t, p); },
        release() {},
      };
    }
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'pg') return fakePg;
  if (request === 'dotenv') return { config() {} };
  return load.call(this, request, ...rest);
};
const availability = require('../src/services/availability.service');
Module._load = load;

const reset = (h) => { calls.length = 0; handler = h || (() => ({ rows: [], rowCount: 0 })); };
const sql = () => calls.map((c) => c.text);
const plus = (n) => { const d = new Date(`${availability.today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isLock = (t) => /SELECT id FROM cars WHERE id = \$1 FOR UPDATE/.test(t);
const isBookedCheck = (t) => /unnest\(\$2::date\[\]\)/.test(t) && /to_char/.test(t);

test('blocking: lock the car, check bookings, then write reason + the session user, inside one transaction', async () => {
  reset((t) => (isLock(t) ? { rows: [{ id: 7 }], rowCount: 1 } : { rows: [], rowCount: 0 }));
  await availability.setCarDates(7, [plus(2), plus(1)], 'unavailable', { reason: '  Family trip ', userId: 42 });
  const s = sql();
  assert.equal(s[0], 'BEGIN');
  assert.ok(isLock(s[1]), 'car row locked first');
  assert.ok(isBookedCheck(s[2]), 'booked days checked after the lock');
  assert.match(s[3], /^INSERT INTO availability/);
  assert.equal(s[4], 'COMMIT');
  assert.deepEqual(calls[3].params, [7, [plus(2), plus(1)], 'Family trip', 42]);
});

test('blocking a range that touches a booked day: 409, rollback, nothing written', async () => {
  reset((t) => (isBookedCheck(t) ? { rows: [{ date: plus(3) }], rowCount: 1 } : { rows: [], rowCount: 0 }));
  await assert.rejects(() => availability.setCarDates(7, [plus(2), plus(3)], 'unavailable', { userId: 1 }), (e) => e.statusCode === 409 && e.message.includes(plus(3)));
  assert.ok(sql().includes('ROLLBACK'));
  assert.ok(!sql().some((t) => /^(INSERT|DELETE|UPDATE)/.test(t)), 'no write happened');
  assert.ok(!sql().includes('COMMIT'));
});

test('re-opening a booked day is refused the same way', async () => {
  reset((t) => (isBookedCheck(t) ? { rows: [{ date: plus(3) }], rowCount: 1 } : { rows: [], rowCount: 0 }));
  await assert.rejects(() => availability.setCarDates(7, [plus(3)], 'available'), (e) => e.statusCode === 409);
  assert.ok(!sql().some((t) => /^DELETE/.test(t)));
});

test('re-opening only deletes the owner\'s own blocks (never a booked row)', async () => {
  reset();
  await availability.setCarDates(7, [plus(1)], 'available', { userId: 1 });
  const del = calls.find((c) => /^DELETE FROM availability/.test(c.text));
  assert.ok(del && /status = 'unavailable'/.test(del.text) && /car_id = \$1/.test(del.text));
  assert.deepEqual(del.params, [7, [plus(1)]]);
});

test('refused before any database access: past dates, and a reason on a re-open', async () => {
  reset();
  await assert.rejects(() => availability.setCarDates(7, [plus(-1)], 'unavailable'), (e) => e.statusCode === 400 && /past/.test(e.message));
  await assert.rejects(() => availability.setCarDates(7, [plus(1)], 'available', { reason: 'x' }), (e) => e.statusCode === 400);
  assert.equal(calls.length, 0);
});

test('today is not "past"', async () => {
  reset();
  await availability.setCarDates(7, [availability.today()], 'unavailable', { userId: 1 });
  assert.ok(sql().includes('COMMIT'));
});

test('a whitespace-only reason is stored as NULL', async () => {
  reset();
  await availability.setCarDates(7, [plus(1)], 'unavailable', { reason: '   ', userId: 1 });
  assert.equal(calls.find((c) => /^INSERT INTO availability/.test(c.text)).params[2], null);
});

test('only pending and confirmed reservations hold days: cancelled/rejected/completed are not in any availability SQL', async () => {
  reset((t) => (/generate_series/.test(t) ? { rows: [{ carId: 7, date: plus(1), status: 'available' }], rowCount: 1 } : { rows: [], rowCount: 0 }));
  await availability.getCarAvailability(7, { startDate: plus(1), endDate: plus(1) });
  await availability.getTodayStatuses([7]);
  await assert.rejects(() => availability.assertRangeFree((t, p) => { record('q', t, p); return { rows: [{ date: plus(1) }] }; }, 7, plus(1), plus(2)), (e) => e.statusCode === 409);
  const all = sql().join(' ');
  assert.match(all, /r\.status IN \('pending', 'confirmed'\)/);
  assert.doesNotMatch(all, /cancelled|rejected|completed/);
});

test('public availability never reads reasons; the owner view adds blockedDetails', async () => {
  const h = (t) => {
    if (/FROM availability\s+WHERE car_id = \$1 AND status = 'unavailable'/.test(t)) return { rows: [{ date: plus(1), reason: 'Servicing', blockedAt: null }], rowCount: 1 };
    if (/generate_series/.test(t)) return { rows: [{ carId: 7, date: plus(1), status: 'unavailable' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  reset(h);
  const pub = await availability.getCarAvailability(7, { startDate: plus(1), endDate: plus(1) });
  assert.ok(!('blockedDetails' in pub) && !sql().some((t) => /reason/.test(t)));
  reset(h);
  const own = await availability.getCarAvailability(7, { startDate: plus(1), endDate: plus(1) }, { includeBlockDetails: true });
  assert.deepEqual(own.blockedDetails, [{ date: plus(1), reason: 'Servicing', blockedAt: null }]);
  assert.deepEqual(own.unavailableDates, [plus(1)]);
});

test('releaseBookedRows: clears stale booked rows of that reservation unless another live booking covers the day', async () => {
  const seen = [];
  const q = async (t, p) => { seen.push({ t: t.replace(/\s+/g, ' '), p }); return { rowCount: 2 }; };
  assert.equal(await availability.releaseBookedRows(q, 55), 2);
  assert.deepEqual(seen[0].p, [55]);
  assert.match(seen[0].t, /status = 'booked'/);
  assert.match(seen[0].t, /NOT EXISTS .*o\.status IN \('pending', 'confirmed'\)/);
});

test('expandDates', () => {
  assert.deepEqual(availability.expandDates({ startDate: plus(1), endDate: plus(3) }), [plus(1), plus(2), plus(3)]);
  assert.deepEqual(availability.expandDates({ dates: [plus(3), plus(1), plus(3)] }), [plus(1), plus(3)]);
});
