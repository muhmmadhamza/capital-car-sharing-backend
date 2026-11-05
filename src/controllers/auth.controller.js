const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const authService = require('../services/auth.service');
const passwordReset = require('../services/passwordReset.service');
const { cookieOptions } = require('../utils/token');

const setCookie = (res, token) => res.cookie('token', token, cookieOptions());

exports.register = asyncHandler(async (req, res) => {
  const { name, email, phone, password, role, companyName, address } = req.body;
  const { user, token } = await authService.register({ name, email, phone, password, role, companyName, address });
  setCookie(res, token);
  success(res, { user, token }, 201);
});

exports.login = asyncHandler(async (req, res) => {
  const { user, token } = await authService.login(req.body);
  setCookie(res, token);
  success(res, { user, token });
});

// Role-specific variants: the role is fixed by the route, never taken from the request body
exports.registerAs = (role) =>
  asyncHandler(async (req, res) => {
    const { name, email, phone, password, companyName, address } = req.body;
    const { user, token } = await authService.register({ name, email, phone, password, role, companyName, address });
    setCookie(res, token);
    success(res, { user, token }, 201);
  });

exports.loginAs = (role) =>
  asyncHandler(async (req, res) => {
    const { user, token } = await authService.login(req.body, role);
    setCookie(res, token);
    success(res, { user, token });
  });

exports.me = asyncHandler(async (req, res) => {
  success(res, { user: await authService.me(req.user) });
});

exports.logout = asyncHandler(async (_req, res) => {
  const { maxAge, ...opts } = cookieOptions(); // eslint-disable-line no-unused-vars
  res.clearCookie('token', opts);
  success(res, { message: 'Logged out' });
});

// Forgot password: always the same answer, whether or not the email belongs to an account of this role.
// The work runs after the response is sent so the response time does not reveal it either.
const FORGOT_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

exports.forgotPasswordAs = (role) =>
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    success(res, { message: FORGOT_MESSAGE });
    passwordReset.requestReset(email, role).catch((err) => {
      console.error(`Forgot password (${role}) failed:`, err.message);
    });
  });

exports.resetPasswordAs = (role) =>
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;
    await passwordReset.resetPassword({ token, password, role });
    success(res, { message: 'Your password has been reset. You can now log in.' });
  });
