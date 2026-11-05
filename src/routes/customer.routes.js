const router = require('express').Router();
const c = require('../controllers/customer.controller');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const rules = require('../validators');

router.use(authenticate, authorize('customer'));

router.get('/me', c.getMe);
router.put('/me', validate(rules.profile), c.updateMe);
router.get('/me/reservations', c.getReservations);

module.exports = router;
