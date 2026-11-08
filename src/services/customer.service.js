const { query } = require('../database/pool');
const { notFound } = require('../utils/errors');

async function getProfile(userId) {
  const { rows } = await query(
    'SELECT id, name, email, phone, role, avatar, status, created_at, updated_at FROM users WHERE id = $1',
    [userId]
  );
  if (!rows[0]) throw notFound('User not found');
  return rows[0];
}

async function updateProfile(userId, { name, phone, avatar }) {
  const { rows } = await query(
    `UPDATE users SET
       name   = COALESCE($2, name),
       phone  = COALESCE($3, phone),
       avatar = COALESCE($4, avatar),
       updated_at = NOW()
     WHERE id = $1
     RETURNING id, name, email, phone, role, avatar, status, created_at, updated_at`,
    [userId, name ? name.trim() : null, phone ?? null, avatar ?? null]
  );
  return rows[0];
}

async function listReservations(customerId, { status } = {}) {
  const params = [customerId];
  let where = 'r.customer_id = $1';
  if (status) {
    params.push(status);
    where += ` AND r.status = $${params.length}`;
  }
  const { rows } = await query(
    `SELECT r.id, r.customer_id, r.partner_id, r.car_id, r.pickup_location, r.pickup_date, r.return_date,
            r.status, r.daily_price, r.total_price, r.created_at, r.updated_at,
            c.make AS car_make, c.model AS car_model, c.year AS car_year, c.type AS car_type,
            (SELECT ci.image_url FROM car_images ci WHERE ci.car_id = c.id ORDER BY ci.sort_order LIMIT 1) AS car_image,
            p.company_name AS partner_company_name
     FROM reservations r
     JOIN cars c ON c.id = r.car_id
     JOIN partners p ON p.id = r.partner_id
     WHERE ${where}
     ORDER BY r.pickup_date DESC, r.id DESC`,
    params
  );
  return rows;
}

module.exports = { getProfile, updateProfile, listReservations };
