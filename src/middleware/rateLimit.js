const rateLimit = require('express-rate-limit');

const make = (windowMs, max, message, extra = {}) =>
  rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ success: false, message }),
    ...extra,
  });

// Per signed-in user instead of per IP (used after authenticate, so req.user is always set).
const perUser = { keyGenerator: (req) => `user:${req.user.id}` };

// General API limiter
// const apiLimiter = make(15 * 60 * 1000, 600, 'Too many requests, please try again later');
// const apiLimiter = make(15 * 60 * 1000, 600, 'Too many requests, please try again later');
const apiLimiter = make(15 * 60 * 1000, parseInt(process.env.API_RATE_LIMIT_MAX || '600', 10), 'Too many requests, please try again later');
// Stricter limiter for login/register (brute-force protection)
const authLimiter = make(15 * 60 * 1000, 30, 'Too many authentication attempts, please try again later');

// Password reset: forgot-password sends email, so keep it tight per IP; reset-password guards token guessing.
const forgotPasswordLimiter = make(15 * 60 * 1000, 5, 'Too many password reset requests, please try again later');
const resetPasswordLimiter = make(15 * 60 * 1000, 10, 'Too many attempts, please try again later');

// Uploads are heavy: cap them per IP
const uploadLimiter = make(15 * 60 * 1000, 120, 'Too many uploads, please try again later');

// Identity verification. Submitting is rare, so keep it tight per customer; reading documents is per user too.
// (VERIFICATION_SUBMIT_LIMIT lets an operator or a test run change the cap without code changes.)
const verificationSubmitLimiter = make(
  15 * 60 * 1000,
  parseInt(process.env.VERIFICATION_SUBMIT_LIMIT || '20', 10),
  'Too many verification submissions, please try again later',
  perUser
);
const verificationDocumentLimiter = make(15 * 60 * 1000, 120, 'Too many document requests, please try again later', perUser);

// Booking quotes and reservations: generous for real use, tight enough to stop scripted hammering. Per customer.
const bookingLimiter = make(
  15 * 60 * 1000,
  parseInt(process.env.BOOKING_RATE_LIMIT_MAX || '60', 10),
  'Too many booking requests, please try again in a few minutes',
  perUser
);

module.exports = {
  apiLimiter,
  bookingLimiter,
  authLimiter,
  forgotPasswordLimiter,
  resetPasswordLimiter,
  uploadLimiter,
  verificationSubmitLimiter,
  verificationDocumentLimiter,
};
