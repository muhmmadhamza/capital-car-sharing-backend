// End-to-end check of the car availability API against a RUNNING API and its PostgreSQL database.
//   npm run db:setup (once) -> npm run dev -> npm run test:availability
// Uses the seeded demo accounts. Creates its own cars/reservations and removes them afterwards.
require('dotenv').config();
const config = require('../src/config/env');
const { query, withTransaction, pool } = require('../src/database/pool');
const availability = require('../src/services/availability.service');

const API = (process.env.API_URL || `http://localhost:${config.port}`) + '/api';
const PASSWORD = 'Password123!';
let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else { failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
};

async function call(method, url, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + url, { method, headers, body: json ? JSON.stringify(json) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* none */ }
  return { status: res.status, body: data, data: data?.data };
}
const login = async (role, email) => (await call('POST', `/auth/${role}/login`, { json: { email, password: PASSWORD } })).data.token;
const carBody = (over = {}) => ({ make: 'Test', model: 'Avail', year: 2022, type: 'Sedan', seats: 5, doors: 4, transmission: 'Automatic', fuelType: 'Petrol', dailyPrice: 50, location: 'Islamabad', ...over });
const range = (from, n) => Array.from({ length: n }, (_, i) => { const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
const SHAPE = ['carId', 'startDate', 'endDate', 'availableDates', 'unavailableDates', 'bookedDates'];
const isShape = (d) => d && SHAPE.every((k) => k in d) && ['availableDates', 'unavailableDates', 'bookedDates'].every((k) => Array.isArray(d[k]));
const partitions = (d, from, to) => {
  const all = [...d.availableDates, ...d.unavailableDates, ...d.bookedDates].sort();
  const want = range(from, (new Date(to) - new Date(from)) / 86400000 + 1);
  return JSON.stringify(all) === JSON.stringify(want);
};

(async () => {
  const p1 = await login('partner', 'partner1@capitalcarsharing.com');
  const p2 = await login('partner', 'partner2@capitalcarsharing.com');
  const cust = await login('customer', 'customer1@capitalcarsharing.com');
  const admin = await login('admin', 'admin@capitalcarsharing.com');
  const customerId = (await query(`SELECT id FROM users WHERE email = 'customer1@capitalcarsharing.com'`)).rows[0].id;
  const partner1Id = (await query(`SELECT p.id FROM partners p JOIN users u ON u.id = p.user_id WHERE u.email = 'partner1@capitalcarsharing.com'`)).rows[0].id;

  const make = async (token, over) => (await call('POST', '/partners/me/cars', { token, json: carBody(over) })).data.car;
  const published = await make(p1);                       // will be approved
  const pending = await make(p1);                         // stays pending = unpublished
  const rejected = await make(p1);
  const suspended = await make(p1);
  const inactive = await make(p1);
  await call('PATCH', `/admin/cars/${published.id}/approve`, { token: admin });
  await call('PATCH', `/admin/cars/${rejected.id}/reject`, { token: admin });
  await call('PATCH', `/admin/cars/${suspended.id}/suspend`, { token: admin });
  await call('PATCH', `/admin/cars/${inactive.id}/approve`, { token: admin });
  await call('PUT', `/partners/me/cars/${inactive.id}`, { token: p1, json: { status: 'inactive' } });
  const ids = [published, pending, rejected, suspended, inactive].map((c) => c.id);
  const pub = (id, qs = '') => call('GET', `/cars/${id}/availability${qs}`);
  const mine = (token, id, qs = '') => call('GET', `/partners/me/cars/${id}/availability${qs}`, { token });
  const put = (token, id, dates, status) => call('PUT', `/partners/me/cars/${id}/availability`, { token, json: { dates, status } });

  const A = '2031-03-10', B = '2031-03-14';
  try {
    console.log('\nPublic endpoint: published car');
    const r = await pub(published.id, `?startDate=${A}&endDate=${B}`);
    check('200 with the documented shape', r.status === 200 && isShape(r.data) && r.data.carId === published.id, JSON.stringify(r.body));
    check('range filter: exactly 5 days, startDate/endDate echoed', r.data.startDate === A && r.data.endDate === B && partitions(r.data, A, B));
    check('every day available when nothing is blocked', r.data.availableDates.length === 5);
    const narrow = await pub(published.id, '?startDate=2031-03-12&endDate=2031-03-12');
    check('single-day range returns one day', narrow.status === 200 && narrow.data.availableDates.length === 1 && narrow.data.availableDates[0] === '2031-03-12');
    const dflt = await pub(published.id);
    const total = (d) => d.availableDates.length + d.unavailableDates.length + d.bookedDates.length;
    check('no params -> default window starting today (91 days)', dflt.status === 200 && total(dflt.data) === 91 && dflt.data.startDate === availability.today() && dflt.data.today === availability.today());
    const only = await pub(published.id, `?startDate=${A}`);
    check('startDate only -> default length after it', only.status === 200 && only.data.startDate === A && total(only.data) === 91);

    console.log('\nPublic endpoint: nothing private leaks for unpublished cars');
    const missing = await pub(99999999);
    for (const [name, c] of [['pending', pending], ['rejected', rejected], ['suspended (by admin)', suspended], ['inactive (by partner)', inactive]]) {
      const x = await pub(c.id, `?startDate=${A}&endDate=${B}`);
      check(`${name} car -> 404, same body as a car that does not exist`, x.status === 404 && JSON.stringify(x.body) === JSON.stringify(missing.body), JSON.stringify(x.body));
    }
    check('unknown id -> 404', missing.status === 404);

    console.log('\nValidation (422)');
    const bad = [
      ['id "abc"', '/cars/abc/availability'], ['id 0', '/cars/0/availability'], ['id -3', '/cars/-3/availability'], ['id 1.5', '/cars/1.5/availability'],
      ['startDate 03/10/2031', `/cars/${published.id}/availability?startDate=03/10/2031`], ['startDate 2031-3-1', `/cars/${published.id}/availability?startDate=2031-3-1`],
      ['startDate 2031-02-30 (not a real day)', `/cars/${published.id}/availability?startDate=2031-02-30`], ['endDate garbage', `/cars/${published.id}/availability?startDate=${A}&endDate=soon`],
      ['endDate before startDate', `/cars/${published.id}/availability?startDate=${B}&endDate=${A}`], ['range over 366 days', `/cars/${published.id}/availability?startDate=2031-01-01&endDate=2032-06-01`],
      ['startDate given twice', `/cars/${published.id}/availability?startDate=${A}&startDate=${B}`], ['SQL-ish startDate', `/cars/${published.id}/availability?startDate=${encodeURIComponent("2031-01-01';DROP TABLE cars;--")}`],
    ];
    for (const [name, url] of bad) { const x = await call('GET', url); check(`${name} -> 422`, x.status === 422 && x.body.success === false, `${x.status}`); }
    const edge = await pub(published.id, '?startDate=2031-01-01&endDate=2032-01-02');
    check('exactly 366 days apart is still accepted', edge.status === 200);
    const bad2 = await mine(p1, 'abc');
    check('partner endpoint: bad id -> 422', bad2.status === 422);
    check('partner endpoint: bad date -> 422', (await mine(p1, pending.id, '?endDate=nope')).status === 422);

    console.log('\nPartner endpoint: own cars in every publish state (the reported bug)');
    for (const [name, c] of [['published', published], ['pending (unpublished)', pending], ['rejected', rejected], ['suspended', suspended], ['inactive', inactive]]) {
      const x = await mine(p1, c.id, `?startDate=${A}&endDate=${B}`);
      check(`${name} car -> 200, same shape, 5 days`, x.status === 200 && isShape(x.data) && x.data.carId === c.id && partitions(x.data, A, B), JSON.stringify(x.body));
    }
    const sameShape = await mine(p1, published.id, `?startDate=${A}&endDate=${B}`);
    check('partner response is identical to the public response for a published car', JSON.stringify(sameShape.data) === JSON.stringify(r.data));

    console.log('\nAuthentication and authorization');
    check('no token -> 401', (await mine(undefined, pending.id)).status === 401);
    check('invalid token -> 401', (await mine('abc.def.ghi', pending.id)).status === 401);
    check('customer -> 403', (await mine(cust, pending.id)).status === 403);
    check('admin -> 403 (partner-only route, existing role rules)', (await mine(admin, pending.id)).status === 403);
    const other = await mine(p2, pending.id);
    check("another partner's car -> 404 (existence not revealed)", other.status === 404 && JSON.stringify(other.body) === JSON.stringify((await mine(p2, 99999999)).body));
    check('write: no token -> 401', (await put(undefined, pending.id, [A], 'unavailable')).status === 401);
    check('write: customer -> 403', (await put(cust, pending.id, [A], 'unavailable')).status === 403);
    check('write: admin -> 403', (await put(admin, pending.id, [A], 'unavailable')).status === 403);
    const w = await put(p2, pending.id, [A], 'unavailable');
    check("write: another partner's car -> 404 and nothing stored", w.status === 404 && (await query('SELECT 1 FROM availability WHERE car_id = $1', [pending.id])).rowCount === 0);

    console.log('\nManaging dates (own cars, including unpublished)');
    const blockU = ['2031-03-11', '2031-03-12'];
    check('block 2 days on the UNPUBLISHED car -> 200', (await put(p1, pending.id, blockU, 'unavailable')).status === 200);
    const afterU = await mine(p1, pending.id, `?startDate=${A}&endDate=${B}`);
    check('partner sees them as unavailable, the rest available', JSON.stringify(afterU.data.unavailableDates) === JSON.stringify(blockU) && afterU.data.availableDates.length === 3);
    check('unpublished car stays private after being edited', (await pub(pending.id, `?startDate=${A}&endDate=${B}`)).status === 404);
    await put(p1, published.id, blockU, 'unavailable');
    const pubAfter = await pub(published.id, `?startDate=${A}&endDate=${B}`);
    check('published car: the public endpoint reflects the blocked days', JSON.stringify(pubAfter.data.unavailableDates) === JSON.stringify(blockU));
    const outside = await pub(published.id, '?startDate=2031-03-13&endDate=2031-03-14');
    check('range filtering excludes blocked days outside the range', outside.data.unavailableDates.length === 0 && outside.data.availableDates.length === 2);
    await put(p1, published.id, ['2031-03-11'], 'available');
    check('re-opening a day makes it available again', JSON.stringify((await pub(published.id, `?startDate=${A}&endDate=${B}`)).data.unavailableDates) === JSON.stringify(['2031-03-12']));
    check('invalid body (bad date) -> 422', (await put(p1, published.id, ['2031-13-01'], 'unavailable')).status === 422);
    check('invalid body (bad status) -> 422', (await put(p1, published.id, [A], 'booked')).status === 422);
    check('invalid body (empty dates) -> 422', (await put(p1, published.id, [], 'unavailable')).status === 422);

    console.log("\nMy Cars: today's status comes from the calendar data, separate from approval status");
    const TODAY = availability.today();
    const card = async (id) => (await call('GET', '/partners/me/cars', { token: p1 })).data.cars.find((c) => c.id === id);
    const cal = async (id) => { const x = (await mine(p1, id, `?startDate=${TODAY}&endDate=${TODAY}`)).data; return x.bookedDates.length ? 'booked' : x.unavailableDates.length ? 'unavailable' : 'available'; };
    let c0 = await card(pending.id);
    check('pending car with no blocked days: availabilityToday is available (not guessed from approval)', c0.approvalStatus === 'pending' && c0.availabilityToday?.status === 'available' && c0.availabilityToday.date === TODAY, JSON.stringify(c0.availabilityToday));
    await put(p1, pending.id, [TODAY], 'unavailable');
    c0 = await card(pending.id);
    check('block today -> card says unavailable, calendar agrees', c0.availabilityToday.status === 'unavailable' && (await cal(pending.id)) === 'unavailable');
    await put(p1, pending.id, [TODAY], 'available');
    c0 = await card(pending.id);
    check('mark today available -> card says available, calendar agrees', c0.availabilityToday.status === 'available' && (await cal(pending.id)) === 'available');
    check('...and the car is STILL pending, not published', c0.approvalStatus === 'pending' && (await pub(pending.id)).status === 404);
    check('single-car endpoint returns the same status', (await call('GET', `/partners/me/cars/${pending.id}`, { token: p1 })).data.car.availabilityToday.status === 'available');
    await query(`INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, return_date, status, daily_price, total_price)
                 VALUES ($1, $2, $3, 'Islamabad', $4, $4, 'active', 50, 50)`, [customerId, partner1Id, suspended.id, TODAY]);
    check('a reservation covering today -> booked on the card and in the calendar', (await card(suspended.id)).availabilityToday.status === 'booked' && (await cal(suspended.id)) === 'booked');
    const everyCar = (await call('GET', '/partners/me/cars', { token: p1 })).data.cars;
    let agree = true;
    for (const c of everyCar) if (c.availabilityToday?.status !== (await cal(c.id))) agree = false;
    check('every listed car: card status equals calendar status for today', agree && everyCar.every((c) => c.availabilityToday));

    console.log('\nReservations: booked days are read live and cannot be changed');
    const addRes = (carId, from, to, status = 'upcoming') =>
      query(`INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, return_date, status, daily_price, total_price)
             VALUES ($1, $2, $3, 'Islamabad', $4, $5, $6, 50, 100) RETURNING id`, [customerId, partner1Id, carId, from, to, status]);
    await addRes(published.id, '2031-03-13', '2031-03-14');                 // upcoming -> booked
    await addRes(published.id, '2031-03-10', '2031-03-10', 'cancelled');    // cancelled -> NOT booked
    await addRes(published.id, '2031-03-11', '2031-03-11', 'completed');    // completed -> NOT booked
    const withRes = await pub(published.id, `?startDate=${A}&endDate=${B}`);
    check('upcoming reservation shows as booked (public)', JSON.stringify(withRes.data.bookedDates) === JSON.stringify(['2031-03-13', '2031-03-14']));
    check('cancelled and completed reservations do not block', withRes.data.availableDates.includes('2031-03-10') && withRes.data.availableDates.includes('2031-03-11'));
    check('partner endpoint agrees', JSON.stringify((await mine(p1, published.id, `?startDate=${A}&endDate=${B}`)).data) === JSON.stringify(withRes.data));
    const clash = await put(p1, published.id, ['2031-03-10', '2031-03-14'], 'unavailable');
    check('blocking a booked day -> 409 naming the day', clash.status === 409 && /2031-03-14/.test(clash.body.message), JSON.stringify(clash.body));
    check('the refused request changed nothing (2031-03-10 not blocked)', !(await pub(published.id, `?startDate=${A}&endDate=${B}`)).data.unavailableDates.includes('2031-03-10'));
    check('re-opening a booked day -> 409', (await put(p1, published.id, ['2031-03-13'], 'available')).status === 409);
    await query(`INSERT INTO availability (car_id, date, status) VALUES ($1, '2031-03-10', 'booked')`, [published.id]);
    check("an availability row marked 'booked' also counts and is protected", (await pub(published.id, `?startDate=${A}&endDate=${A}`)).data.bookedDates.length === 1 && (await put(p1, published.id, [A], 'unavailable')).status === 409);
    await query(`DELETE FROM availability WHERE car_id = $1 AND status = 'booked'`, [published.id]);

    console.log('\nBooking guard for the future reservation module (assertRangeFree)');
    const free = (from, to) => withTransaction((q) => availability.assertRangeFree(q, published.id, from, to));
    const fails = async (from, to) => { try { await free(from, to); return null; } catch (e) { return e; } };
    check('a free range passes', (await fails('2031-04-01', '2031-04-05')) === null);
    check('a range touching a reservation is refused (409)', (await fails('2031-03-12', '2031-03-13'))?.statusCode === 409);
    check('a range touching a blocked day is refused (409)', (await fails('2031-03-12', '2031-03-12'))?.statusCode === 409);
    check('return before pickup is refused (400)', (await fails('2031-04-05', '2031-04-01'))?.statusCode === 400);

    console.log('\nBlocking and booking at the same moment cannot both win');
    const day = '2031-05-20';
    const booking = withTransaction(async (q) => {
      await q('SELECT id FROM cars WHERE id = $1 FOR UPDATE', [published.id]);
      await availability.assertRangeFree(q, published.id, day, day);
      await new Promise((r) => setTimeout(r, 400)); // the booking is "in progress"
      await q(`INSERT INTO reservations (customer_id, partner_id, car_id, pickup_location, pickup_date, return_date, status, daily_price, total_price)
               VALUES ($1, $2, $3, 'Islamabad', $4, $4, 'upcoming', 50, 50)`, [customerId, partner1Id, published.id, day]);
    });
    await new Promise((r) => setTimeout(r, 100));
    const blockWhileBooking = await put(p1, published.id, [day], 'unavailable');
    await booking;
    check('the block request waited for the booking, then was refused (409)', blockWhileBooking.status === 409, JSON.stringify(blockWhileBooking.body));
    check('the day ends up booked, not blocked', (await pub(published.id, `?startDate=${day}&endDate=${day}`)).data.bookedDates.length === 1);
  } finally {
    await query('DELETE FROM reservations WHERE car_id = ANY($1::int[])', [ids]);
    await query('DELETE FROM cars WHERE id = ANY($1::int[])', [ids]);
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
  await pool.end();
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => { console.error('Test run crashed:', e); await pool.end().catch(() => {}); process.exit(1); });
