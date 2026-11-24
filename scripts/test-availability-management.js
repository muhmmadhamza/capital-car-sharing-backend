// End-to-end check of partner availability management against a RUNNING API + PostgreSQL (migrations 001-007 applied).
//   npm run db:setup (once) -> npm run dev -> npm run test:availability:manage
// Uses the seeded demo accounts. Creates its own cars and reservations and removes them afterwards.
// Sections 1-12 follow the Part 3 checklist.
require('dotenv').config();
const config = require('../src/config/env');
const { query, pool } = require('../src/database/pool');
const availability = require('../src/services/availability.service');

const API = (process.env.API_URL || `http://localhost:${config.port}`) + '/api';
const PASSWORD = 'Password123!';
let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => { if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else { failures.push(name); console.log(`  FAIL  ${name} ${detail}`); } };
async function call(method, url, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + url, { method, headers, body: json ? JSON.stringify(json) : undefined });
  let body = null;
  try { body = await res.json(); } catch { /* none */ }
  return { status: res.status, body, data: body?.data };
}
const login = async (role, email) => (await call('POST', `/auth/${role}/login`, { json: { email, password: PASSWORD } })).data.token;
const plus = (n) => { const d = new Date(`${availability.today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const carBody = { make: 'Test', model: 'Manage', year: 2022, type: 'Sedan', seats: 5, doors: 4, transmission: 'Automatic', fuelType: 'Petrol', dailyPrice: 50, location: 'Islamabad' };

(async () => {
  const p1 = await login('partner', 'partner1@capitalcarsharing.com');
  const p2 = await login('partner', 'partner2@capitalcarsharing.com');
  const cust = await login('customer', 'customer1@capitalcarsharing.com');
  const admin = await login('admin', 'admin@capitalcarsharing.com');
  const customerId = (await query(`SELECT id FROM users WHERE email = 'customer1@capitalcarsharing.com'`)).rows[0].id;
  const partner1Id = (await query(`SELECT p.id FROM partners p JOIN users u ON u.id = p.user_id WHERE u.email = 'partner1@capitalcarsharing.com'`)).rows[0].id;

  const car = (await call('POST', '/partners/me/cars', { token: p1, json: carBody })).data.car;
  const otherCar = (await call('POST', '/partners/me/cars', { token: p2, json: { ...carBody, model: 'Other' } })).data.car;
  await call('PATCH', `/admin/cars/${car.id}/approve`, { token: admin }); // published, so customers can find it
  const base = `/partners/me/cars/${car.id}/availability`;
  const put = (token, json, id = car.id) => call('PUT', `/partners/me/cars/${id}/availability`, { token, json });
  const get = (token, qs = '', id = car.id) => call('GET', `/partners/me/cars/${id}/availability${qs}`, { token });
  const pub = (qs = '') => call('GET', `/cars/${car.id}/availability${qs}`);
  const inSearch = async (from, to) => ((await call('GET', `/cars?pickupDate=${from}&returnDate=${to}&limit=50`)).data?.cars || []).some((c) => c.id === car.id);
  const reserve = async (status, from, to, extra = '') => (await pool.query(
    `INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, return_date, status, daily_price, subtotal_amount, total_price, rental_days${extra ? ', booking_type' : ''})
     VALUES ($1, $2, $3, 'Islamabad', $4, $5, $6, 50, 150, 150, 3${extra ? `, '${extra}'` : ''}) RETURNING id`,
    [customerId, partner1Id, car.id, from, to, status])).rows[0].id;
  const bookedOn = async (d) => (await pub(`?startDate=${d}&endDate=${d}`)).data.bookedDates.includes(d);

  try {
    console.log('\n1. Partner views own cars');
    const mine = await call('GET', '/partners/me/cars', { token: p1 });
    check('own car is listed with today\'s availability', mine.status === 200 && mine.data.cars.some((c) => c.id === car.id && c.availabilityToday));
    check("another partner's car is not listed", !mine.data.cars.some((c) => c.id === otherCar.id));

    console.log('\n2. Partner views car availability');
    const a = await get(p1, `?startDate=${plus(1)}&endDate=${plus(5)}`);
    check('200 with the documented shape for 5 days', a.status === 200 && a.data.availableDates.length === 5 && Array.isArray(a.data.blockedDetails));

    console.log('\n3. Partner blocks available dates (reason, ranges, persistence)');
    let r = await put(p1, { dates: [plus(10), plus(11)], status: 'unavailable', reason: '  Family trip  ', partnerId: 999999 });
    const detail = (d, date) => d.blockedDetails?.find((x) => x.date === date);
    check('blocked, reason stored trimmed', r.status === 200 && r.data.unavailableDates.includes(plus(10)) && detail(r.data, plus(10))?.reason === 'Family trip', JSON.stringify(r.body));
    check('public availability shows the days as unavailable but never the reason', (await pub(`?startDate=${plus(10)}&endDate=${plus(11)}`)).data.unavailableDates.length === 2 && !JSON.stringify((await pub()).body).includes('Family trip'));
    const row = (await query(`SELECT reason, blocked_by FROM availability WHERE car_id = $1 AND date = $2`, [car.id, plus(10)])).rows[0];
    check('blocked_by is the session user (a partnerId in the body is ignored)', row && row.blockedBy > 0 && row.blockedBy !== 999999);
    r = await put(p1, { startDate: plus(20), endDate: plus(24), status: 'unavailable', reason: 'Service' });
    check('range block of 5 days', r.status === 200 && [20, 21, 22, 23, 24].every((n) => r.data.unavailableDates.includes(plus(n))));
    r = await put(p1, { dates: [plus(10)], status: 'unavailable', reason: 'Maintenance' });
    check('re-blocking updates the reason', detail(r.data, plus(10))?.reason === 'Maintenance');

    console.log('\n4. Partner removes blocked dates');
    r = await put(p1, { startDate: plus(20), endDate: plus(24), status: 'available' });
    check('range re-opened and its rows (and reasons) are gone', r.status === 200 && (await query(`SELECT 1 FROM availability WHERE car_id = $1 AND date = $2`, [car.id, plus(22)])).rowCount === 0);

    console.log('\n5. Partner cannot block booked dates');
    const confirmed = await reserve('confirmed', plus(40), plus(42));
    r = await put(p1, { startDate: plus(38), endDate: plus(44), status: 'unavailable', reason: 'x' });
    check('range touching a booked day -> 409 naming the booked date', r.status === 409 && r.body.message.includes(plus(40)), JSON.stringify(r.body));
    check('nothing in that range was written (transaction)', (await get(p1, `?startDate=${plus(38)}&endDate=${plus(44)}`)).data.unavailableDates.length === 0);
    check('re-opening a booked day -> 409', (await put(p1, { dates: [plus(41)], status: 'available' })).status === 409);

    console.log('\n6. Another partner\'s car is rejected');
    check("partner 2 cannot read partner 1's calendar (404)", (await get(p2)).status === 404);
    check("partner 2 cannot block partner 1's days (404)", (await put(p2, { dates: [plus(50)], status: 'unavailable' })).status === 404);
    check("partner 2 cannot re-open partner 1's blocks (404)", (await put(p2, { dates: [plus(10)], status: 'available' })).status === 404);
    check('and the blocks are untouched', (await get(p1, `?startDate=${plus(10)}&endDate=${plus(10)}`)).data.unavailableDates.length === 1);
    check('a car id that does not exist -> 404', (await get(p1, '', 99999999)).status === 404);

    console.log('\n7. Confirmed bookings block dates');
    check('partner calendar shows the 3 booked days', (await get(p1, `?startDate=${plus(40)}&endDate=${plus(42)}`)).data.bookedDates.length === 3);
    check('customer availability shows them booked', (await pub(`?startDate=${plus(40)}&endDate=${plus(42)}`)).data.bookedDates.length === 3);

    console.log('\n8. Advance reservations block dates');
    const advance = await reserve('pending', plus(60), plus(61), 'advance');
    check('an advance (pending) reservation shows as booked in partner and customer calendars', (await get(p1, `?startDate=${plus(60)}&endDate=${plus(61)}`)).data.bookedDates.length === 2 && (await bookedOn(plus(60))));
    check('and the partner cannot block it', (await put(p1, { dates: [plus(60)], status: 'unavailable' })).status === 409);

    console.log('\n9. Cancelled / rejected bookings update availability');
    check('before: customer search hides the car for the advance dates', (await inSearch(plus(60), plus(61))) === false);
    await pool.query(`INSERT INTO availability (car_id, date, status) VALUES ($1, $2, 'booked'), ($1, $3, 'booked') ON CONFLICT (car_id, date) DO UPDATE SET status = 'booked'`, [car.id, plus(60), plus(61)]); // stale copy, as older data/seed scripts wrote
    let c = await call('POST', `/customers/me/reservations/${advance}/cancel`, { token: cust, json: { reason: 'Plans changed' } });
    check('customer cancels the advance reservation', c.status === 200 && c.data.reservation?.status === 'cancelled', JSON.stringify(c.body));
    check('its days are free again for the customer', (await bookedOn(plus(60))) === false);
    check("including the stale 'booked' rows", (await query(`SELECT 1 FROM availability WHERE car_id = $1 AND status = 'booked'`, [car.id])).rowCount === 0);
    check('and the partner can block them now', (await put(p1, { dates: [plus(60)], status: 'unavailable' })).status === 200);
    await put(p1, { dates: [plus(60)], status: 'available' });
    const toReject = await reserve('pending', plus(70), plus(71));
    check('pending booking holds its days', await bookedOn(plus(70)));
    const rej = await call('PATCH', `/partners/me/reservations/${toReject}/reject`, { token: p1, json: { reason: 'Car is in the workshop' } });
    check('partner rejects it', rej.status === 200 && rej.data.reservation?.status === 'rejected', JSON.stringify(rej.body));
    check('rejected booking releases its days', (await bookedOn(plus(70))) === false);
    check("another partner cannot reject partner 1's booking (404)", (await call('PATCH', `/partners/me/reservations/${confirmed}/reject`, { token: p2, json: { reason: 'nope nope' } })).status === 404);

    console.log('\n10. Customer search reflects availability changes');
    check('open dates: the car is in search results', await inSearch(plus(80), plus(82)));
    await put(p1, { startDate: plus(80), endDate: plus(82), status: 'unavailable', reason: 'Holiday' });
    check('after the partner blocks them: the car disappears from search', (await inSearch(plus(80), plus(82))) === false);
    await put(p1, { startDate: plus(80), endDate: plus(82), status: 'available' });
    check('after the partner re-opens them: it is back', await inSearch(plus(80), plus(82)));
    check('a confirmed booking hides the car for those dates', (await inSearch(plus(40), plus(42))) === false);
    check('a window overlapping only one booked day also hides it', (await inSearch(plus(42), plus(45))) === false);

    console.log('\nOverlapping bookings are prevented by PostgreSQL itself');
    const guard = (await query(`SELECT 1 FROM pg_constraint WHERE conname = 'reservations_no_overlap'`)).rowCount > 0;
    if (!guard) console.log('  SKIP  reservations_no_overlap constraint is not installed in this database (see migration 004/005 warnings); API row locking still applies');
    else {
      let code;
      try { await reserve('pending', plus(41), plus(43)); } catch (e) { code = e.code; }
      check('an overlapping pending booking is rejected by the database (23P01)', code === '23P01', String(code));
    }

    console.log('\n11. Unauthorized requests are rejected');
    check('no token: list cars -> 401', (await call('GET', '/partners/me/cars')).status === 401);
    check('no token: read availability -> 401', (await call('GET', base)).status === 401);
    check('no token: change availability -> 401', (await call('PUT', base, { json: { dates: [plus(5)], status: 'unavailable' } })).status === 401);
    check('garbage token -> 401', (await call('GET', base, { token: 'not.a.jwt' })).status === 401);
    check('customer token -> 403', (await put(cust, { dates: [plus(5)], status: 'unavailable' })).status === 403 && (await call('GET', '/partners/me/cars', { token: cust })).status === 403);
    check('admin token -> 403 on partner routes', (await put(admin, { dates: [plus(5)], status: 'unavailable' })).status === 403);
    console.log('  validation');
    check('past date -> 422', (await put(p1, { dates: [plus(-1)], status: 'unavailable' })).status === 422);
    check('today -> accepted', (await put(p1, { dates: [availability.today()], status: 'unavailable' })).status === 200);
    check('end before start -> 422', (await put(p1, { startDate: plus(8), endDate: plus(3), status: 'unavailable' })).status === 422);
    check('range over 366 days -> 422', (await put(p1, { startDate: plus(1), endDate: plus(400), status: 'unavailable' })).status === 422);
    check('impossible date -> 422', (await put(p1, { dates: ['2031-02-30'], status: 'unavailable' })).status === 422);
    check('reason with status available -> 422', (await put(p1, { dates: [plus(30)], status: 'available', reason: 'x' })).status === 422);
    check('reason over 200 chars -> 422', (await put(p1, { dates: [plus(30)], status: 'unavailable', reason: 'x'.repeat(201) })).status === 422);
    check('dates + range together -> 422', (await put(p1, { dates: [plus(30)], startDate: plus(30), endDate: plus(31), status: 'unavailable' })).status === 422);
    check('status "booked" cannot be set by a partner -> 422', (await put(p1, { dates: [plus(30)], status: 'booked' })).status === 422);
    check('non-numeric car id -> 422', (await call('GET', '/partners/me/cars/abc/availability', { token: p1 })).status === 422);

    console.log('\n12. Database persistence');
    const fresh = await login('partner', 'partner1@capitalcarsharing.com'); // a brand-new session
    const again = await call('GET', `${base}?startDate=${plus(10)}&endDate=${plus(11)}`, { token: fresh });
    check('blocks (and reasons) are still there for a new session', again.data.unavailableDates.length === 2 && again.data.blockedDetails.length === 2);
    const rows = (await query(`SELECT COUNT(*) AS n FROM availability WHERE car_id = $1 AND status = 'unavailable' AND date IN ($2, $3)`, [car.id, plus(10), plus(11)])).rows[0];
    check('and they are real rows in PostgreSQL', Number(rows.n) === 2);
    const hist = (await query(`SELECT COUNT(*) AS n FROM reservation_status_history WHERE reservation_id IN ($1, $2)`, [advance, toReject])).rows[0];
    check('cancel/reject wrote status history rows', Number(hist.n) >= 2);
  } finally {
    await pool.query('DELETE FROM reservations WHERE car_id = $1', [car.id]);
    await pool.query('DELETE FROM cars WHERE id IN ($1, $2)', [car.id, otherCar.id]);
    await pool.end();
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { console.log(failures.map((f) => ` - ${f}`).join('\n')); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exitCode = 1; });
