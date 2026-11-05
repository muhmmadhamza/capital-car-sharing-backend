const jwt = require('jsonwebtoken');
const config = require('../config/env');

const signToken = (user) =>
  jwt.sign({ sub: user.id, role: user.role }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

const verifyToken = (token) => jwt.verify(token, config.jwt.secret);

const cookieOptions = () => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: config.nodeEnv === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: '/',
});

module.exports = { signToken, verifyToken, cookieOptions };
