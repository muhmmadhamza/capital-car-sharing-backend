const router = require('express').Router();
const { query } = require('../database/pool');
const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');

router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    await query('SELECT 1');
    success(res, { status: 'ok', database: 'connected', time: new Date().toISOString() });
  })
);

router.use('/auth', require('./auth.routes'));
router.use('/customers', require('./customer.routes'));
router.use('/customer/verification', require('./customerVerification.routes'));
router.use('/partners', require('./partner.routes'));
router.use('/cars', require('./car.routes'));
router.use('/admin', require('./admin.routes'));

module.exports = router;
