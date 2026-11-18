// Integration test for the Advance Reservation module, against the REAL database.
//   npm run migrate  ->  npm run test:advance
//
// Drives the real services, controllers, validators and auth middleware (not the HTTP layer), like test:workflow.
// Creates its own data (emails adv-test-*@example.test) and removes everything it created.
// Refuses to run with NODE_ENV=production.
require('dotenv').config();
const config = require('../src/config/env');
if (config.isProduction) {
  console.error('Refusing to run the advance reservation tests with NODE_ENV=production.');
  process.exit(1);
}
const fs = require('fs');
const path = require('path');
const { query, pool } = require('../src/database/pool');
const availability = require('../src/services/availability.service');
const carService = require('../src/services/car.service');
const svc = require('../src/services/reservation.service');
const adminService = require('../src/services/admin.service');
const customerCtl = require('../src/controllers/customer.controller');
const partnerCtl = require('../src/controllers/partner.controller');
const adminCtl = require('../src/controllers/admin.controller');
const { authenticate, authorize, requirePartner } = require('../src/middleware/auth');
const { requireVerifiedCustomer } = require('../src/middleware/requireVerifiedCustomer');
const { signToken } = require('../src/utils/token');
const validate = require('../src/middleware/validate');
const rules = require('../src/validators');
const R = require('../src/utils/bookingRules');
const bookingConfig = require('../src/config/booking');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else { failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);
const today = availability.today();
const day = (n) => R.addDays(today, n);
const win = (carId, a, b, over = {}) => ({ carId, pickupDate: day(a), pickupTime: '10:00', returnDate: day(b), returnTime: '10:00', ...over });
const CITY = 'ADV Test City';

async function attempt(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, status: e.statusCode, message: e.message, errors: e.errors, raw: e }; }
}
async function run(handler, req) { // drives an express handler / middleware element
  const out = { status: 200, body: undefined, error: undefined, nexted: false };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const r = handler(req, res, (err) => { out.error = err; out.nexted = !err; finish(); });
    Promise.resolve(r).then(finish, finish);
    setTimeout(finish, 300);
  });
  return out;
}
const runValidator = (rule, req) => new Promise((resolve) => validate(rule)({ body: {}, params: {}, query: {}, ...req }, {}, (err) => resolve(err)));
const plusHours = (h) => {
  const d = new Date(`${svc.nowWall()}:00Z`); d.setUTCMinutes(d.getUTCMinutes() + Math.round(h * 60));
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};

async function cleanup() {
  const { rows } = await query(`SELECT id FROM users WHERE email LIKE 'adv-test-%@example.test'`);
  const ids = rows.map((u) => u.id);
  if (!ids.length) return;
  await query('DELETE FROM reservations WHERE customer_id = ANY($1::int[]) OR partner_id IN (SELECT id FROM partners WHERE user_id = ANY($1::int[]))', [ids]);
  await query('DELETE FROM cars WHERE partner_id IN (SELECT id FROM partners WHERE user_id = ANY($1::int[]))', [ids]);
  await query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
}
const makeUser = async (slug, role = 'customer') =>
  (await query(`INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id, name, email, role, status`, [`ADV ${slug}`, `adv-test-${slug}@example.test`, role])).rows[0];
async function makeCustomer(slug, verification = 'approved') {
  const u = await makeUser(slug);
  if (verification) {
    const reason = ['rejected', 'resubmission_required'].includes(verification) ? 'Document unreadable' : null;
    await query(
      `INSERT INTO customer_verifications (customer_id, status, full_legal_name, date_of_birth, country, phone, document_type, review_reason, reviewed_at)
       VALUES ($1, $2::varchar, 'Test Person', '1990-01-01', 'PK', '+920000000', 'passport', $3, CASE WHEN $2::varchar = 'pending_review' THEN NULL ELSE NOW() END)`,
      [u.id, verification, reason]);
  }
  return u;
}
async function makePartner(slug, status = 'active') {
  const user = await makeUser(slug, 'partner');
  const p = (await query(`INSERT INTO partners (user_id, company_name, status) VALUES ($1, $2, $3) RETURNING id`, [user.id, `ADV ${slug} Co`, status])).rows[0];
  return { user, partnerId: p.id, actor: { id: user.id, role: 'partner', partnerId: p.id } };
}
const makeCar = async (partnerId, over = {}) => {
  const o = { status: 'active', approval: 'approved', price: 100, ...over };
  return (await query(
    `INSERT INTO cars (partner_id, make, model, year, type, seats, doors, transmission, fuel_type, daily_price, location, status, approval_status)
     VALUES ($1, 'Test', 'Advance', 2022, 'Sedan', 5, 4, 'Automatic', 'Petrol', $2, $3, $4, $5) RETURNING id, partner_id`,
    [partnerId, o.price, CITY, o.status, o.approval])).rows[0];
};
// Inserts a booking directly (exact times the API would refuse, e.g. a pickup that is soon).
async function rawBooking({ customer, partner, car, status = 'pending', pickupDate, pickupTime = '10:00', returnDate, returnTime = '10:00', bookingType = 'standard' }) {
  const r = await query(
    `INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, pickup_time, return_date, return_time, status, daily_price, rental_days, subtotal_amount, total_price, booking_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 100, 1, 100, 100, $10) RETURNING id`,
    [customer.id, partner, car.id, CITY, pickupDate, pickupTime, returnDate, returnTime, status, bookingType]);
  await query(`INSERT INTO reservation_status_history (reservation_id, from_status, to_status, changed_by, changed_by_role) VALUES ($1, NULL, $2, $3, 'customer')`, [r.rows[0].id, status, customer.id]);
  return r.rows[0].id;
}
const statusOf = async (id) => (await query('SELECT status FROM reservations WHERE id = $1', [id])).rows[0].status;
const typeOf = async (id) => (await query('SELECT booking_type FROM reservations WHERE id = $1', [id])).rows[0].bookingType;
const searchIds = async (carsArg) => (await carService.searchCars({ location: CITY, limit: 50, ...carsArg })).cars.map((c) => c.id);

(async () => {
  await cleanup();
  const cust = await makeCustomer('cust');
  const cust2 = await makeCustomer('cust2');
  const admin = await makeUser('admin', 'admin');
  const adminActor = { id: admin.id, role: 'admin' };
  const P1 = await makePartner('p1');
  const P2 = await makePartner('p2');
  const PS = await makePartner('psusp', 'suspended');
  const car1 = await makeCar(P1.partnerId, { price: 100 });
  const car2 = await makeCar(P2.partnerId, { price: 80 });

  // ------------------------------------------------------------------ 1. reserving future dates
  section('1. Customers can reserve cars for future dates');
  const a1 = await svc.create(cust, win(car1.id, 10, 13));
  check('a reservation 10 days ahead is created', a1.status === 'pending' && a1.pickupDate === day(10) && a1.returnDate === day(13));
  check('it is stored as an ADVANCE reservation', a1.bookingType === 'advance' && (await typeOf(a1.id)) === 'advance');
  check('it lives in the existing reservations table (same row, same id space)', (await query('SELECT COUNT(*) AS n FROM reservations WHERE id = $1', [a1.id])).rows[0].n === 1);
  const farDay = 300;
  const a2 = await svc.create(cust, win(car2.id, farDay, farDay + 2));
  check('a reservation 300 days ahead (inside the 365-day horizon) works', a2.bookingType === 'advance' && a2.pickupDate === day(farDay));
  const soon = plusHours(5);
  const s1 = await svc.create(cust, { carId: car2.id, pickupDate: soon.date, pickupTime: soon.time, returnDate: plusHours(10).date, returnTime: plusHours(10).time });
  check('a pickup a few hours away is a STANDARD booking (unchanged behaviour)', s1.bookingType === 'standard');
  const near = plusHours(30);
  const ret30 = plusHours(36);
  const s2 = await svc.create(cust2, { carId: car1.id, pickupDate: near.date, pickupTime: near.time, returnDate: ret30.date, returnTime: ret30.time });
  check('a pickup 30 hours away is ADVANCE (>= 24 h minimum)', s2.bookingType === 'advance');

  // ------------------------------------------------------------------ 2. server-side rules
  section('2. The server decides and enforces the advance rules');
  const tooSoon = plusHours(10);
  const insist = await attempt(() => svc.create(cust, { carId: car2.id, pickupDate: tooSoon.date, pickupTime: tooSoon.time, returnDate: plusHours(16).date, returnTime: plusHours(16).time, bookingType: 'advance' }));
  check('insisting on "advance" for a pickup 10 h away is refused (422)', !insist.ok && insist.status === 422 && /at least 24 hours/.test(insist.message), JSON.stringify([insist.status, insist.message]));
  const insistQuote = await attempt(() => svc.quote(cust, { carId: car2.id, pickupDate: tooSoon.date, pickupTime: tooSoon.time, returnDate: plusHours(16).date, returnTime: plusHours(16).time, bookingType: 'advance' }));
  check('the quote refuses it the same way (422)', !insistQuote.ok && insistQuote.status === 422);
  check('past pickup refused (422)', (await attempt(() => svc.create(cust, win(car2.id, -3, -1, { bookingType: 'advance' })))).status === 422);
  check('pickup beyond the 365-day horizon refused (422)', (await attempt(() => svc.create(cust, win(car2.id, 400, 402)))).status === 422);
  check('return before pickup refused (422)', (await attempt(() => svc.create(cust, win(car2.id, 40, 39)))).status === 422);
  check('longer than the maximum rental refused (422)', (await attempt(() => svc.create(cust, win(car2.id, 40, 40 + bookingConfig.maxDays + 3)))).status === 422);
  check('malformed dates refused by the validator (422)', (await runValidator(rules.reservationInput, { body: { carId: car2.id, pickupDate: 'next friday', pickupTime: '10:00', returnDate: day(41), returnTime: '10:00' } }))?.statusCode === 422);
  check('an unknown bookingType refused by the validator (422)', (await runValidator(rules.reservationInput, { body: { ...win(car2.id, 40, 42), bookingType: 'vip' } }))?.statusCode === 422);
  check('bookingType "advance" and "standard" pass the validator', (await runValidator(rules.reservationInput, { body: { ...win(car2.id, 40, 42), bookingType: 'advance' } })) === undefined && (await runValidator(rules.reservationInput, { body: { ...win(car2.id, 40, 42), bookingType: 'standard' } })) === undefined);
  const forged = await svc.create(cust, { ...win(car2.id, 50, 52), bookingType: 'standard' });
  check('a client saying "standard" for a far-ahead pickup cannot change the stored type', forged.bookingType === 'advance');
  const viaCtl = await run(customerCtl.createReservation, { user: cust, body: { ...win(car2.id, 60, 62), bookingType: 'advance', totalPrice: 1, status: 'confirmed', customerId: cust2.id, bookingReference: 'CCS-HACK' } });
  const ctlRow = viaCtl.body?.data?.reservation || viaCtl.body?.reservation;
  check('controller: price, status, customerId and reference sent by the client are ignored', !!ctlRow && ctlRow.status === 'pending' && ctlRow.customerId === cust.id && ctlRow.totalPrice === 160 && ctlRow.bookingReference !== 'CCS-HACK', JSON.stringify(viaCtl.error?.message || viaCtl.body));

  // ------------------------------------------------------------------ 3. search
  section('3. Available cars for selected future dates');
  const carFree = await makeCar(P1.partnerId, { price: 70 });
  const carBooked = await makeCar(P1.partnerId, { price: 71 });
  const carBlocked = await makeCar(P2.partnerId, { price: 72 });
  const carInactive = await makeCar(P1.partnerId, { price: 73, status: 'inactive' });
  const carUnapproved = await makeCar(P1.partnerId, { price: 74, approval: 'pending' });
  const carSuspended = await makeCar(PS.partnerId, { price: 75 });
  await svc.create(cust, win(carBooked.id, 80, 83));
  await availability.setCarDates(carBlocked.id, [day(81)], 'unavailable');
  const base = { pickupDate: day(80), returnDate: day(84), bookingType: 'advance' };
  const ids = await searchIds(base);
  check('a free car is offered', ids.includes(carFree.id));
  check('a car with a pending/confirmed booking in the window is not offered', !ids.includes(carBooked.id));
  check('a car the owner blocked inside the window is not offered', !ids.includes(carBlocked.id));
  check('inactive, not-approved and suspended-partner cars are never offered', ![carInactive.id, carUnapproved.id, carSuspended.id].some((i) => ids.includes(i)));
  const idsAfter = await searchIds({ pickupDate: day(86), returnDate: day(88), bookingType: 'advance' });
  check('the same cars are offered again for dates after the booking', idsAfter.includes(carBooked.id) && idsAfter.includes(carBlocked.id));
  const edge = await searchIds({ pickupDate: day(83), returnDate: day(85), bookingType: 'advance' });
  check('a window that touches the last booked day still excludes the car (day-level calendar)', !edge.includes(carBooked.id));
  const checkQuery = (q) => runValidator(rules.carSearch, { query: q });
  check('search validator: advance search needs both dates (422)', (await checkQuery({ bookingType: 'advance' }))?.statusCode === 422);
  check('search validator: today/yesterday is too soon for an advance search (422)', (await checkQuery({ bookingType: 'advance', pickupDate: today, returnDate: day(2) }))?.statusCode === 422 && (await checkQuery({ bookingType: 'advance', pickupDate: day(-2), returnDate: day(2) }))?.statusCode === 422);
  check('search validator: beyond the horizon / too long / unknown type (422)', (await checkQuery({ bookingType: 'advance', pickupDate: day(500), returnDate: day(502) }))?.statusCode === 422 && (await checkQuery({ bookingType: 'advance', pickupDate: day(5), returnDate: day(60) }))?.statusCode === 422 && (await checkQuery({ bookingType: 'luxury', pickupDate: day(5), returnDate: day(6) }))?.statusCode === 422);
  check('search validator: a valid advance search passes', (await checkQuery({ bookingType: 'advance', pickupDate: day(5), returnDate: day(8) })) === undefined);
  check('search without bookingType is unchanged (a past-dated search is still accepted)', (await checkQuery({ pickupDate: day(-2), returnDate: day(1) })) === undefined);
  const cal = await availability.getCarAvailability(carBooked.id, { startDate: day(78), endDate: day(86) });
  check('the availability calendar marks the advance booking\'s days as booked', [80, 81, 82, 83].every((n) => cal.bookedDates.includes(day(n))) && !cal.bookedDates.includes(day(84)));

  // ------------------------------------------------------------------ 4. overlap
  section('4. Overlapping advance reservations are prevented');
  const carO = await makeCar(P1.partnerId);
  const o1 = await svc.create(cust, win(carO.id, 20, 24));
  const overlaps = [['identical', 20, 24], ['starts inside', 22, 27], ['ends inside', 17, 21], ['contains it', 18, 26], ['inside it', 21, 22], ['touches the first day', 17, 20], ['touches the last day', 24, 27]];
  for (const [name, a, b] of overlaps) {
    const r = await attempt(() => svc.create(cust2, win(carO.id, a, b)));
    check(`${name}: refused (409)`, !r.ok && r.status === 409, JSON.stringify([r.status, r.message]));
  }
  check('the same customer cannot double-book the car either (409)', (await attempt(() => svc.create(cust, win(carO.id, 21, 23)))).status === 409);
  check('the quote also says the dates are taken (409)', (await attempt(() => svc.quote(cust2, win(carO.id, 21, 23)))).status === 409);
  check('only the first booking exists for the car', (await query(`SELECT COUNT(*) AS n FROM reservations WHERE car_id = $1`, [carO.id])).rows[0].n === 1);
  check('the day after / before is free', (await attempt(() => svc.create(cust2, win(carO.id, 25, 27)))).ok && (await attempt(() => svc.create(cust2, win(carO.id, 15, 19)))).ok);
  check('a different car can be booked for the same dates', (await attempt(() => svc.create(cust2, win(car2.id, 20, 24)))).ok);
  const guard = await attempt(() => query(
    `INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, return_date, status, daily_price, rental_days, subtotal_amount, total_price, booking_type)
     VALUES ($1, $2, $3, 'x', $4, $5, 'confirmed', 100, 3, 300, 300, 'advance')`, [cust2.id, P1.partnerId, carO.id, day(21), day(22)]));
  check('PostgreSQL itself refuses an overlapping row that bypasses the API (exclusion constraint)', !guard.ok && guard.raw.code === '23P01', JSON.stringify(guard.raw && guard.raw.code));
  const carB = await makeCar(P1.partnerId);
  await availability.setCarDates(carB.id, [day(32)], 'unavailable');
  check('an owner-blocked day inside the window refuses the booking (409)', (await attempt(() => svc.create(cust, win(carB.id, 31, 34)))).status === 409);
  check('an owner cannot block a day that has an advance booking (409)', (await attempt(() => availability.setCarDates(carO.id, [day(21)], 'unavailable'))).status === 409);
  const cancelled = await svc.cancelForCustomer(cust, o1.id, 'plans changed');
  check('cancelling frees the dates immediately', cancelled.status === 'cancelled' && (await attempt(() => svc.create(cust2, win(carO.id, 20, 24)))).ok);

  const carR = await makeCar(P1.partnerId);
  const race = await Promise.all(Array.from({ length: 6 }, (_, i) => attempt(async () => svc.create(await (async () => cust2)(), win(carR.id, 40, 43)).then((x) => x))));
  // six identical requests at the same moment (same customer, same car, same window)
  const wins = race.filter((x) => x.ok).length;
  check('6 simultaneous identical requests: exactly one succeeds', wins === 1, `wins=${wins}`);
  check('...the others get 409, not a server error', race.filter((x) => !x.ok).every((x) => x.status === 409), JSON.stringify(race.filter((x) => !x.ok).map((x) => [x.status, x.message])));
  check('...and the database holds exactly one booking', (await query('SELECT COUNT(*) AS n FROM reservations WHERE car_id = $1', [carR.id])).rows[0].n === 1);
  const carR2 = await makeCar(P1.partnerId);
  const racers = await Promise.all(['r1', 'r2', 'r3', 'r4'].map((s) => makeCustomer(`race-${s}`)));
  const race2 = await Promise.all(racers.map((u, i) => attempt(() => svc.create(u, win(carR2.id, 40 + i, 44 + i)))));
  check('4 different customers with overlapping windows at once: exactly one succeeds', race2.filter((x) => x.ok).length === 1 && race2.filter((x) => !x.ok).every((x) => x.status === 409));

  // ------------------------------------------------------------------ 5. verification
  section('5. Customer verification is enforced');
  const states = ['pending_review', 'rejected', 'resubmission_required', null];
  for (const st of states) {
    const u = await makeCustomer(`ver-${st || 'none'}`, st);
    const gate = await run(requireVerifiedCustomer, { user: u });
    check(`${st || 'not submitted'}: booking is refused with 403 and a reason`, gate.error?.statusCode === 403 && /verif|identity/i.test(gate.error.message) && gate.error.errors?.[0] === `verificationStatus:${st || 'not_submitted'}`, JSON.stringify([gate.error?.statusCode, gate.error?.message]));
    check(`${st || 'not submitted'}: the quote still shows the price but says canBook=false`, await (async () => { const q = await svc.quote(u, win(car2.id, 120, 122)); return q.eligibility.canBook === false && q.pricing.total === 160 && !!q.eligibility.message; })());
  }
  const approvedGate = await run(requireVerifiedCustomer, { user: cust });
  check('an approved customer passes the gate', approvedGate.nexted === true);
  check('a partner is refused by the same gate (403)', (await run(requireVerifiedCustomer, { user: P1.user })).error?.statusCode === 403);
  check('an admin is refused by the same gate (403)', (await run(requireVerifiedCustomer, { user: admin })).error?.statusCode === 403);
  const custRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/customer.routes.js'), 'utf8');
  check('the create route runs requireVerifiedCustomer before the controller', /router\.post\('\/me\/reservations', bookingLimiter, requireVerifiedCustomer, validate\(rules\.reservationInput\), c\.createReservation\)/.test(custRoutes));
  const ver = await makeCustomer('ver-later', 'pending_review');
  check('a customer approved later can then book', (await run(requireVerifiedCustomer, { user: ver })).error?.statusCode === 403 && (await query(`UPDATE customer_verifications SET status = 'approved', reviewed_at = NOW() WHERE customer_id = $1`, [ver.id])) && (await run(requireVerifiedCustomer, { user: ver })).nexted === true);

  // ------------------------------------------------------------------ 6. pricing & reference
  section('6. Price and unique reference');
  const carP = await makeCar(P1.partnerId, { price: 123.45 });
  const pq = await svc.quote(cust, win(carP.id, 70, 73));
  check('quote: 3 days x 123.45 = 370.35 from the stored daily price', pq.pricing.rentalDays === 3 && pq.pricing.subtotal === 370.35 && pq.pricing.total === 370.35 && pq.bookingType === 'advance' && pq.advanceMinHours === bookingConfig.advanceMinHours && pq.leadHours >= 24 * 69);
  const pr = await svc.create(cust, win(carP.id, 70, 73));
  check('the stored booking has the same price and breakdown', pr.totalPrice === 370.35 && pr.subtotalAmount === 370.35 && pr.rentalDays === 3 && pr.dailyPrice === 123.45 && pr.totalPrice === pr.subtotalAmount + pr.serviceFeeAmount + pr.taxAmount);
  await query('UPDATE cars SET daily_price = 999 WHERE id = $1', [carP.id]);
  check('a later price change does not alter the booking', (await svc.getForCustomer(cust.id, pr.id)).totalPrice === 370.35);
  const refs = [a1, a2, s1, s2, forged, pr].map((r) => r.bookingReference);
  check('references look like CCS-yymmdd-XXXXX', refs.every((r) => /^CCS-\d{6}-[A-HJ-NP-Z2-9]{5}$/.test(r)), refs.join(','));
  const many = [];
  const carM = await makeCar(P1.partnerId);
  for (let i = 0; i < 12; i += 1) many.push((await svc.create(cust, win(carM.id, 150 + i * 3, 151 + i * 3))).bookingReference);
  check('12 more reservations all get different references', new Set([...refs, ...many]).size === refs.length + many.length);
  check('the database refuses a duplicate reference', !(await attempt(() => query(`UPDATE reservations SET booking_reference = $1 WHERE id = $2`, [a1.bookingReference, a2.id]))).ok);

  // ------------------------------------------------------------------ 7. customer view
  section('7. Customer: My Bookings');
  const mine = await svc.listForCustomer(cust.id);
  check('the advance reservation appears in the customer\'s list with its type', mine.some((r) => r.id === a1.id && r.bookingType === 'advance'));
  check('the list holds standard and advance bookings together', mine.some((r) => r.id === s1.id && r.bookingType === 'standard'));
  const mineAdv = await svc.listForCustomer(cust.id, { bookingType: 'advance' });
  check('bookingType=advance returns only advance bookings', mineAdv.length > 0 && mineAdv.every((r) => r.bookingType === 'advance') && !mineAdv.some((r) => r.id === s1.id));
  check('bookingType=standard returns only standard bookings', (await svc.listForCustomer(cust.id, { bookingType: 'standard' })).every((r) => r.bookingType === 'standard'));
  check('an unknown bookingType is refused (422)', (await attempt(() => svc.listForCustomer(cust.id, { bookingType: 'zzz' }))).status === 422);
  const upcoming = await svc.listForCustomer(cust.id, { upcoming: 'true' });
  check('upcoming=true keeps only pending/confirmed bookings whose pickup is still ahead', upcoming.length > 0 && upcoming.every((r) => ['pending', 'confirmed'].includes(r.status) && `${r.pickupDate}T${r.pickupTime}` > svc.nowWall()));
  const detail = await svc.detailForCustomer(cust.id, a1.id);
  check('the detail shows type, reference, history and a cancel button', detail.bookingType === 'advance' && detail.history.length === 1 && detail.canCancel === true && !!detail.bookingReference);
  check('another customer cannot open it (404)', (await attempt(() => svc.detailForCustomer(cust2.id, a1.id))).status === 404);
  check('another customer cannot cancel it (404) and it is untouched', (await attempt(() => svc.cancelForCustomer(cust2, a1.id, 'x'))).status === 404 && (await statusOf(a1.id)) === 'pending');
  check('another customer\'s list does not contain it', !(await svc.listForCustomer(cust2.id)).some((r) => r.id === a1.id));
  const ctlList = await run(customerCtl.getReservations, { user: cust, query: { bookingType: 'advance' } });
  check('controller list passes the filter through', (ctlList.body?.data?.reservations || ctlList.body?.reservations || []).every((r) => r.bookingType === 'advance') && (ctlList.body?.data?.reservations || ctlList.body?.reservations || []).length > 0, JSON.stringify(ctlList.error?.message));

  // ------------------------------------------------------------------ 8. partner view
  section('8. Partner: advance reservations of their own cars only');
  const p1List = await svc.listForPartner(P1.partnerId, { bookingType: 'advance', limit: 100 });
  check('partner 1 sees the advance reservation, with customer contact and car', p1List.reservations.some((r) => r.id === a1.id && r.bookingType === 'advance' && r.customerName === 'ADV cust' && r.customerEmail && r.carMake === 'Test' && r.bookingReference === a1.bookingReference));
  check('the advance filter excludes standard bookings', p1List.reservations.every((r) => r.bookingType === 'advance'));
  const p2List = await svc.listForPartner(P2.partnerId, { limit: 100 });
  check('partner 2 does not see partner 1\'s advance reservation', !p2List.reservations.some((r) => r.id === a1.id) && p2List.reservations.length > 0);
  check('partner 2 cannot open it (404)', (await attempt(() => svc.getForPartner(P2.partnerId, a1.id))).status === 404);
  for (const to of ['confirmed', 'rejected', 'completed', 'cancelled']) {
    check(`partner 2 cannot change it to ${to} (404)`, (await attempt(() => svc.changeStatus(P2.actor, a1.id, to, 'because'))).status === 404);
  }
  const sneaky = await run(partnerCtl.getReservation, { user: P2.user, partner: { id: P2.partnerId }, params: { id: String(a1.id) }, query: { partnerId: P1.partnerId } });
  check('controller: a partnerId in the query does not grant access (404)', sneaky.error?.statusCode === 404);
  check('filters cannot widen a partner list', (await svc.listForPartner(P2.partnerId, { partnerId: P1.partnerId, carId: car1.id, bookingType: 'advance' })).reservations.length === 0);
  check('partner routes require the partner role', (await run(authorize('partner'), { user: cust })).error?.statusCode === 403 && (await run(authorize('partner'), { user: admin })).error?.statusCode === 403 && (await run(authorize('partner'), {})).error?.statusCode === 401);
  check('a suspended partner is refused by requirePartner (403)', (await run(requirePartner, { user: PS.user })).error?.statusCode === 403);
  const pStats = await svc.statsForPartner(P1.partnerId);
  const rawAdv = (await query(`SELECT COUNT(*) AS n FROM reservations WHERE partner_id = $1 AND booking_type = 'advance'`, [P1.partnerId])).rows[0].n;
  const rawUp = (await query(`SELECT COUNT(*) AS n FROM reservations WHERE partner_id = $1 AND booking_type = 'advance' AND status IN ('pending','confirmed') AND (pickup_date + pickup_time) > $2::timestamp`, [P1.partnerId, svc.nowWall()])).rows[0].n;
  check('partner stats: advance counts equal the database', pStats.advance === rawAdv && pStats.upcomingAdvance === rawUp && pStats.advance > 0, JSON.stringify(pStats));
  check('partner stats do not include other partners\' advance bookings', pStats.advance < (await query(`SELECT COUNT(*) AS n FROM reservations WHERE booking_type = 'advance'`)).rows[0].n);
  const stat7 = await svc.advanceStats('r.partner_id = $2', [P1.partnerId]);
  check('advanceNext7Days only counts pickups inside the next week', stat7.advanceNext7Days === (await query(`SELECT COUNT(*) AS n FROM reservations r WHERE r.partner_id = $1 AND r.booking_type = 'advance' AND r.status IN ('pending','confirmed') AND (r.pickup_date + r.pickup_time) > $2::timestamp AND (r.pickup_date + r.pickup_time) <= $2::timestamp + interval '7 days'`, [P1.partnerId, svc.nowWall()])).rows[0].n);

  // ------------------------------------------------------------------ 9. status management
  section('9. Integrated with the existing status workflow');
  const approved = await svc.changeStatus(P1.actor, a1.id, 'confirmed');
  check('partner approves an advance reservation: pending -> confirmed', approved.status === 'confirmed' && approved.bookingType === 'advance');
  const h = (await svc.getForPartner(P1.partnerId, a1.id)).history;
  check('history records it (who, role, when)', h.length === 2 && h[1].toStatus === 'confirmed' && h[1].changedByRole === 'partner' && h[1].changedByName);
  check('the customer sees the new status in My Bookings', (await svc.listForCustomer(cust.id)).find((r) => r.id === a1.id).status === 'confirmed');
  check('completing before the pickup time is refused (409)', (await attempt(() => svc.changeStatus(P1.actor, a1.id, 'completed'))).status === 409);
  const rej = await svc.create(cust2, win(car1.id, 200, 202));
  check('rejecting needs a reason (422)', (await attempt(() => svc.changeStatus(P1.actor, rej.id, 'rejected', ''))).status === 422);
  const rejected = await svc.changeStatus(P1.actor, rej.id, 'rejected', 'Car is in service');
  check('rejected with a reason, and the customer sees it', rejected.status === 'rejected' && (await svc.detailForCustomer(cust2.id, rej.id)).statusReason === 'Car is in service');
  check('a rejected advance reservation frees the dates', (await attempt(() => svc.create(cust, win(car1.id, 200, 202)))).ok);
  const c3 = await svc.create(cust, win(car2.id, 210, 212));
  await svc.changeStatus(P2.actor, c3.id, 'confirmed');
  const late = await rawBooking({ customer: cust, partner: P2.partnerId, car: await makeCar(P2.partnerId), status: 'confirmed', pickupDate: plusHours(5).date, pickupTime: plusHours(5).time, returnDate: plusHours(30).date, returnTime: plusHours(30).time, bookingType: 'standard' });
  check('customer may cancel a confirmed advance reservation far ahead', (await svc.cancelForCustomer(cust, c3.id, 'changed my mind')).status === 'cancelled');
  check('...but not a confirmed one inside the 24 h window (409)', (await attempt(() => svc.cancelForCustomer(cust, late, 'x'))).status === 409);

  // ------------------------------------------------------------------ 10. admin
  section('10. Admin: monitor and manage');
  const adminAdv = await svc.listForAdmin({ bookingType: 'advance', limit: 100 });
  check('admin sees advance reservations from every partner', adminAdv.reservations.some((r) => r.partnerId === P1.partnerId) && adminAdv.reservations.some((r) => r.partnerId === P2.partnerId) && adminAdv.reservations.every((r) => r.bookingType === 'advance'));
  check('admin list has customer, partner, car, type, reference', adminAdv.reservations.every((r) => r.customerName && r.partnerName && r.carMake && r.bookingReference));
  check('admin combined filters: advance + pending + search by reference', (await svc.listForAdmin({ bookingType: 'advance', status: 'pending', search: a2.bookingReference })).reservations.map((r) => r.id).join() === String(a2.id));
  const adminUp = await svc.listForAdmin({ bookingType: 'advance', upcoming: 'true', limit: 100 });
  check('admin upcoming filter excludes cancelled / rejected / past', adminUp.reservations.length > 0 && adminUp.reservations.every((r) => ['pending', 'confirmed'].includes(r.status)));
  check('admin meta totals are consistent', adminAdv.meta.total === (await query(`SELECT COUNT(*) AS n FROM reservations WHERE booking_type = 'advance'`)).rows[0].n);
  const aStats = await svc.statsForAdmin();
  const rawA = (await query(`SELECT COUNT(*) FILTER (WHERE booking_type = 'advance') AS adv, COUNT(*) FILTER (WHERE booking_type = 'advance' AND status = 'pending') AS pend, COUNT(*) AS total FROM reservations`)).rows[0];
  check('admin stats equal the database', aStats.advance === rawA.adv && aStats.advancePending === rawA.pend && aStats.total === rawA.total, JSON.stringify([aStats, rawA]));
  const ctlStats = await run(adminCtl.reservationStats, { user: admin });
  check('controller: admin stats endpoint answers', (ctlStats.body?.data?.stats || ctlStats.body?.stats)?.advance === rawA.adv);
  const dash = await adminService.dashboard();
  check('admin dashboard carries the advance counts', dash.stats.advanceReservations === rawA.adv && dash.stats.pendingAdvanceReservations === rawA.pend && dash.recentReservations.every((r) => 'bookingType' in r));
  const adminCancel = await attempt(() => svc.changeStatus(adminActor, a2.id, 'cancelled', ''));
  check('admin cancelling needs a reason (422)', adminCancel.status === 422);
  check('admin cancels with a reason', (await svc.changeStatus(adminActor, a2.id, 'cancelled', 'Customer called')).status === 'cancelled' && (await svc.getForAdmin(a2.id)).history.at(-1).changedByRole === 'admin');
  const adminApproves = await svc.create(cust2, win(car1.id, 230, 232));
  check('admin can approve an advance reservation', (await svc.changeStatus(adminActor, adminApproves.id, 'confirmed')).status === 'confirmed');
  check('a cancelled advance reservation cannot be reopened (409)', (await attempt(() => svc.changeStatus(adminActor, a2.id, 'confirmed'))).status === 409);
  const adminRoutes = fs.readFileSync(path.join(__dirname, '../src/routes/admin.routes.js'), 'utf8');
  check('admin routes: authorize(admin) comes first and /stats is registered before /:id', /router\.use\(authenticate, authorize\('admin'\)\)/.test(adminRoutes) && adminRoutes.indexOf("'/reservations/stats'") > 0 && adminRoutes.indexOf("'/reservations/stats'") < adminRoutes.indexOf("'/reservations/:id'"));
  check('customer on an admin route -> 403', (await run(authorize('admin'), { user: cust })).error?.statusCode === 403);
  check('partner on an admin route -> 403', (await run(authorize('admin'), { user: P1.user })).error?.statusCode === 403);
  check('no login -> 401', (await run(authorize('admin'), {})).error?.statusCode === 401);

  // ------------------------------------------------------------------ 11. authentication
  section('11. Authentication in front of every role');
  check('no token -> 401', (await run(authenticate, { headers: {}, cookies: {} })).error?.statusCode === 401);
  check('a forged token -> 401', (await run(authenticate, { headers: { authorization: 'Bearer abc.def.ghi' }, cookies: {} })).error?.statusCode === 401);
  const good = await run(authenticate, { headers: { authorization: `Bearer ${signToken(cust)}` }, cookies: {} });
  check('a valid token reaches the route with the right user', good.nexted === true);
  const susp = await makeUser('suspended');
  await query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [susp.id]);
  check('a suspended account is refused (403)', (await run(authenticate, { headers: { authorization: `Bearer ${signToken(susp)}` }, cookies: {} })).error?.statusCode === 403);
  const custSrc = fs.readFileSync(path.join(__dirname, '../src/routes/customer.routes.js'), 'utf8');
  const partnerSrc = fs.readFileSync(path.join(__dirname, '../src/routes/partner.routes.js'), 'utf8');
  check('customer and partner routes also start with authenticate + authorize', /router\.use\(authenticate, authorize\('customer'\)\)/.test(custSrc) && /router\.use\(authenticate, authorize\('partner'\)\)/.test(partnerSrc));

  // ------------------------------------------------------------------ 12. nothing broken
  section('12. Existing bookings are not broken');
  const legacyCar = await makeCar(P1.partnerId);
  const legacy = await rawBooking({ customer: cust, partner: P1.partnerId, car: legacyCar, status: 'confirmed', pickupDate: day(-9), returnDate: day(-7) });
  check('a booking without a type uses the default "standard"', (await typeOf(legacy)) === 'standard');
  const asStandard = (await svc.listForCustomer(cust.id)).find((r) => r.id === legacy);
  check('it still lists with all its old fields', asStandard && asStandard.status === 'confirmed' && asStandard.bookingReference && asStandard.pickupTime === '10:00' && asStandard.totalPrice === 100);
  check('it can still complete through the old workflow', (await svc.changeStatus(P1.actor, legacy, 'completed')).status === 'completed');
  check('the database refuses an unknown booking type', (await attempt(() => query(`UPDATE reservations SET booking_type = 'vip' WHERE id = $1`, [legacy]))).raw?.code === '23514');
  const vocab = (await query(`SELECT COUNT(*) AS n FROM reservations WHERE status NOT IN ('pending','confirmed','completed','cancelled','rejected') OR booking_type NOT IN ('standard','advance')`)).rows[0].n;
  check('no row has a status or type outside the allowed vocabulary', vocab === 0);
  const allList = await svc.listForAdmin({ limit: 100 });
  check('an unfiltered admin list still returns every booking, standard and advance', allList.reservations.some((r) => r.bookingType === 'standard') && allList.reservations.some((r) => r.bookingType === 'advance'));
})()
  .catch((err) => { failures.push(`UNEXPECTED ERROR: ${err.stack || err}`); console.error(err); })
  .finally(async () => {
    try { await cleanup(); } catch (e) { console.error('cleanup failed:', e.message); }
    await pool.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
  });
