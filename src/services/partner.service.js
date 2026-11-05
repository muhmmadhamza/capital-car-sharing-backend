const { query, withTransaction } = require('../database/pool');
const { notFound } = require('../utils/errors');

async function getProfile(userId) {
  const { rows } = await query(
    `SELECT p.id, p.user_id, p.company_name, p.address, p.status, p.created_at, p.updated_at,
            u.name, u.email, u.phone, u.avatar
     FROM partners p JOIN users u ON u.id = p.user_id
     WHERE p.user_id = $1`,
    [userId]
  );
  if (!rows[0]) throw notFound('Partner profile not found');
  return rows[0];
}

async function updateProfile(userId, { name, phone, avatar, companyName, address }) {
  await withTransaction(async (q) => {
    await q(
      `UPDATE users SET name = COALESCE($2, name), phone = COALESCE($3, phone),
                        avatar = COALESCE($4, avatar), updated_at = NOW()
       WHERE id = $1`,
      [userId, name ? name.trim() : null, phone ?? null, avatar ?? null]
    );
    await q(
      `UPDATE partners SET company_name = COALESCE($2, company_name), address = COALESCE($3, address),
                           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, companyName ? companyName.trim() : null, address ?? null]
    );
  });
  return getProfile(userId);
}

module.exports = { getProfile, updateProfile };
