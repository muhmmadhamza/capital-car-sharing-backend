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

// Kept for existing callers; the reservation queries live in reservation.service.js.
const listReservations = (customerId, opts) => require('./reservation.service').listForCustomer(customerId, opts);

module.exports = { getProfile, updateProfile, listReservations };
