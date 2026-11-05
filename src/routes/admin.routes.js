const router = require('express').Router();
const c = require('../controllers/admin.controller');
const { authenticate, authorize } = require('../middleware/auth');
const validate = require('../middleware/validate');
const rules = require('../validators');

router.use(authenticate, authorize('admin'));

router.get('/dashboard', c.dashboard);
router.get('/customers', c.customers);
router.get('/partners', c.partners);
router.get('/cars', c.cars);
router.get('/reservations', c.reservations);

router.use('/verifications', require('./adminVerification.routes'));

router.patch('/cars/:id/approve', validate(rules.idParam()), c.approveCar);
router.patch('/cars/:id/reject', validate(rules.idParam()), c.rejectCar);
router.patch('/cars/:id/suspend', validate(rules.idParam()), c.suspendCar);
router.patch('/partners/:id/suspend', validate(rules.idParam()), c.suspendPartner);
router.patch('/partners/:id/activate', validate(rules.idParam()), c.activatePartner);

module.exports = router;
