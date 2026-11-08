const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../database/pool');
const { signToken } = require('../utils/token');
const { conflict, unauthorized, forbidden } = require('../utils/errors');

const PUBLIC_USER_COLUMNS = 'id, name, email, phone, role, avatar, status, created_at, updated_at';

async function getPartnerProfile(userId) {
  const { rows } = await query(
    'SELECT id, user_id, company_name, address, status, created_at, updated_at FROM partners WHERE user_id = $1',
    [userId]
  );
  return rows[0] || null;
}

async function withProfile(user) {
  if (user.role === 'partner') return { ...user, partner: await getPartnerProfile(user.id) };
  return user;
}

async function register({ name, email, phone, password, role = 'customer', companyName, address }) {
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await query('SELECT 1 FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
  if (existing.rowCount) throw conflict('An account with this email already exists');

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await withTransaction(async (q) => {
    const { rows } = await q(
      `INSERT INTO users (name, email, phone, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PUBLIC_USER_COLUMNS}`,
      [name.trim(), normalizedEmail, phone || null, passwordHash, role]
    );
    const created = rows[0];
    if (role === 'partner') {
      await q('INSERT INTO partners (user_id, company_name, address) VALUES ($1, $2, $3)', [
        created.id,
        companyName.trim(),
        address || null,
      ]);
    }
    return created;
  });

  return { user: await withProfile(user), token: signToken(user) };
}

async function login({ email, password }, expectedRole) {
  const { rows } = await query(
    `SELECT ${PUBLIC_USER_COLUMNS}, password_hash FROM users WHERE LOWER(email) = $1`,
    [email.trim().toLowerCase()]
  );
  const record = rows[0];
  // Same message for unknown email and wrong password
  const valid = record && (await bcrypt.compare(password, record.passwordHash));
  if (!valid) throw unauthorized('Invalid email or password');
  if (expectedRole && record.role !== expectedRole) {
    throw forbidden(`This account is not a ${expectedRole} account`);
  }
  if (record.status !== 'active') throw forbidden('Your account is suspended');

  const { passwordHash, ...user } = record; // eslint-disable-line no-unused-vars
  return { user: await withProfile(user), token: signToken(user) };
}

async function me(user) {
  return withProfile(user);
}

module.exports = { register, login, me, getPartnerProfile };
