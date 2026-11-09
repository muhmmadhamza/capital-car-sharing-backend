const router = require('express').Router();
const c = require('../controllers/customer.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { requireVerifiedCustomer } = require('../middleware/requireVerifiedCustomer');
const { bookingLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const rules = require('../validators');

router.use(authenticate, authorize('customer'));

router.get('/me', c.getMe);
router.put('/me', validate(rules.profile), c.updateMe);
// Reservations (booking). Creating one needs an APPROVED customer, checked here on the server on every request.
router.get('/me/reservations', c.getReservations);
router.post('/me/reservations/quote', bookingLimiter, validate(rules.reservationInput), c.quoteReservation);
router.post('/me/reservations', bookingLimiter, requireVerifiedCustomer, validate(rules.reservationInput), c.createReservation);
router.get('/me/reservations/:id', validate(rules.idParam()), c.getReservation);
router.post('/me/reservations/:id/cancel', validate(rules.idParam()), validate(rules.reasonBody), c.cancelReservation);

module.exports = router;
