const { query, withTransaction } = require('../database/pool');
const { notFound } = require('../utils/errors');

const paging = ({ page, limit }) => {
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  return { pg, lim, offset: (pg - 1) * lim };
};
const meta = (pg, lim, total) => ({ page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) });

async function dashboard() {
  const { rows } = await query(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'customer')                         AS total_customers,
      (SELECT COUNT(*) FROM partners)                                              AS total_partners,
      (SELECT COUNT(*) FROM partners WHERE status = 'suspended')                   AS suspended_partners,
      (SELECT COUNT(*) FROM cars)                                                  AS total_cars,
      (SELECT COUNT(*) FROM cars WHERE approval_status = 'pending')                AS pending_cars,
      (SELECT COUNT(*) FROM cars WHERE approval_status = 'approved')               AS approved_cars,
      (SELECT COUNT(*) FROM reservations)                                          AS total_reservations,
      (SELECT COUNT(*) FROM reservations WHERE status = 'upcoming')                AS upcoming_reservations,
      (SELECT COUNT(*) FROM reservations WHERE status = 'active')                  AS active_reservations,
      (SELECT COUNT(*) FROM reservations WHERE status = 'completed')               AS completed_reservations,
      (SELECT COALESCE(SUM(total_price), 0) FROM reservations WHERE status = 'completed') AS completed_reservation_value
  `);
  const { rows: recent } = await query(`
    SELECT r.id, r.status, r.pickup_date, r.return_date, r.total_price,
           u.name AS customer_name, c.make AS car_make, c.model AS car_model
    FROM reservations r
    JOIN users u ON u.id = r.customer_id
    JOIN cars c ON c.id = r.car_id
    ORDER BY r.created_at DESC, r.id DESC LIMIT 5`);
  const { rows: pending } = await query(`
    SELECT c.id, c.make, c.model, c.year, c.location, c.daily_price, p.company_name AS partner_company_name
    FROM cars c JOIN partners p ON p.id = c.partner_id
    WHERE c.approval_status = 'pending' ORDER BY c.created_at ASC LIMIT 5`);
  return { stats: rows[0], recentReservations: recent, pendingCars: pending };
}

async function listCustomers(opts) {
  const { pg, lim, offset } = paging(opts);
  const params = [];
  let where = `u.role = 'customer'`;
  if (opts.status) { params.push(opts.status); where += ` AND u.status = $${params.length}`; }
  if (opts.search) { params.push(`%${opts.search}%`); where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length})`; }

  const total = (await query(`SELECT COUNT(*) AS total FROM users u WHERE ${where}`, params)).rows[0].total;
  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.phone, u.avatar, u.status, u.created_at, u.updated_at,
            (SELECT COUNT(*) FROM reservations r WHERE r.customer_id = u.id) AS reservations_count
     FROM users u WHERE ${where} ORDER BY u.created_at DESC, u.id DESC LIMIT ${lim} OFFSET ${offset}`,
    params
  );
  return { customers: rows, meta: meta(pg, lim, total) };
}

async function listPartners(opts) {
  const { pg, lim, offset } = paging(opts);
  const params = [];
  let where = 'TRUE';
  if (opts.status) { params.push(opts.status); where += ` AND p.status = $${params.length}`; }

  const total = (await query(`SELECT COUNT(*) AS total FROM partners p WHERE ${where}`, params)).rows[0].total;
  const { rows } = await query(
    `SELECT p.id, p.user_id, p.company_name, p.address, p.status, p.created_at, p.updated_at,
            u.name, u.email, u.phone, u.avatar,
            (SELECT COUNT(*) FROM cars c WHERE c.partner_id = p.id) AS cars_count,
            (SELECT COUNT(*) FROM reservations r WHERE r.partner_id = p.id) AS reservations_count
     FROM partners p JOIN users u ON u.id = p.user_id
     WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT ${lim} OFFSET ${offset}`,
    params
  );
  return { partners: rows, meta: meta(pg, lim, total) };
}

async function listReservations(opts) {
  const { pg, lim, offset } = paging(opts);
  const params = [];
  let where = 'TRUE';
  if (opts.status) { params.push(opts.status); where += ` AND r.status = $${params.length}`; }

  const total = (await query(`SELECT COUNT(*) AS total FROM reservations r WHERE ${where}`, params)).rows[0].total;
  const { rows } = await query(
    `SELECT r.id, r.customer_id, r.partner_id, r.car_id, r.pickup_location, r.pickup_date, r.return_date,
            r.status, r.daily_price, r.total_price, r.created_at, r.updated_at,
            u.name AS customer_name, u.email AS customer_email,
            p.company_name AS partner_company_name,
            c.make AS car_make, c.model AS car_model, c.year AS car_year
     FROM reservations r
     JOIN users u ON u.id = r.customer_id
     JOIN partners p ON p.id = r.partner_id
     JOIN cars c ON c.id = r.car_id
     WHERE ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT ${lim} OFFSET ${offset}`,
    params
  );
  return { reservations: rows, meta: meta(pg, lim, total) };
}

// Suspending a partner also blocks their login; their cars disappear from public search
// (public queries require partners.status = 'active').
async function setPartnerStatus(partnerId, status) {
  const userStatus = status === 'suspended' ? 'suspended' : 'active';
  const updated = await withTransaction(async (q) => {
    const { rows } = await q(
      'UPDATE partners SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id, user_id, status',
      [partnerId, status]
    );
    if (!rows[0]) return null;
    await q('UPDATE users SET status = $2, updated_at = NOW() WHERE id = $1', [rows[0].userId, userStatus]);
    return rows[0];
  });
  if (!updated) throw notFound('Partner not found');
  return updated;
}

module.exports = { dashboard, listCustomers, listPartners, listReservations, setPartnerStatus };
