const router = require('express').Router();
const c = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { authLimiter, forgotPasswordLimiter, resetPasswordLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const rules = require('../validators');

router.post('/register', authLimiter, validate(rules.register), c.register);
router.post('/login', authLimiter, validate(rules.login), c.login);
// Role-specific auth (role is enforced by the route)
const withRole = (role) => (req, _res, next) => { req.body = { ...(req.body || {}), role }; next(); };

router.post('/customer/register', authLimiter, withRole('customer'), validate(rules.register), c.registerAs('customer'));
router.post('/customer/login', authLimiter, validate(rules.login), c.loginAs('customer'));
router.post('/partner/register', authLimiter, withRole('partner'), validate(rules.register), c.registerAs('partner'));
router.post('/partner/login', authLimiter, validate(rules.login), c.loginAs('partner'));
// Admins are never self-registered; they are created via the seed script / database
router.post('/admin/login', authLimiter, validate(rules.login), c.loginAs('admin'));

// Forgot / reset password. The role is fixed by the route, and a reset token only works for the role it was issued for.
['customer', 'partner', 'admin'].forEach((role) => {
  router.post(`/${role}/forgot-password`, forgotPasswordLimiter, validate(rules.forgotPassword), c.forgotPasswordAs(role));
  router.post(`/${role}/reset-password`, resetPasswordLimiter, validate(rules.resetPassword), c.resetPasswordAs(role));
});

router.get('/me', authenticate, c.me);
router.post('/logout', c.logout);

module.exports = router;
