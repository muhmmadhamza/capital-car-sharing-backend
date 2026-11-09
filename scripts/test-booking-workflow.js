// Integration test for the booking workflow (Part 2): partner approval, admin management, status rules, history,
// customer cancellation, ownership and security, against the REAL database.
//   npm run migrate  ->  npm run test:workflow
//
// Drives the real services, controllers, validators and auth middleware (not the HTTP layer). Creates its own data
// (emails wf-test-*@example.test) and removes everything it created. Refuses to run with NODE_ENV=production.
require('dotenv').config();
const config = require('../src/config/env');
if (config.isProduction) {
  console.error('Refusing to run the workflow tests with NODE_ENV=production.');
  process.exit(1);
}
const { query, pool } = require('../src/database/pool');
const availability = require('../src/services/availability.service');
const svc = require('../src/services/reservation.service');
const adminService = require('../src/services/admin.service');
const partnerCtl = require('../src/controllers/partner.controller');
const adminCtl = require('../src/controllers/admin.controller');
const customerCtl = require('../src/controllers/customer.controller');
const { authenticate, authorize, requirePartner } = require('../src/middleware/auth');
const validate = require('../src/middleware/validate');
const rules = require('../src/validators');
const R = require('../src/utils/bookingRules');
const bookingRules = require('../src/config/booking');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else { failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);
const today = availability.today();
const day = (n) => R.addDays(today, n);
const win = (carId, a, b, over = {}) => ({ carId, pickupDate: day(a), pickupTime: '10:00', returnDate: day(b), returnTime: '10:00', ...over });

async function attempt(fn) {
  try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, status: e.statusCode, message: e.message, raw: e }; }
}
async function run(handler, req) { // drives an express handler / middleware chain element
  const out = { status: 200, body: undefined, error: undefined };
  const res = { status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  await new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const r = handler(req, res, (err) => { out.error = err; finish(); });
    Promise.resolve(r).then(finish, finish);
    setTimeout(finish, 50);
  });
  return out;
}
const runValidator = (rule, body) => new Promise((resolve) => validate(rule)({ body: { ...body }, params: {}, query: {} }, {}, (err) => resolve(err)));

async function cleanup() {
  const { rows } = await query(`SELECT id FROM users WHERE email LIKE 'wf-test-%@example.test'`);
  const ids = rows.map((u) => u.id);
  if (!ids.length) return;
  await query('DELETE FROM reservations WHERE customer_id = ANY($1::int[]) OR partner_id IN (SELECT id FROM partners WHERE user_id = ANY($1::int[]))', [ids]);
  await query('DELETE FROM cars WHERE partner_id IN (SELECT id FROM partners WHERE user_id = ANY($1::int[]))', [ids]);
  await query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
}
const makeUser = async (slug, role = 'customer') =>
  (await query(`INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id, name, email, role, status`, [`WF ${slug}`, `wf-test-${slug}@example.test`, role])).rows[0];
async function makeApprovedCustomer(slug) {
  const u = await makeUser(slug);
  await query(`INSERT INTO customer_verifications (customer_id, status, full_legal_name, date_of_birth, country, phone, document_type, reviewed_at)
               VALUES ($1, 'approved', 'Test Person', '1990-01-01', 'PK', '+920000000', 'passport', NOW())`, [u.id]);
  return u;
}
async function makePartner(slug, status = 'active') {
  const user = await makeUser(slug, 'partner');
  const p = (await query(`INSERT INTO partners (user_id, company_name, status) VALUES ($1, $2, $3) RETURNING id`, [user.id, `WF ${slug} Co`, status])).rows[0];
  return { user, partnerId: p.id, actor: { id: user.id, role: 'partner', partnerId: p.id } };
}
const makeCar = async (partnerId) =>
  (await query(`INSERT INTO cars (partner_id, make, model, year, type, seats, doors, transmission, fuel_type, daily_price, location, status, approval_status)
                VALUES ($1, 'Test', 'Workflow', 2022, 'Sedan', 5, 4, 'Automatic', 'Petrol', 100, 'WF City', 'active', 'approved') RETURNING id, partner_id`, [partnerId])).rows[0];
// Inserts a booking directly (used for dates in the past, or exact pickup times the API would not accept).
async function rawBooking({ customer, partner, car, status, pickupDate, pickupTime = '10:00', returnDate, returnTime = '10:00' }) {
  const r = await query(
    `INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, pickup_time, return_date, return_time, status, daily_price, rental_days, subtotal_amount, total_price)
     VALUES ($1, $2, $3, 'WF City', $4, $5, $6, $7, $8, 100, 1, 100, 100) RETURNING id`,
    [customer.id, partner, car.id, pickupDate, pickupTime, returnDate, returnTime, status]);
  await query(`INSERT INTO reservation_status_history (reservation_id, from_status, to_status, changed_by, changed_by_role) VALUES ($1, NULL, $2, $3, 'customer')`, [r.rows[0].id, status, customer.id]);
  return r.rows[0].id;
}
const statusOf = async (id) => (await query('SELECT status FROM reservations WHERE id = $1', [id])).rows[0].status;
const historyRows = async (id) => (await query('SELECT * FROM reservation_status_history WHERE reservation_id = $1 ORDER BY id', [id])).rows;
const plusHours = (h) => { // wall-clock "now + h hours" as { date, time }
  const now = svc.nowWall();
  const d = new Date(`${now}:00Z`); d.setUTCMinutes(d.getUTCMinutes() + Math.round(h * 60));
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
};

(async () => {
  await cleanup();
  const cust = await makeApprovedCustomer('cust');
  const cust2 = await makeApprovedCustomer('cust2');
  const admin = await makeUser('admin', 'admin');
  const adminActor = { id: admin.id, role: 'admin' };
  const P1 = await makePartner('p1');
  const P2 = await makePartner('p2');
  const car1 = await makeCar(P1.partnerId);
  const car1b = await makeCar(P1.partnerId);
  const car2 = await makeCar(P2.partnerId);

  // ------------------------------------------------------------------ 1. creation
  section('1. A new booking is pending and its history starts');
  const b1 = (await svc.create(cust, win(car1.id, 20, 22)));
  check('created as pending', b1.status === 'pending');
  let h = await historyRows(b1.id);
  check('history has one row: (none) -> pending by the customer', h.length === 1 && h[0].fromStatus === null && h[0].toStatus === 'pending' && h[0].changedByRole === 'customer' && h[0].changedBy === cust.id);
  check('a pending booking holds the dates (another customer is refused)', (await attempt(() => svc.create(cust2, win(car1.id, 20, 22)))).status === 409);

  // ------------------------------------------------------------------ 2. partner ownership
  section('2. Partners only see and touch bookings of their own cars');
  const own = await svc.listForPartner(P1.partnerId, {});
  check('partner 1 sees the booking with reference, customer, car, dates and price', own.reservations.some((r) => r.id === b1.id && r.bookingReference === b1.bookingReference && r.customerName === 'WF cust' && r.customerEmail && r.carMake === 'Test' && r.pickupDate === day(20) && r.returnDate === day(22) && r.totalPrice === 200 && r.pickupTime === '10:00'));
  const other = await svc.listForPartner(P2.partnerId, {});
  check('partner 2 does not see it in the list', !other.reservations.some((r) => r.id === b1.id));
  check('partner 2 cannot open it (404)', (await attempt(() => svc.getForPartner(P2.partnerId, b1.id))).status === 404);
  for (const to of ['confirmed', 'rejected', 'completed', 'cancelled']) {
    const r = await attempt(() => svc.changeStatus(P2.actor, b1.id, to, 'because'));
    check(`partner 2 cannot change it to ${to} (404)`, !r.ok && r.status === 404);
  }
  check('the booking is untouched by those attempts', (await statusOf(b1.id)) === 'pending' && (await historyRows(b1.id)).length === 1);
  const ctl = await run(partnerCtl.getReservation, { user: P2.user, partner: { id: P2.partnerId }, params: { id: String(b1.id) } });
  check('controller: partner 2 GET -> 404', ctl.error?.statusCode === 404);
  const bad = await run(partnerCtl.approveReservation, { user: P2.user, partner: { id: P2.partnerId }, params: { id: String(b1.id) }, body: { partnerId: P1.partnerId, status: 'confirmed' } });
  check('controller: a partnerId in the body does not grant access (404)', bad.error?.statusCode === 404 && (await statusOf(b1.id)) === 'pending');
  const onlyOwn = await svc.listForPartner(P2.partnerId, { carId: car1.id, customerId: cust.id, partnerId: P1.partnerId });
  check('filters cannot widen a partner list to someone else\'s bookings', onlyOwn.reservations.length === 0);

  // ------------------------------------------------------------------ 3. approve
  section('3. Partner approval');
  const approved = await svc.changeStatus(P1.actor, b1.id, 'confirmed');
  check('partner 1 approves: pending -> confirmed', approved.status === 'confirmed');
  h = await historyRows(b1.id);
  check('history records who and when', h.length === 2 && h[1].fromStatus === 'pending' && h[1].toStatus === 'confirmed' && h[1].changedBy === P1.user.id && h[1].changedByRole === 'partner' && h[1].createdAt instanceof Date);
  check('approving twice is refused (409)', (await attempt(() => svc.changeStatus(P1.actor, b1.id, 'confirmed'))).status === 409);
  check('the customer sees the new status', (await svc.detailForCustomer(cust.id, b1.id)).status === 'confirmed');
  check('the admin sees the new status', (await svc.getForAdmin(b1.id)).status === 'confirmed');
  const ctlOk = await run(partnerCtl.listReservations, { user: P1.user, partner: { id: P1.partnerId }, query: { status: 'confirmed' } });
  check('controller: partner list filtered by status', ctlOk.body?.data?.reservations?.every((r) => r.status === 'confirmed') && ctlOk.body.data.reservations.length >= 1);

  // ------------------------------------------------------------------ 4. reject
  section('4. Partner rejection');
  const b2 = await svc.create(cust, win(car1b.id, 30, 32));
  const noReason = await attempt(() => svc.changeStatus(P1.actor, b2.id, 'rejected', ''));
  check('rejecting needs a reason (422)', !noReason.ok && noReason.status === 422);
  check('over-long reason refused (422)', (await attempt(() => svc.changeStatus(P1.actor, b2.id, 'rejected', 'x'.repeat(501)))).status === 422);
  const rej = await svc.changeStatus(P1.actor, b2.id, 'rejected', 'Car is in the workshop');
  check('rejected with a reason', rej.status === 'rejected' && rej.statusReason === 'Car is in the workshop');
  check('the customer sees the status and the reason', await (async () => { const d = await svc.detailForCustomer(cust.id, b2.id); return d.status === 'rejected' && d.statusReason === 'Car is in the workshop' && d.canCancel === false; })());
  check('customer history shows roles but not names', await (async () => { const d = await svc.detailForCustomer(cust.id, b2.id); return d.history.length === 2 && d.history[1].changedByRole === 'partner' && !('changedByName' in d.history[1]); })());
  const rebook = await attempt(() => svc.create(cust2, win(car1b.id, 30, 32)));
  check('a rejected booking frees its dates', rebook.ok);
  check('a rejected booking cannot be approved afterwards (409)', (await attempt(() => svc.changeStatus(P1.actor, b2.id, 'confirmed'))).status === 409);

  // ------------------------------------------------------------------ 5. invalid transitions
  section('5. Invalid transitions are refused');
  const never = [
    ['confirmed', 'pending', adminActor], ['confirmed', 'rejected', adminActor], ['rejected', 'confirmed', adminActor],
    ['rejected', 'cancelled', adminActor], ['cancelled', 'confirmed', adminActor], ['pending', 'completed', adminActor],
  ];
  const carX = await makeCar(P1.partnerId);
  const mk = async (status, a) => rawBooking({ customer: cust, partner: P1.partnerId, car: carX, status, pickupDate: day(a), returnDate: day(a + 1) });
  let off = 100;
  for (const [from, to, actor] of never) {
    const id = await mk(from, (off += 3));
    const r = await attempt(() => svc.changeStatus(actor, id, to, 'valid reason'));
    check(`${from} -> ${to} refused (409)`, !r.ok && r.status === 409 && (await statusOf(id)) === from, JSON.stringify([r.status, r.message]));
  }
  const idNoOp = await mk('pending', (off += 3));
  const noOp = await attempt(() => svc.changeStatus(adminActor, idNoOp, 'pending', 'same'));
  check('pending -> pending refused (409)', !noOp.ok && noOp.status === 409);
  const unknown = await runValidator(rules.adminStatusChange, { status: 'upcoming' });
  check('validator: an unknown status ("upcoming") is refused (422)', unknown?.statusCode === 422);
  const idc = await mk('pending', (off += 3));
  check('a customer cannot approve (403)', (await attempt(() => svc.changeStatus({ id: cust.id, role: 'customer' }, idc, 'confirmed'))).status === 403);
  const idp = await mk('confirmed', (off += 3));
  check('a partner cannot cancel a confirmed booking (403)', (await attempt(() => svc.changeStatus(P1.actor, idp, 'cancelled', 'no'))).status === 403);
  check('an unknown actor role is treated as not found (404)', (await attempt(() => svc.changeStatus({ id: 1, role: 'guest' }, idp, 'cancelled'))).status === 404);

  // ------------------------------------------------------------------ 6. complete
  section('6. Completing a booking');
  const future = await mk('confirmed', (off += 3));
  check('cannot complete before pickup (409)', (await attempt(() => svc.changeStatus(P1.actor, future, 'completed'))).status === 409);
  const past = await rawBooking({ customer: cust, partner: P1.partnerId, car: carX, status: 'confirmed', pickupDate: day(-6), returnDate: day(-4) });
  const done = await attempt(() => svc.changeStatus(P1.actor, past, 'completed'));
  check('partner completes a started booking', done.ok && done.value.status === 'completed');
  check('completed bookings are final (409)', (await attempt(() => svc.changeStatus(adminActor, past, 'cancelled', 'late'))).status === 409);
  const stalePending = await rawBooking({ customer: cust, partner: P1.partnerId, car: carX, status: 'pending', pickupDate: day(-3), returnDate: day(-2) });
  check('a pending booking whose pickup has passed cannot be approved (409)', (await attempt(() => svc.changeStatus(P1.actor, stalePending, 'confirmed'))).status === 409);

  // ------------------------------------------------------------------ 7. customer cancellation
  section('7. Customer cancellation');
  const c1 = await svc.create(cust, win(car1.id, 40, 42));
  check('a pending booking shows the cancel button', (await svc.detailForCustomer(cust.id, c1.id)).canCancel === true);
  check("another customer cannot cancel it (404)", (await attempt(() => svc.cancelForCustomer(cust2, c1.id, 'x'))).status === 404);
  check('...and it is still pending', (await statusOf(c1.id)) === 'pending');
  const cancelled = await svc.cancelForCustomer(cust, c1.id, 'Plans changed');
  check('the customer cancels their own pending booking', cancelled.status === 'cancelled' && cancelled.canCancel === false);
  h = await historyRows(c1.id);
  check('cancellation history: who, role, reason', h.length === 2 && h[1].toStatus === 'cancelled' && h[1].changedBy === cust.id && h[1].changedByRole === 'customer' && h[1].reason === 'Plans changed');
  check('cancelling again is refused (409)', (await attempt(() => svc.cancelForCustomer(cust, c1.id))).status === 409);
  check('cancelling frees the dates for someone else', (await attempt(() => svc.create(cust2, win(car1.id, 40, 42)))).ok);
  const cal = await availability.getCarAvailability(car1.id, { startDate: day(39), endDate: day(43) });
  check('the availability calendar shows the dates as booked by the NEW booking, not the cancelled one', cal.bookedDates.includes(day(40)));
  const cOld = await svc.create(cust, win(car1b.id, 60, 62));
  await svc.changeStatus(P1.actor, cOld.id, 'confirmed');
  const okCancel = await attempt(() => svc.cancelForCustomer(cust, cOld.id));
  check(`a confirmed booking can be cancelled more than ${bookingRules.cancelMinHours} h before pickup`, okCancel.ok && okCancel.value.status === 'cancelled');
  const soon = plusHours(5);
  const tooLate = await rawBooking({ customer: cust, partner: P1.partnerId, car: carX, status: 'confirmed', pickupDate: soon.date, pickupTime: soon.time, returnDate: R.addDays(soon.date, 1), returnTime: soon.time });
  const lateTry = await attempt(() => svc.cancelForCustomer(cust, tooLate));
  check('a confirmed booking starting in 5 h cannot be cancelled by the customer (409)', bookingRules.cancelMinHours <= 5 ? lateTry.ok : (!lateTry.ok && lateTry.status === 409 && /hours before pickup/.test(lateTry.message)), JSON.stringify([lateTry.status, lateTry.message]));
  check('the cancel button is hidden for it too', bookingRules.cancelMinHours <= 5 || (await svc.detailForCustomer(cust.id, tooLate)).canCancel === false);
  const carY = await makeCar(P1.partnerId);
  const started = await rawBooking({ customer: cust, partner: P1.partnerId, car: carY, status: 'pending', pickupDate: day(-1), returnDate: day(1) });
  check('a booking that has started cannot be cancelled (409)', (await attempt(() => svc.cancelForCustomer(cust, started))).status === 409);
  const cc = await run(customerCtl.cancelReservation, { user: cust2, params: { id: String(tooLate) }, body: {} });
  check('controller: cancelling someone else\'s booking -> 404', cc.error?.statusCode === 404);
  check('validator: over-long cancel reason refused (422)', (await runValidator(rules.reasonBody, { reason: 'x'.repeat(501) }))?.statusCode === 422);

  // ------------------------------------------------------------------ 8. admin
  section('8. Admin booking management');
  const all = await svc.listForAdmin({ limit: 100 });
  check('admin list contains bookings of different partners', [b1.id, b2.id, c1.id].every((id) => all.reservations.some((r) => r.id === id)));
  const bP2 = await svc.create(cust2, win(car2.id, 70, 71));
  const byRef = await svc.listForAdmin({ search: bP2.bookingReference.toLowerCase() });
  check('search by booking reference (case-insensitive)', byRef.reservations.length === 1 && byRef.reservations[0].id === bP2.id);
  check('search by partial reference', (await svc.listForAdmin({ search: bP2.bookingReference.slice(0, 11) })).reservations.some((r) => r.id === bP2.id));
  check('search by customer name', (await svc.listForAdmin({ search: 'WF cust2' })).reservations.every((r) => r.customerId === cust2.id) && (await svc.listForAdmin({ search: 'WF cust2' })).reservations.length > 0);
  check('a "%" in the search is literal, not a wildcard', (await svc.listForAdmin({ search: '%' })).reservations.length === 0 && (await svc.listForAdmin({ search: '_' })).reservations.length === 0);
  check('filter by status', (await svc.listForAdmin({ status: 'rejected', limit: 100 })).reservations.every((r) => r.status === 'rejected'));
  check('filter by customer', (await svc.listForAdmin({ customerId: cust2.id, limit: 100 })).reservations.every((r) => r.customerId === cust2.id));
  check('filter by car', (await svc.listForAdmin({ carId: car2.id })).reservations.every((r) => r.carId === car2.id));
  check('filter by partner', (await svc.listForAdmin({ partnerId: P2.partnerId })).reservations.every((r) => r.partnerId === P2.partnerId));
  const combined = await svc.listForAdmin({ customerId: cust2.id, carId: car2.id, status: 'pending' });
  check('filters combine', combined.reservations.length === 1 && combined.reservations[0].id === bP2.id);
  check('paging metadata', (await svc.listForAdmin({ limit: 2 })).meta.limit === 2 && (await svc.listForAdmin({ limit: 2 })).reservations.length <= 2);
  for (const bad of [{ status: 'upcoming' }, { customerId: 'abc' }, { carId: '-1' }]) {
    check(`bad filter ${JSON.stringify(bad)} -> 422`, (await attempt(() => svc.listForAdmin(bad))).status === 422);
  }
  const detail = await svc.getForAdmin(bP2.id);
  check('admin detail: customer, partner and car information', detail.customerEmail && detail.customerPhone !== undefined && detail.partnerCompanyName === 'WF p2 Co' && detail.partnerEmail && detail.carMake === 'Test' && detail.carLocation === 'WF City');
  check('admin detail: full history with names', detail.history.length === 1 && detail.history[0].changedByName === 'WF cust2');
  check('admin: unknown booking -> 404', (await attempt(() => svc.getForAdmin(2147483000))).status === 404);
  const noWhy = await attempt(() => svc.changeStatus(adminActor, bP2.id, 'cancelled', ''));
  check('admin cancel needs a reason (422)', !noWhy.ok && noWhy.status === 422);
  const adminConfirm = await svc.changeStatus(adminActor, bP2.id, 'confirmed');
  check('admin can approve any partner\'s booking', adminConfirm.status === 'confirmed');
  const adminCancel = await svc.changeStatus(adminActor, bP2.id, 'cancelled', 'Customer called support');
  check('admin can cancel with a reason', adminCancel.status === 'cancelled' && adminCancel.history.at(-1).changedByRole === 'admin' && adminCancel.history.at(-1).changedByName === 'WF admin' && (await historyRows(bP2.id)).at(-1).changedBy === admin.id);
  const viaCtl = await run(adminCtl.setReservationStatus, { user: admin, params: { id: String(c1.id) }, body: { status: 'completed', reason: 'x' } });
  check('controller: admin invalid transition surfaces as 409', viaCtl.error?.statusCode === 409);

  // ------------------------------------------------------------------ 9. security
  section('9. Authentication, roles and unauthorised access');
  const noToken = await run(authenticate, { headers: {}, cookies: {} });
  check('no token -> 401', noToken.error?.statusCode === 401);
  const role = async (mw, user) => (await run(mw, { user })).error?.statusCode ?? 'next';
  check('customer on a partner route -> 403', (await role(authorize('partner'), cust)) === 403);
  check('customer on an admin route -> 403', (await role(authorize('admin'), cust)) === 403);
  check('partner on an admin route -> 403', (await role(authorize('admin'), P1.user)) === 403);
  check('admin on a partner route -> 403', (await role(authorize('partner'), admin)) === 403);
  check('anonymous on authorize -> 401', (await role(authorize('admin'), undefined)) === 401);
  check('right role passes', (await role(authorize('admin'), admin)) === 'next' && (await role(authorize('partner'), P1.user)) === 'next');
  const suspended = await makePartner('psusp', 'suspended');
  check('a suspended partner is blocked from bookings (403)', (await run(requirePartner, { user: suspended.user })).error?.statusCode === 403);
  check('a customer account is not a partner (403)', (await run(requirePartner, { user: cust })).error?.statusCode === 403);
  const noPartnerProfile = await makeUser('nopartner', 'partner');
  check('a partner user without a profile is blocked (403)', (await run(requirePartner, { user: noPartnerProfile })).error?.statusCode === 403);
  const routeSrc = (f) => require('fs').readFileSync(require('path').join(__dirname, `../src/routes/${f}`), 'utf8');
  check('partner routes: authenticate + authorize(partner) come first', /router\.use\(authenticate, authorize\('partner'\)\)/.test(routeSrc('partner.routes.js')));
  check('admin routes: authenticate + authorize(admin) come first', /router\.use\(authenticate, authorize\('admin'\)\)/.test(routeSrc('admin.routes.js')));
  check('customer routes: authenticate + authorize(customer) come first', /router\.use\(authenticate, authorize\('customer'\)\)/.test(routeSrc('customer.routes.js')));
  const pr = routeSrc('partner.routes.js');
  check('partner booking routes sit behind requirePartner', pr.indexOf("router.use('/me/reservations', requirePartner)") > 0 && pr.indexOf("router.use('/me/reservations', requirePartner)") < pr.indexOf("router.get('/me/reservations'"));

  // ------------------------------------------------------------------ 10. concurrency
  section('10. Concurrent status changes stay consistent');
  const r1 = await svc.create(cust, win(car1.id, 80, 82));
  const dbl = await Promise.all([1, 2, 3].map(() => attempt(() => svc.changeStatus(P1.actor, r1.id, 'confirmed'))));
  check('three simultaneous approvals: exactly one succeeds', dbl.filter((x) => x.ok).length === 1 && dbl.filter((x) => !x.ok).every((x) => x.status === 409));
  check('...and only one history row was written for it', (await historyRows(r1.id)).filter((x) => x.toStatus === 'confirmed').length === 1);
  const r2 = await svc.create(cust, win(car1b.id, 85, 87));
  const race = await Promise.all([attempt(() => svc.changeStatus(P1.actor, r2.id, 'rejected', 'No')), attempt(() => svc.cancelForCustomer(cust, r2.id, 'Changed mind'))]);
  const finalStatus = await statusOf(r2.id);
  const hh = await historyRows(r2.id);
  check('reject and cancel racing: exactly one wins', race.filter((x) => x.ok).length === 1 && ['rejected', 'cancelled'].includes(finalStatus));
  check('...and the history agrees with the final status', hh.length === 2 && hh[1].toStatus === finalStatus);

  // ------------------------------------------------------------------ 11. persistence & sync
  section('11. Persistence and synchronised dashboards');
  const db = (await query('SELECT status, updated_at, created_at FROM reservations WHERE id = $1', [b1.id])).rows[0];
  check('status and timestamps are stored in the database', db.status === 'confirmed' && db.updatedAt > db.createdAt);
  const ps = await svc.statsForPartner(P1.partnerId);
  const raw = (await query(`SELECT status, COUNT(*) AS n FROM reservations WHERE partner_id = $1 GROUP BY status`, [P1.partnerId])).rows;
  check('partner stats equal the database counts', raw.every((r) => ps[r.status] === r.n) && ps.total === raw.reduce((a, r) => a + r.n, 0));
  const dash = await adminService.dashboard();
  const rawAll = (await query(`SELECT status, COUNT(*) AS n FROM reservations GROUP BY status`)).rows;
  const cnt = (s) => rawAll.find((r) => r.status === s)?.n ?? 0;
  check('admin dashboard counts equal the database counts', dash.stats.pendingReservations === cnt('pending') && dash.stats.confirmedReservations === cnt('confirmed') && dash.stats.cancelledReservations === cnt('cancelled') && dash.stats.rejectedReservations === cnt('rejected') && dash.stats.completedReservations === cnt('completed'));
  const mineAfter = await svc.listForCustomer(cust.id);
  const adminAfter = (await svc.listForAdmin({ customerId: cust.id, limit: 100 })).reservations;
  const partnerAfter = (await svc.listForPartner(P1.partnerId, { customerId: cust.id, limit: 100 })).reservations;
  const sig = (rows) => rows.filter((r) => r.partnerId === P1.partnerId).map((r) => `${r.id}:${r.status}`).sort().join(',');
  check('customer, partner and admin lists show identical statuses for the same bookings', sig(mineAfter) === sig(adminAfter) && sig(adminAfter) === sig(partnerAfter) && sig(mineAfter).length > 0);
  const stale = (await query(`SELECT COUNT(*) AS n FROM reservations WHERE status NOT IN ('pending','confirmed','completed','cancelled','rejected')`)).rows[0].n;
  check('no reservation has a status outside the new vocabulary', stale === 0);
  check('the database refuses an unknown status', (await attempt(() => query(`UPDATE reservations SET status = 'upcoming' WHERE id = $1`, [b1.id]))).raw?.code === '23514');
})()
  .catch((err) => { failures.push(`UNEXPECTED ERROR: ${err.stack || err}`); console.error(err); })
  .finally(async () => {
    try { await cleanup(); } catch (e) { console.error('cleanup failed:', e.message); }
    await pool.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) { console.log('Failed:\n - ' + failures.join('\n - ')); process.exit(1); }
  });
