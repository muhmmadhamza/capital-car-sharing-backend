const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config/env');
const { query, withTransaction } = require('../database/pool');
const { badRequest } = require('../utils/errors');
const { sendPasswordResetEmail } = require('./email.service');

const INVALID_LINK = 'This reset link is invalid or has expired. Please request a new one.';

// Only this hash is stored. The raw token exists only in the email link.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Starts a reset for an account of the given role. Does nothing (silently) when the email does not belong
 * to an active account of that role, so callers can answer every request the same way.
 */
async function requestReset(email, role) {
  const { rows } = await query(
    `SELECT id, name, email FROM users WHERE LOWER(email) = $1 AND role = $2 AND status = 'active'`,
    [email.trim().toLowerCase(), role]
  );
  const user = rows[0];
  if (!user) return;

  // Do not issue (or email) another link while a fresh one was just created for this account.
  const recent = await query(
    `SELECT 1 FROM password_reset_tokens WHERE user_id = $1 AND created_at > NOW() - make_interval(secs => $2)`,
    [user.id, config.passwordReset.cooldownSeconds]
  );
  if (recent.rowCount) return;

  const token = crypto.randomBytes(32).toString('base64url'); // 256 bits
  await withTransaction(async (q) => {
    // Only the newest link works.
    await q('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await q(
      `INSERT INTO password_reset_tokens (user_id, role, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + make_interval(mins => $4))`,
      [user.id, role, hashToken(token), config.passwordReset.ttlMinutes]
    );
  });

  await sendPasswordResetEmail({ to: user.email, name: user.name, role, token });
}

/**
 * Sets a new password from a reset token. The token must have been issued for this role, be unused and
 * unexpired. Token check, password update and token invalidation happen in one transaction; the row lock
 * means two concurrent requests with the same token cannot both succeed.
 */
async function resetPassword({ token, password, role }) {
  const tokenHash = hashToken(token);
  const passwordHash = await bcrypt.hash(password, 12); // same cost as registration

  await withTransaction(async (q) => {
    const { rows } = await q(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1 AND role = $2 AND used_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [tokenHash, role]
    );
    const record = rows[0];
    if (!record) throw badRequest(INVALID_LINK);

    const updated = await q(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE id = $2 AND role = $3 AND status = 'active'`,
      [passwordHash, record.userId, role]
    );
    if (!updated.rowCount) throw badRequest(INVALID_LINK);

    // Burn this token and any other outstanding ones for the account.
    await q('UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL', [record.userId]);
  });
}

module.exports = { requestReset, resetPassword, hashToken };
