const { query } = require('../database/pool');
const { verifyToken } = require('../utils/token');
const { unauthorized, forbidden } = require('../utils/errors');
const asyncHandler = require('../utils/asyncHandler');

const extractToken = (req) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  return req.cookies && req.cookies.token;
};

// Verifies the JWT, loads the user and attaches it to req.user
const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw unauthorized();

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    throw unauthorized('Invalid or expired token');
  }

  const { rows } = await query(
    'SELECT id, name, email, phone, role, avatar, status, created_at, updated_at FROM users WHERE id = $1',
    [payload.sub]
  );
  const user = rows[0];
  if (!user) throw unauthorized('User no longer exists');
  if (user.status !== 'active') throw forbidden('Your account is suspended');

  req.user = user;
  next();
});

// Role-based authorization: authorize('admin'), authorize('partner', 'admin')
const authorize = (...roles) => (req, _res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};

// Partner-only: attaches req.partner and blocks suspended partners.
const requirePartner = asyncHandler(async (req, _res, next) => {
  if (!req.user || req.user.role !== 'partner') throw forbidden('Partner access only');
  const { rows } = await query('SELECT * FROM partners WHERE user_id = $1', [req.user.id]);
  const partner = rows[0];
  if (!partner) throw forbidden('Partner profile not found');
  if (partner.status === 'suspended') throw forbidden('Your partner account is suspended');
  req.partner = partner;
  next();
});

module.exports = { authenticate, authorize, requirePartner };
