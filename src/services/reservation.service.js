const { query, withTransaction } = require('../database/pool');
const config = require('../config/env');
const rules = require('../config/booking');
const { unprocessable, notFound, conflict, forbidden } = require('../utils/errors');
const R = require('../utils/bookingRules');
const availability = require('./availability.service');
const verificationService = require('./verification.service');

// Current wall-clock time ("YYYY-MM-DDTHH:mm") in the business time zone: what "in the future" means for a pickup.
function nowWall(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.businessTimeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

// Shared by every list and detail, so all three roles see the same fields (and stay in sync: one table, read live).
const COLUMNS = `
  r.id, r.booking_reference, r.customer_id, r.partner_id, r.car_id, r.pickup_location,
  r.pickup_date, to_char(r.pickup_time, 'HH24:MI') AS pickup_time,
  r.return_date, to_char(r.return_time, 'HH24:MI') AS return_time,
  r.status, r.daily_price, r.rental_days, r.subtotal_amount, r.service_fee_amount, r.tax_amount, r.total_price,
  r.created_at, r.updated_at,
  (SELECT h.reason FROM reservation_status_history h WHERE h.reservation_id = r.id ORDER BY h.id DESC LIMIT 1) AS status_reason,
  c.make AS car_make, c.model AS car_model, c.year AS car_year, c.type AS car_type,
  (SELECT ci.image_url FROM car_images ci WHERE ci.car_id = c.id ORDER BY ci.sort_order, ci.id LIMIT 1) AS car_image,
  p.company_name AS partner_company_name`;
const FROM = `
  FROM reservations r
  JOIN cars c ON c.id = r.car_id
  JOIN partners p ON p.id = r.partner_id`;

// What each role may see. A customer sees their own booking; a partner also the customer's contact details
// (needed to hand the car over); an admin also the partner's contact details.
const RESERVATION_SELECT = `SELECT ${COLUMNS} ${FROM}`;
const PARTNER_SELECT = `SELECT ${COLUMNS},
  cu.name AS customer_name, cu.email AS customer_email, cu.phone AS customer_phone, c.location AS car_location
  ${FROM} JOIN users cu ON cu.id = r.customer_id`;
const ADMIN_SELECT = `SELECT ${COLUMNS},
  cu.name AS customer_name, cu.email AS customer_email, cu.phone AS customer_phone, c.location AS car_location,
  pu.name AS partner_name, pu.email AS partner_email, pu.phone AS partner_phone
  ${FROM} JOIN users cu ON cu.id = r.customer_id JOIN users pu ON pu.id = p.user_id`;

const paging = ({ page, limit }) => {
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  return { pg, lim, offset: (pg - 1) * lim };
};
const pageMeta = (pg, lim, total) => ({ page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) });

// ---------------------------------------------------------------------------------------------- reads

async function listForCustomer(customerId, { status } = {}) {
  const params = [customerId];
  let where = 'r.customer_id = $1';
  if (status) {
    params.push(status);
    where += ` AND r.status = $${params.length}`;
  }
  const { rows } = await query(`${RESERVATION_SELECT} WHERE ${where} ORDER BY r.pickup_date DESC, r.id DESC`, params);
  return rows;
}

// A reservation that belongs to someone else answers 404, exactly like one that does not exist.
async function getForCustomer(customerId, id) {
  const { rows } = await query(`${RESERVATION_SELECT} WHERE r.id = $1 AND r.customer_id = $2`, [id, customerId]);
  if (!rows[0]) throw notFound('Reservation not found');
  return rows[0];
}

// Status change log of one booking, oldest first. Names are only shown to partners and admins; a customer sees the role.
async function historyOf(reservationId, { names }) {
  const { rows } = await query(
    `SELECT h.id, h.from_status, h.to_status, h.changed_by_role, h.reason, h.created_at
            ${names ? ', u.name AS changed_by_name' : ''}
     FROM reservation_status_history h ${names ? 'LEFT JOIN users u ON u.id = h.changed_by' : ''}
     WHERE h.reservation_id = $1 ORDER BY h.id ASC`,
    [reservationId]
  );
  return rows;
}

// Customer view of one booking: includes its history and whether the cancel button should be offered.
async function detailForCustomer(customerId, id) {
  const r = await getForCustomer(customerId, id);
  r.history = await historyOf(r.id, { names: false });
  r.canCancel = R.customerCanCancel({ status: r.status, pickupAt: R.wall(r.pickupDate, r.pickupTime) }, nowWall(), rules);
  return r;
}

// Builds the WHERE of the partner and admin lists. Every value is a bound parameter.
function listFilters(opts, scope) {
  const params = [];
  const where = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (scope.partnerId) add('r.partner_id = ?', scope.partnerId);
  if (opts.status) {
    if (!R.STATUSES.includes(opts.status)) throw unprocessable(`status must be one of: ${R.STATUSES.join(', ')}`);
    add('r.status = ?', opts.status);
  }
  for (const [key, column] of [['customerId', 'r.customer_id'], ['carId', 'r.car_id'], ['partnerId', 'r.partner_id']]) {
    if (opts[key] === undefined || opts[key] === '' || (key === 'partnerId' && scope.partnerId)) continue;
    const n = Number(opts[key]);
    if (!Number.isInteger(n) || n < 1) throw unprocessable(`${key} must be a positive whole number`);
    add(`${column} = ?`, n);
  }
  if (opts.search) {
    const term = String(opts.search).trim().slice(0, 100);
    if (term) {
      params.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
      const p = `$${params.length}`;
      where.push(`(r.booking_reference ILIKE ${p} OR cu.name ILIKE ${p} OR cu.email ILIKE ${p} OR (c.make || ' ' || c.model) ILIKE ${p})`);
    }
  }
  return { params, where: where.length ? where.join(' AND ') : 'TRUE' };
}

async function listWith(select, countFrom, opts, scope) {
  const { pg, lim, offset } = paging(opts);
  const { params, where } = listFilters(opts, scope);
  const total = (await query(`SELECT COUNT(*) AS total ${countFrom} WHERE ${where}`, params)).rows[0].total;
  const { rows } = await query(`${select} WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${lim} OFFSET ${offset}`, params);
  return { reservations: rows, meta: pageMeta(pg, lim, total) };
}
const COUNT_FROM = `FROM reservations r JOIN cars c ON c.id = r.car_id JOIN users cu ON cu.id = r.customer_id`;

// A partner only ever sees bookings of their own cars: partner_id comes from the session, never from the request.
const listForPartner = (partnerId, opts = {}) => listWith(PARTNER_SELECT, COUNT_FROM, opts, { partnerId });
async function getForPartner(partnerId, id) {
  const { rows } = await query(`${PARTNER_SELECT} WHERE r.id = $1 AND r.partner_id = $2`, [id, partnerId]);
  if (!rows[0]) throw notFound('Reservation not found'); // someone else's booking looks exactly like a missing one
  rows[0].history = await historyOf(id, { names: true });
  return rows[0];
}

const listForAdmin = (opts = {}) => listWith(ADMIN_SELECT, COUNT_FROM, opts, {});
async function getForAdmin(id) {
  const { rows } = await query(`${ADMIN_SELECT} WHERE r.id = $1`, [id]);
  if (!rows[0]) throw notFound('Reservation not found');
  rows[0].history = await historyOf(id, { names: true });
  return rows[0];
}

// Counts per status for a dashboard. `upcoming` = confirmed bookings that have not started yet.
async function statsForPartner(partnerId) {
  const { rows } = await query(
    `SELECT status, COUNT(*) AS n FROM reservations WHERE partner_id = $1 GROUP BY status`, [partnerId]);
  const out = Object.fromEntries(R.STATUSES.map((s) => [s, 0]));
  for (const row of rows) out[row.status] = row.n;
  const { rows: up } = await query(
    `SELECT COUNT(*) AS n FROM reservations WHERE partner_id = $1 AND status = 'confirmed' AND return_date >= $2::date`,
    [partnerId, nowWall().slice(0, 10)]);
  return { total: Object.values(out).reduce((a, b) => a + b, 0), ...out, upcoming: up[0].n };
}

// ---------------------------------------------------------------------------------------- validation

// Business-rule validation of the requested window. Shape errors are already caught by the route validator,
// but this runs again so the service is safe to call from anywhere.
function checkWindow(input) {
  const window = {
    pickupDate: input.pickupDate, pickupTime: input.pickupTime,
    returnDate: input.returnDate, returnTime: input.returnTime,
  };
  const errors = R.validateWindow(window, nowWall(), rules);
  if (errors.length) throw unprocessable(errors[0], errors);
  return { ...window, pickupAt: R.wall(window.pickupDate, window.pickupTime), returnAt: R.wall(window.returnDate, window.returnTime) };
}

// The car must be one customers can actually book: active, approved, and owned by an active partner.
// `lock` takes the SAME row lock as availability.setCarDates, so bookings and owner blocks never interleave.
async function loadBookableCar(q, carId, { lock }) {
  const { rows } = await q(
    `SELECT c.id, c.partner_id, c.make, c.model, c.year, c.daily_price, c.location
     FROM cars c JOIN partners p ON p.id = c.partner_id
     WHERE c.id = $1 AND c.status = 'active' AND c.approval_status = 'approved' AND p.status = 'active'
     ${lock ? 'FOR UPDATE OF c' : ''}`,
    [carId]
  );
  if (!rows[0]) throw notFound('This car is not available for booking');
  return rows[0];
}

// ------------------------------------------------------------------------------------------ quote

/**
 * Availability + price for a window, WITHOUT creating anything. Open to every signed-in customer so an unverified
 * customer can still see the price; `eligibility` says whether they may actually book and why not.
 * Price and availability come only from the database.
 */
async function quote(user, input) {
  const w = checkWindow(input);
  const car = await loadBookableCar(query, input.carId, { lock: false });
  await availability.assertRangeFree(query, car.id, w.pickupDate, w.returnDate); // 409 when not free
  const pricing = R.computePrice(car.dailyPrice, w.pickupAt, w.returnAt, rules);

  const verificationStatus = await verificationService.getStatus(user.id);
  return {
    car: { id: car.id, make: car.make, model: car.model, year: car.year, location: car.location },
    pickupDate: w.pickupDate, pickupTime: w.pickupTime,
    returnDate: w.returnDate, returnTime: w.returnTime,
    pricing,
    available: true,
    eligibility: {
      canBook: verificationStatus === 'approved',
      verificationStatus,
      message: verificationStatus === 'approved' ? null : R.bookingBlockedMessage(verificationStatus),
    },
  };
}

// ------------------------------------------------------------------------------------------ create

const REFERENCE_ATTEMPTS = 5;

/**
 * Creates the reservation. The route has already required an approved customer (requireVerifiedCustomer), and
 * nothing the browser sent about price or availability is used.
 *
 *   BEGIN
 *     lock the car row            -> concurrent bookings / owner blocks of THIS car queue up here
 *     re-check the car is bookable
 *     assertRangeFree             -> sees every booking committed before we got the lock
 *     INSERT                      -> reference generated by the database, retried on the rare collision
 *   COMMIT
 * The reservations_no_overlap EXCLUDE constraint backs this up inside PostgreSQL itself.
 */
async function create(user, input) {
  const w = checkWindow(input);

  const id = await withTransaction(async (q) => {
    const car = await loadBookableCar(q, input.carId, { lock: true });
    await availability.assertRangeFree(q, car.id, w.pickupDate, w.returnDate);
    const p = R.computePrice(car.dailyPrice, w.pickupAt, w.returnAt, rules);

    for (let attempt = 1; ; attempt += 1) {
      await q('SAVEPOINT new_reservation');
      try {
        const { rows } = await q(
          `INSERT INTO reservations
             (customer_id, partner_id, car_id, pickup_location, pickup_date, pickup_time, return_date, return_time,
              status, daily_price, rental_days, subtotal_amount, service_fee_amount, tax_amount, total_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11, $12, $13, $14)
           RETURNING id`,
          [user.id, car.partnerId, car.id, car.location, w.pickupDate, w.pickupTime, w.returnDate, w.returnTime,
           p.dailyPrice, p.rentalDays, p.subtotal, p.serviceFee, p.tax, p.total]
        );
        await q('RELEASE SAVEPOINT new_reservation');
        await q(
          `INSERT INTO reservation_status_history (reservation_id, from_status, to_status, changed_by, changed_by_role)
           VALUES ($1, NULL, 'pending', $2, 'customer')`,
          [rows[0].id, user.id]
        );
        return rows[0].id;
      } catch (err) {
        await q('ROLLBACK TO SAVEPOINT new_reservation');
        if (err.code === '23P01') throw conflict('This car was just booked for these dates. Please choose other dates.');
        const referenceTaken = err.code === '23505' && err.constraint === 'reservations_booking_reference_key';
        if (!referenceTaken || attempt >= REFERENCE_ATTEMPTS) throw err;
      }
    }
  });

  return getForCustomer(user.id, id);
}

// ------------------------------------------------------------------------------------ status changes

/**
 * The ONE place a booking's status changes (partner approve/reject/complete, admin changes, customer cancel).
 *
 *   actor = { id, role, partnerId? }   always taken from the session, never from the request body
 *
 * Ownership is part of the lookup: a customer can only reach their own booking, a partner only bookings of their own
 * cars (anything else is a plain 404), an admin any booking. The row is locked, the transition is validated against
 * the rules in bookingRules.js, then the status is updated and a history row is written in the same transaction.
 * Cancelled and rejected bookings stop holding the car, so their dates are free again immediately.
 */
async function changeStatus(actor, id, to, reason) {
  const text = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  await withTransaction(async (q) => {
    const scope = { customer: ['r.customer_id', actor.id], partner: ['r.partner_id', actor.partnerId] }[actor.role];
    if (actor.role !== 'admin' && !(scope && scope[1])) throw notFound('Reservation not found');
    const { rows } = await q(
      `SELECT r.id, r.status, r.pickup_date, to_char(r.pickup_time, 'HH24:MI') AS pickup_time
       FROM reservations r WHERE r.id = $1 ${scope ? `AND ${scope[0]} = $2` : ''} FOR UPDATE`,
      scope ? [id, scope[1]] : [id]
    );
    const current = rows[0];
    if (!current) throw notFound('Reservation not found');

    const verdict = R.checkTransition(
      { from: current.status, to, role: actor.role, pickupAt: R.wall(current.pickupDate, current.pickupTime), now: nowWall(), reason: text },
      rules
    );
    if (!verdict.ok) {
      const fail = { 403: forbidden, 409: conflict, 422: unprocessable }[verdict.status];
      throw fail(verdict.message);
    }

    await q('UPDATE reservations SET status = $2, updated_at = NOW() WHERE id = $1', [id, to]);
    await q(
      `INSERT INTO reservation_status_history (reservation_id, from_status, to_status, changed_by, changed_by_role, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, current.status, to, actor.id, actor.role, text]
    );
  });
  if (actor.role === 'customer') return detailForCustomer(actor.id, id);
  return actor.role === 'partner' ? getForPartner(actor.partnerId, id) : getForAdmin(id);
}

const cancelForCustomer = (customer, id, reason) => changeStatus({ id: customer.id, role: 'customer' }, id, 'cancelled', reason);

module.exports = {
  nowWall, listForCustomer, getForCustomer, detailForCustomer, quote, create,
  listForPartner, getForPartner, statsForPartner, listForAdmin, getForAdmin,
  changeStatus, cancelForCustomer, historyOf,
};
