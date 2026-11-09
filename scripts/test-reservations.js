// Integration test for the reservation / booking module against the REAL database.
//   npm run migrate  ->  npm run test:reservations
//
// Exercises the actual service, controller, validator and verification-gate code (not the HTTP layer) against
// PostgreSQL, including concurrent bookings on separate connections. Creates its own users/partner/cars
// (emails rsv-test-*@example.test) and removes everything it created, also from an earlier aborted run.
// Refuses to run when NODE_ENV=production.
require('dotenv').config();
const config = require('../src/config/env');
if (config.isProduction) {
  console.error('Refusing to run the reservation tests with NODE_ENV=production.');
  process.exit(1);
}
const { query, pool } = require('../src/database/pool');
const availability = require('../src/services/availability.service');
const reservationService = require('../src/services/reservation.service');
const carService = require('../src/services/car.service');
const adminService = require('../src/services/admin.service');
const customerController = require('../src/controllers/customer.controller');
const { requireVerifiedCustomer } = require('../src/middleware/requireVerifiedCustomer');
const validate = require('../src/middleware/validate');
const rules = require('../src/validators');
const R = require('../src/utils/bookingRules');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else { failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

const today = availability.today();
const day = (n) => R.addDays(today, n);
const win = (carId, fromDay, toDay, over = {}) => ({ carId, pickupDate: day(fromDay), pickupTime: '10:00', returnDate: day(toDay), returnTime: '10:00', ...over });

// Runs a function and returns { ok, value } or { ok:false, status, message, errors }.
async function attempt(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, status: e.statusCode, message: e.message, errors: e.errors, code: e.code, raw: e }; }
}
const gate = (user) => new Promise((resolve) => requireVerifiedCustomer({ user }, {}, (err) => resolve(err || 'next')));
// Drives a controller like Express would, with a fake req/res.
async function callController(fn, req) {
  let out = { status: 200, body: undefined, error: undefined };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  await fn(req, res, (err) => { out.error = err; });
  return out;
}
// Runs a route validator exactly like the validate() middleware.
const runValidator = (rule, body) => new Promise((resolve) => validate(rule)({ body: { ...body }, params: {}, query: {} }, {}, (err) => resolve(err)));

const emailOf = (s) => `rsv-test-${s}@example.test`;

async function cleanup() {
  const { rows: users } = await query(`SELECT id FROM users WHERE email LIKE 'rsv-test-%@example.test'`);
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await query('DELETE FROM reservations WHERE customer_id = ANY($1::int[]) OR partner_id IN (SELECT id FROM partners WHERE user_id = ANY($1::int[]))', [ids]);
  await query('DELETE FROM cars WHERE partner_id IN (SELECT id FROM partners WHERE user_id = ANY($1::int[]))', [ids]);
  await query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]); // partners + verifications cascade
}

async function makeUser(slug, role = 'customer') {
  const { rows } = await query(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id, name, email, role`,
    [`Rsv ${slug}`, emailOf(slug), role]
  );
  return rows[0];
}
async function makeVerification(userId, status) {
  const reason = ['rejected', 'resubmission_required'].includes(status) ? 'Test reason' : null;
  await query(
    `INSERT INTO customer_verifications (customer_id, status, full_legal_name, date_of_birth, country, phone, document_type, review_reason, reviewed_at)
     VALUES ($1, $2, 'Test Person', '1990-01-01', 'PK', '+920000000', 'passport', $3, CASE WHEN $2 = 'pending_review' THEN NULL ELSE NOW() END)`,
    [userId, status, reason]
  );
}
async function makePartner(slug, status = 'active') {
  const user = await makeUser(slug, 'partner');
  const { rows } = await query(`INSERT INTO partners (user_id, company_name, status) VALUES ($1, 'Rsv Test Co', $2) RETURNING id`, [user.id, status]);
  return rows[0].id;
}
async function makeCar(partnerId, over = {}) {
  const c = { status: 'active', approval: 'approved', price: 80, location: 'Rsv Test City', ...over };
  const { rows } = await query(
    `INSERT INTO cars (partner_id, make, model, year, type, seats, doors, transmission, fuel_type, daily_price, location, status, approval_status)
     VALUES ($1, 'Test', 'Booking', 2022, 'Sedan', 5, 4, 'Automatic', 'Petrol', $2, $3, $4, $5) RETURNING id, partner_id, daily_price, location`,
    [partnerId, c.price, c.location, c.status, c.approval]
  );
  return rows[0];
}
const countFor = async (carId) => (await query(`SELECT COUNT(*) AS n FROM reservations WHERE car_id = $1 AND status IN ('pending','confirmed')`, [carId])).rows[0].n;

(async () => {
  await cleanup();

  const customers = {
    approved: await makeUser('approved'),
    other: await makeUser('other'),
    none: await makeUser('none'),
    pending: await makeUser('pending'),
    rejected: await makeUser('rejected'),
    resub: await makeUser('resub'),
  };
  await makeVerification(customers.approved.id, 'approved');
  await makeVerification(customers.other.id, 'approved');
  await makeVerification(customers.pending.id, 'pending_review');
  await makeVerification(customers.rejected.id, 'rejected');
  await makeVerification(customers.resub.id, 'resubmission_required');
  const partnerId = await makePartner('partner');
  const partnerUserId = (await query('SELECT user_id FROM partners WHERE id = $1', [partnerId])).rows[0].userId;
  const car = await makeCar(partnerId, { price: 80 });
  const A = customers.approved;

  // ------------------------------------------------------------------------ 1. verification gate
  section('1. Only Approved customers can book (enforced by the server)');
  check('approved customer passes the gate', (await gate({ id: A.id, role: 'customer' })) === 'next');
  for (const [label, user, status] of [
    ['not submitted', customers.none, 'not_submitted'],
    ['pending review', customers.pending, 'pending_review'],
    ['rejected', customers.rejected, 'rejected'],
    ['resubmission required', customers.resub, 'resubmission_required'],
  ]) {
    const e = await gate({ id: user.id, role: 'customer' });
    check(`${label} -> 403 with a clear reason`, e.statusCode === 403 && e.errors?.[0] === `verificationStatus:${status}` && e.message === R.bookingBlockedMessage(status), JSON.stringify([e.statusCode, e.message]));
  }
  check('partner and admin accounts are refused by the gate', (await gate({ id: partnerUserId, role: 'partner' })).statusCode === 403 && (await gate({ id: 1, role: 'admin' })).statusCode === 403);
  check('an anonymous request (no user) is refused with 401', (await gate(undefined)).statusCode === 401);

  // The routes put the gate in front of the controller (see src/routes/customer.routes.js). Prove the order from source.
  const routeSrc = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/customer.routes.js'), 'utf8');
  const createLine = routeSrc.split('\n').find((l) => /router\.post\('\/me\/reservations',/.test(l)) || '';
  check('POST /me/reservations is registered with requireVerifiedCustomer before the controller', createLine.includes('requireVerifiedCustomer') && createLine.indexOf('requireVerifiedCustomer') < createLine.indexOf('createReservation'), createLine);
  check('the router authenticates and restricts to customers before any route', /router\.use\(authenticate, authorize\('customer'\)\)/.test(routeSrc) && routeSrc.indexOf("router.use(authenticate") < routeSrc.indexOf("router.post('/me/reservations'"));

  // ------------------------------------------------------------------------ 2. quote
  section('2. Quote: availability + price breakdown, nothing created');
  const before = (await query('SELECT COUNT(*) AS n FROM reservations')).rows[0].n;
  let r = await attempt(() => reservationService.quote(A, win(car.id, 20, 23)));
  check('quote returns price from the database (3 days x 80)', r.ok && r.value.pricing.dailyPrice === 80 && r.value.pricing.rentalDays === 3 && r.value.pricing.subtotal === 240 && r.value.pricing.total === 240, JSON.stringify(r));
  check('quote reports the approved customer may book', r.ok && r.value.eligibility.canBook === true && r.value.eligibility.message === null);
  r = await attempt(() => reservationService.quote(customers.pending, win(car.id, 20, 23)));
  check('quote still prices for a pending customer but says why they cannot book', r.ok && r.value.pricing.total === 240 && r.value.eligibility.canBook === false && r.value.eligibility.verificationStatus === 'pending_review' && /under review/.test(r.value.eligibility.message));
  check('quote created no reservation', (await query('SELECT COUNT(*) AS n FROM reservations')).rows[0].n === before);

  // ------------------------------------------------------------------------ 3. create
  section('3. Create reservation');
  const created = await attempt(() => reservationService.create(A, win(car.id, 20, 23)));
  const res1 = created.value;
  check('creates a reservation', created.ok && res1.id > 0, JSON.stringify(created.message));
  check('unique reference in the expected format', /^CCS-\d{6}-[A-HJ-NP-Z2-9]{5}$/.test(res1?.bookingReference), res1?.bookingReference);
  check('stored against the signed-in customer, the car and its partner', res1.customerId === A.id && res1.carId === car.id && res1.partnerId === partnerId);
  check('pickup location comes from the car', res1.pickupLocation === car.location);
  check('dates and times stored', res1.pickupDate === day(20) && res1.pickupTime === '10:00' && res1.returnDate === day(23) && res1.returnTime === '10:00');
  check('new bookings start as pending (awaiting the partner)', res1.status === 'pending');
  check('price breakdown stored and consistent', res1.dailyPrice === 80 && res1.rentalDays === 3 && res1.subtotalAmount === 240 && res1.serviceFeeAmount === 0 && res1.taxAmount === 0 && res1.totalPrice === 240);
  check('car and partner details are joined', res1.carMake === 'Test' && res1.partnerCompanyName === 'Rsv Test Co');
  check('created/updated timestamps are set', !!res1.createdAt && !!res1.updatedAt);

  // ------------------------------------------------------------------------ 4. never trust the client
  section('4. The client cannot set price, status, customer or partner');
  const car2 = await makeCar(partnerId, { price: 120 });
  let out = await callController(customerController.createReservation, {
    user: A,
    body: { ...win(car2.id, 30, 32), totalPrice: 1, dailyPrice: 1, subtotalAmount: 1, status: 'completed', customerId: customers.other.id, partnerId: 999999, bookingReference: 'CCS-HACKED', rentalDays: 99 },
  });
  const sent = out.body?.data?.reservation;
  check('controller answers 201 and ignores the extra fields', out.status === 201 && !out.error && sent, JSON.stringify(out.error?.message));
  check('price comes from the car (2 days x 120), not the request', sent.dailyPrice === 120 && sent.rentalDays === 2 && sent.totalPrice === 240);
  check('status, customer, partner and reference are server-decided', sent.status === 'pending' && sent.customerId === A.id && sent.partnerId === partnerId && sent.bookingReference !== 'CCS-HACKED');
  const stored = (await query('SELECT daily_price, total_price, status, customer_id FROM reservations WHERE id = $1', [sent.id])).rows[0];
  check('the database row matches', stored.dailyPrice === 120 && stored.totalPrice === 240 && stored.status === 'pending' && stored.customerId === A.id);

  // ------------------------------------------------------------------------ 5. validation
  section('5. Invalid input is rejected');
  const v = (body) => runValidator(rules.reservationInput, body);
  check('validator: missing/invalid carId', (await v({ ...win(1, 20, 23), carId: 'abc' }))?.statusCode === 422 && (await v({ ...win(1, 20, 23), carId: 0 }))?.statusCode === 422 && (await v({ ...win(1, 20, 23), carId: undefined }))?.statusCode === 422);
  check('validator: bad date and time formats', (await v(win(1, 20, 23, { pickupDate: '20-11-2026' })))?.statusCode === 422 && (await v(win(1, 20, 23, { pickupTime: '25:00' })))?.statusCode === 422 && (await v(win(1, 20, 23, { returnTime: '9am' })))?.statusCode === 422 && (await v(win(1, 20, 23, { returnDate: '2026-02-30' })))?.statusCode === 422);
  check('validator: a valid body passes and carId becomes a number', (await v(win('7', 20, 23))) === undefined);
  const bad = [
    ['pickup in the past', win(car.id, -2, 3)],
    ['return before pickup', win(car.id, 25, 24)],
    ['return equal to pickup', win(car.id, 25, 25, { returnTime: '10:00' })],
    ['shorter than the minimum', win(car.id, 25, 25, { returnTime: '12:00' })],
    ['longer than the maximum', win(car.id, 25, 60)],
    ['too far in the future', win(car.id, 400, 402)],
  ];
  for (const [label, input] of bad) {
    const e = await attempt(() => reservationService.create(A, input));
    check(`service rejects ${label} -> 422`, !e.ok && e.status === 422, JSON.stringify([e.status, e.message]));
  }
  check('nothing was stored for the invalid requests', (await countFor(car.id)) === 1);
  r = await attempt(() => reservationService.create(A, win(2147483000, 40, 42)));
  check('unknown car -> 404', !r.ok && r.status === 404);

  // ------------------------------------------------------------------------ 6. unavailable cars
  section('6. Cars that cannot be booked');
  const inactive = await makeCar(partnerId, { status: 'inactive' });
  const unapproved = await makeCar(partnerId, { approval: 'pending' });
  const rejectedCar = await makeCar(partnerId, { approval: 'rejected' });
  const suspendedPartnerCar = await makeCar(await makePartner('partner-suspended', 'suspended'));
  for (const [label, c] of [['inactive', inactive], ['pending-approval', unapproved], ['rejected', rejectedCar], ['suspended partner', suspendedPartnerCar]]) {
    const e = await attempt(() => reservationService.create(A, win(c.id, 40, 42)));
    const q = await attempt(() => reservationService.quote(A, win(c.id, 40, 42)));
    check(`${label} car cannot be booked or quoted -> 404`, !e.ok && e.status === 404 && !q.ok && q.status === 404, JSON.stringify([e.status, q.status]));
  }
  const blocked = await makeCar(partnerId);
  await availability.setCarDates(blocked.id, [day(41)], 'unavailable');
  r = await attempt(() => reservationService.create(A, win(blocked.id, 40, 42)));
  check('a day blocked by the owner -> 409', !r.ok && r.status === 409 && r.message.includes(day(41)), JSON.stringify([r.status, r.message]));
  r = await attempt(() => reservationService.quote(A, win(blocked.id, 40, 42)));
  check('quote reports the same conflict -> 409', !r.ok && r.status === 409);

  // ------------------------------------------------------------------------ 7. overlaps
  section('7. Overlapping bookings are rejected (existing booking: day+20 to day+23)');
  const cases = [
    ['identical dates', 20, 23, false], ['starts inside', 22, 26, false], ['ends inside', 17, 21, false],
    ['fully inside', 21, 22, false], ['fully contains it', 18, 26, false], ['touches the first day', 17, 20, false],
    ['touches the last day', 23, 26, false], ['entirely before', 15, 18, true], ['starts the day after', 24, 27, true],
  ];
  for (const [label, a, b, allowed] of cases) {
    const e = await attempt(() => reservationService.create(customers.other, win(car.id, a, b)));
    check(`${label} -> ${allowed ? 'allowed' : '409'}`, allowed ? e.ok : (!e.ok && e.status === 409), JSON.stringify([e.status, e.message]));
  }
  r = await attempt(() => reservationService.create(A, win(car.id, 20, 23)));
  check('the same customer cannot double-book either -> 409', !r.ok && r.status === 409);
  r = await attempt(() => availability.setCarDates(car.id, [day(21)], 'unavailable'));
  check('the owner cannot block a booked day -> 409', !r.ok && r.status === 409);
  const cal = await availability.getCarAvailability(car.id, { startDate: day(19), endDate: day(24) });
  check('the availability calendar reports the booked days', [20, 21, 22, 23].every((n) => cal.bookedDates.includes(day(n))) && !cal.bookedDates.includes(day(19)));
  const search = await carService.searchCars({ pickupDate: day(21), returnDate: day(22), limit: 50 });
  check('car search no longer lists the booked car for those dates', !search.cars.some((c) => c.id === car.id));

  // ------------------------------------------------------------------------ 8. cancelled frees dates
  section('8. A cancelled reservation releases its dates');
  await query(`UPDATE reservations SET status = 'cancelled' WHERE id = $1`, [res1.id]);
  r = await attempt(() => reservationService.create(customers.other, win(car.id, 20, 23)));
  check('the same dates can be booked after cancellation', r.ok, JSON.stringify([r.status, r.message]));

  // ------------------------------------------------------------------------ 9. concurrency
  section('9. Concurrency: simultaneous bookings never double-book');
  const racers = [];
  for (let i = 0; i < 8; i += 1) { const u = await makeUser(`racer${i}`); await makeVerification(u.id, 'approved'); racers.push(u); }
  const raceCar = await makeCar(partnerId);
  const results = await Promise.all(racers.map((u) => attempt(() => reservationService.create(u, win(raceCar.id, 50, 53)))));
  const wins = results.filter((x) => x.ok);
  const losses = results.filter((x) => !x.ok);
  check('8 customers race for the same car and dates: exactly 1 wins', wins.length === 1, `wins=${wins.length}`);
  check('the other 7 get 409 (not a 500)', losses.length === 7 && losses.every((x) => x.status === 409), JSON.stringify(losses.map((x) => x.status)));
  check('the database holds exactly 1 active reservation for that car', (await countFor(raceCar.id)) === 1);

  const raceCar2 = await makeCar(partnerId);
  const staggered = [[60, 63], [62, 65], [64, 67], [66, 69], [61, 62], [68, 70]];
  const res2 = await Promise.all(staggered.map(([a, b], i) => attempt(() => reservationService.create(racers[i], win(raceCar2.id, a, b)))));
  const okRanges = staggered.filter((_, i) => res2[i].ok);
  const overlap = (x, y) => x[0] <= y[1] && y[0] <= x[1];
  let clash = false;
  for (let i = 0; i < okRanges.length; i += 1) for (let j = i + 1; j < okRanges.length; j += 1) if (overlap(okRanges[i], okRanges[j])) clash = true;
  check('overlapping-but-different windows racing: accepted ones never overlap', !clash && okRanges.length >= 1, JSON.stringify(okRanges));
  check('every refused one was a clean 409', res2.every((x) => x.ok || x.status === 409));

  const raceCar3 = await makeCar(partnerId);
  const mixed = await Promise.all([
    attempt(() => reservationService.create(racers[0], win(raceCar3.id, 70, 72))),
    attempt(() => availability.setCarDates(raceCar3.id, [day(70), day(71), day(72)], 'unavailable')),
  ]);
  const hasRes = (await countFor(raceCar3.id)) === 1;
  const hasBlock = (await query(`SELECT COUNT(*) AS n FROM availability WHERE car_id = $1 AND status = 'unavailable'`, [raceCar3.id])).rows[0].n > 0;
  check('a customer booking and an owner block racing: exactly one wins, never both', hasRes !== hasBlock && mixed.filter((x) => x.ok).length === 1, JSON.stringify({ hasRes, hasBlock }));

  // ------------------------------------------------------------------------ 10. database guard
  section('10. PostgreSQL itself refuses overlapping reservations');
  const guarded = (await query(`SELECT 1 FROM pg_constraint WHERE conname = 'reservations_no_overlap'`)).rowCount === 1;
  check('reservations_no_overlap constraint exists', guarded);
  if (guarded) {
    const raw = await attempt(() => query(
      `INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, return_date, status, daily_price, rental_days, subtotal_amount, total_price)
       VALUES ($1, $2, $3, 'x', $4, $5, 'pending', 80, 2, 160, 160)`,
      [A.id, partnerId, raceCar.id, day(51), day(52)]
    ));
    check('a raw INSERT that bypasses the API is refused by the database (23P01)', !raw.ok && raw.raw.code === '23P01', JSON.stringify(raw.message));
  }
  const badTotal = await attempt(() => query(
    `INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, return_date, status, daily_price, rental_days, subtotal_amount, total_price)
     VALUES ($1, $2, $3, 'x', $4, $5, 'cancelled', 80, 2, 160, 999)`,
    [A.id, partnerId, car.id, day(80), day(81)]
  ));
  check('a total that is not subtotal+fee+tax is refused (CHECK)', !badTotal.ok && badTotal.raw.code === '23514');
  const badTimes = await attempt(() => query(
    `INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, pickup_time, return_date, return_time, status, daily_price, rental_days, subtotal_amount, total_price)
     VALUES ($1, $2, $3, 'x', $4, '10:00', $4, '09:00', 'cancelled', 80, 1, 80, 80)`,
    [A.id, partnerId, car.id, day(82)]
  ));
  check('return time before pickup time on the same day is refused (CHECK)', !badTimes.ok && badTimes.raw.code === '23514');

  // ------------------------------------------------------------------------ 11. reference retry
  section('11. A booking-reference collision is retried, not surfaced as an error');
  const original = (await query(`SELECT pg_get_functiondef('generate_booking_reference'::regproc) AS def`)).rows[0].def;
  await query(`DROP SEQUENCE IF EXISTS rsv_test_collide`);
  await query(`CREATE SEQUENCE rsv_test_collide`);
  await query(`INSERT INTO reservations (booking_reference, customer_id, partner_id, car_id, pickup_location, pickup_date, pickup_time, return_date, return_time, status, daily_price, rental_days, subtotal_amount, total_price)
               VALUES ('CCS-TESTDUP', $1, $2, $3, 'x', $4, '08:00', $5, '12:00', 'cancelled', 80, 1, 80, 80)`, [A.id, partnerId, car.id, day(90), day(90)]);
  // The first two generated references collide with the row above; the third is a normal random one.
  await query(`CREATE OR REPLACE FUNCTION generate_booking_reference() RETURNS VARCHAR AS $f$
               BEGIN
                 IF nextval('rsv_test_collide') <= 2 THEN RETURN 'CCS-TESTDUP'; END IF;
                 RETURN 'CCS-OK-' || substr(md5(random()::text), 1, 5);
               END $f$ LANGUAGE plpgsql`);
  let retried;
  try {
    retried = await attempt(() => reservationService.create(A, win(raceCar.id, 100, 101)));
  } finally {
    await query(original); // restore the real generator
    await query('DROP SEQUENCE rsv_test_collide');
  }
  check('two collisions are retried and the third attempt succeeds', retried.ok && /^CCS-OK-/.test(retried.value.bookingReference), JSON.stringify([retried.message, retried.value?.bookingReference]));
  check('only one reservation was created for that retry', (await query(`SELECT COUNT(*) AS n FROM reservations WHERE car_id = $1 AND pickup_date = $2`, [raceCar.id, day(100)])).rows[0].n === 1);
  const restored = await attempt(() => reservationService.create(A, win(raceCar.id, 105, 106)));
  check('the real reference generator is restored', restored.ok && /^CCS-\d{6}-[A-HJ-NP-Z2-9]{5}$/.test(restored.value.bookingReference), restored.value?.bookingReference);

  // ------------------------------------------------------------------------ 12. reading
  section('12. Customers only see their own reservations');
  const mine = await reservationService.listForCustomer(A.id);
  check('list contains only my reservations', mine.length > 0 && mine.every((x) => x.customerId === A.id));
  check('list rows carry reference, times, breakdown and car info', ['bookingReference', 'pickupTime', 'returnTime', 'rentalDays', 'subtotalAmount', 'serviceFeeAmount', 'taxAmount', 'totalPrice', 'carMake', 'partnerCompanyName'].every((k) => k in mine[0]));
  const onlyCancelled = await reservationService.listForCustomer(A.id, { status: 'cancelled' });
  check('status filter works', onlyCancelled.length > 0 && onlyCancelled.every((x) => x.status === 'cancelled'));
  r = await attempt(() => reservationService.getForCustomer(A.id, res1.id));
  check('I can open my own reservation', r.ok && r.value.bookingReference === res1.bookingReference);
  r = await attempt(() => reservationService.getForCustomer(customers.pending.id, res1.id));
  check("someone else's reservation answers 404 (not 403, nothing leaks)", !r.ok && r.status === 404);
  out = await callController(customerController.getReservation, { user: customers.pending, params: { id: String(res1.id) } });
  check('controller: GET someone else\'s reservation -> 404 error', out.error?.statusCode === 404);
  out = await callController(customerController.getReservations, { user: A, query: {} });
  check('controller: list returns { reservations }', Array.isArray(out.body?.data?.reservations) && out.body.data.reservations.length === mine.length);

  // ------------------------------------------------------------------------ 13. existing modules unaffected
  section('13. Existing admin queries still work with the extended table');
  const dash = await attempt(() => adminService.dashboard());
  check('admin dashboard query still runs', dash.ok && dash.value.stats.totalReservations > 0, JSON.stringify(dash.message));
  const adminList = await attempt(() => adminService.listReservations({ limit: 5 }));
  check('admin reservations list still runs', adminList.ok && adminList.value.reservations.length > 0, JSON.stringify(adminList.message));
})()
  .catch((err) => { failures.push(`UNEXPECTED ERROR: ${err.stack || err}`); console.error(err); })
  .finally(async () => {
    try { await cleanup(); } catch (e) { console.error('cleanup failed:', e.message); }
    await pool.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
  });
