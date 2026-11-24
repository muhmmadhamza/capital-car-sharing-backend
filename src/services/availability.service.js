const { query, withTransaction } = require('../database/pool');
const { badRequest, conflict } = require('../utils/errors');
const { daysBetween } = require('../utils/validators');
const config = require('../config/env');

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 90;

// "Today" in the business time zone (BUSINESS_TIME_ZONE), as YYYY-MM-DD. Every availability read uses it.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.businessTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Why a start/end pair is not acceptable, or null when it is fine.
function rangeProblem(start, end) {
  const span = daysBetween(start, end);
  if (span < 0) return 'endDate must be on or after startDate';
  if (span > MAX_RANGE_DAYS) return `Date range cannot exceed ${MAX_RANGE_DAYS} days`;
  return null;
}

/**
 * Day-by-day status for one or more cars. A day is:
 *  - booked       if an availability row says so OR an pending/confirmed reservation covers it
 *  - unavailable  if the owner blocked it
 *  - available    otherwise
 * Because reservations are read live, future bookings block conflicting dates automatically.
 * This is the ONE definition of a day's status: the calendar and today's status on My Cars both use it.
 */
async function dayStatusRows(carIds, start, end) {
  const { rows } = await query(
    `WITH days AS (
       SELECT d::date AS day FROM generate_series($2::date, $3::date, interval '1 day') d
     ), wanted AS (
       SELECT unnest($1::int[]) AS car_id
     )
     SELECT wanted.car_id,
            to_char(days.day, 'YYYY-MM-DD') AS date,
            CASE
              WHEN a.status = 'booked' OR EXISTS (
                     SELECT 1 FROM reservations r
                     WHERE r.car_id = wanted.car_id AND r.status IN ('pending', 'confirmed')
                       AND days.day BETWEEN r.pickup_date AND r.return_date)
                THEN 'booked'
              WHEN a.status = 'unavailable' THEN 'unavailable'
              ELSE 'available'
            END AS status
     FROM wanted
     CROSS JOIN days
     LEFT JOIN availability a ON a.car_id = wanted.car_id AND a.date = days.day
     ORDER BY wanted.car_id, days.day`,
    [carIds, start, end]
  );
  return rows;
}

// `includeBlockDetails` is for the OWNER's calendar only: the public endpoint never exposes why a day is blocked.
async function getCarAvailability(carId, { startDate, endDate } = {}, { includeBlockDetails = false } = {}) {
  const start = startDate || today();
  const end = endDate || addDays(start, DEFAULT_RANGE_DAYS);

  const problem = rangeProblem(start, end);
  if (problem) throw badRequest(problem);

  const rows = await dayStatusRows([carId], start, end);
  const pick = (s) => rows.filter((r) => r.status === s).map((r) => r.date);
  let blockedDetails;
  if (includeBlockDetails) {
    const details = await query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, reason, blocked_at
       FROM availability
       WHERE car_id = $1 AND status = 'unavailable' AND date BETWEEN $2::date AND $3::date
       ORDER BY date`,
      [carId, start, end]
    );
    blockedDetails = details.rows.map((r) => ({ date: r.date, reason: r.reason ?? null, blockedAt: r.blockedAt ?? null }));
  }
  return {
    carId,
    startDate: start,
    endDate: end,
    today: today(),
    availableDates: pick('available'),
    unavailableDates: pick('unavailable'),
    bookedDates: pick('booked'),
    ...(blockedDetails ? { blockedDetails } : {}),
  };
}

/**
 * Today's status ('available' | 'unavailable' | 'booked') for each car id, from the same query as the
 * calendar. Returns { date, byCar } where byCar is Map<carId, status>. Independent of approval status.
 */
async function getTodayStatuses(carIds) {
  const date = today();
  const byCar = new Map();
  if (!carIds.length) return { date, byCar };
  for (const r of await dayStatusRows(carIds, date, date)) byCar.set(r.carId, r.status);
  return { date, byCar };
}

// SQL fragment: is $day taken by a booking? Used by every check below so they cannot drift apart.
// A day is booked when an availability row says so OR an pending/confirmed reservation covers it.
const BOOKED_SQL = (carParam, dayExpr) => `(
  EXISTS (SELECT 1 FROM availability a WHERE a.car_id = ${carParam} AND a.date = ${dayExpr} AND a.status = 'booked')
  OR EXISTS (SELECT 1 FROM reservations r
             WHERE r.car_id = ${carParam} AND r.status IN ('pending', 'confirmed')
               AND ${dayExpr} BETWEEN r.pickup_date AND r.return_date))`;

const preview = (dates) => (dates.length > 5 ? `${dates.slice(0, 5).join(', ')} and ${dates.length - 5} more` : dates.join(', '));

// Which of `dates` are booked. `q` is either `query` or the q of a transaction.
async function findBookedDates(q, carId, dates) {
  const { rows } = await q(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date
     FROM (SELECT DISTINCT d FROM unnest($2::date[]) AS d) days
     WHERE ${BOOKED_SQL('$1', 'days.d')}
     ORDER BY d`,
    [carId, dates]
  );
  return rows.map((r) => r.date);
}

/**
 * Partner-controlled: block ('unavailable') or re-open ('available') specific days.
 * Booked days can never be changed: if any requested day is booked the WHOLE request is
 * refused with 409 and nothing is written.
 * The car row is locked for the duration, so this cannot interleave with a booking made at the same time.
 * `reason` (optional, only when blocking) and `userId` (who blocked) are stored on the blocked days.
 * Dates in the past are refused here as well as in the request validator.
 */
async function setCarDates(carId, dates, status, { reason, userId } = {}) {
  const past = dates.filter((d) => d < today());
  if (past.length) throw badRequest(`Dates in the past cannot be changed: ${preview([...new Set(past)].sort())}`);
  const cleanReason = typeof reason === 'string' && reason.trim() ? reason.trim() : null;
  if (cleanReason && status !== 'unavailable') throw badRequest('A reason can only be given when blocking dates');
  await withTransaction(async (q) => {
    await q('SELECT id FROM cars WHERE id = $1 FOR UPDATE', [carId]);
    const booked = await findBookedDates(q, carId, dates);
    if (booked.length) throw conflict(`These dates are already booked and cannot be changed: ${preview(booked)}`);

    if (status === 'available') {
      await q(`DELETE FROM availability WHERE car_id = $1 AND date = ANY($2::date[]) AND status = 'unavailable'`, [carId, dates]);
    } else {
      await q(
        `INSERT INTO availability (car_id, date, status, reason, blocked_by, blocked_at)
         SELECT $1, d, 'unavailable', $3, $4, NOW() FROM unnest($2::date[]) AS d
         ON CONFLICT (car_id, date) DO UPDATE
           SET status = 'unavailable', reason = EXCLUDED.reason, blocked_by = EXCLUDED.blocked_by, blocked_at = NOW()
           WHERE availability.status <> 'booked'`,
        [carId, dates, cleanReason, userId ?? null]
      );
    }
  });
}

/**
 * FOR THE RESERVATION MODULE. Call it inside the booking transaction, right after
 *   SELECT id FROM cars WHERE id = $1 FOR UPDATE      (same lock setCarDates takes)
 * and before inserting the reservation. Throws 409 when any day from pickup to return
 * (inclusive) is booked by someone else or blocked by the owner.
 */
async function assertRangeFree(q, carId, pickupDate, returnDate) {
  const problem = rangeProblem(pickupDate, returnDate);
  if (problem) throw badRequest(problem.replace('endDate', 'returnDate').replace('startDate', 'pickupDate'));
  const { rows } = await q(
    `SELECT to_char(days.day, 'YYYY-MM-DD') AS date
     FROM generate_series($2::date, $3::date, interval '1 day') AS days(day)
     WHERE ${BOOKED_SQL('$1', 'days.day::date')}
        OR EXISTS (SELECT 1 FROM availability a WHERE a.car_id = $1 AND a.date = days.day::date AND a.status = 'unavailable')
     ORDER BY days.day`,
    [carId, pickupDate, returnDate]
  );
  if (rows.length) throw conflict(`This car is not available on: ${preview(rows.map((r) => r.date))}`);
}

/**
 * Call inside the transaction that cancels or rejects a reservation. Reservations are read live, so their days free
 * up by themselves; this additionally removes 'booked' rows in the availability table for those days (written by older
 * data or seed scripts) unless another pending/confirmed reservation still covers them. Without it such a stale row
 * would keep a released date booked forever.
 */
async function releaseBookedRows(q, reservationId) {
  const { rowCount } = await q(
    `DELETE FROM availability a
     USING reservations r
     WHERE r.id = $1 AND a.car_id = r.car_id AND a.status = 'booked'
       AND a.date BETWEEN r.pickup_date AND r.return_date
       AND NOT EXISTS (SELECT 1 FROM reservations o
                       WHERE o.car_id = a.car_id AND o.id <> r.id AND o.status IN ('pending', 'confirmed')
                         AND a.date BETWEEN o.pickup_date AND o.return_date)`,
    [reservationId]
  );
  return rowCount;
}

// The days a block/unblock request covers: either an explicit `dates` list or an inclusive startDate..endDate range.
function expandDates({ dates, startDate, endDate }) {
  if (Array.isArray(dates)) return [...new Set(dates)].sort();
  const out = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) out.push(d);
  return out;
}

module.exports = { releaseBookedRows, expandDates, getCarAvailability, getTodayStatuses, today, setCarDates, assertRangeFree, findBookedDates, rangeProblem };
