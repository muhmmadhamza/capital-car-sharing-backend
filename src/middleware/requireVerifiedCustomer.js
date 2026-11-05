const asyncHandler = require('../utils/asyncHandler');
const { AppError, unauthorized, forbidden } = require('../utils/errors');
const verificationService = require('../services/verification.service');

// BOOKING INTEGRATION POINT.
//
// Put this on any route that creates or confirms a reservation, AFTER authenticate + authorize('customer'):
//
//   router.post('/', authenticate, authorize('customer'), requireVerifiedCustomer, reservationController.create);
//
// It reads the status from the database on every request, using the id from the verified token (never from the
// request body), so a frontend-only check can never be the thing that lets a booking through.
// A customer who is not approved gets 403 with { code: 'verification_required', verificationStatus }.
const requireVerifiedCustomer = asyncHandler(async (req, _res, next) => {
  if (!req.user) throw unauthorized();
  if (req.user.role !== 'customer') throw forbidden('Only customers can make reservations');

  const status = await verificationService.getStatus(req.user.id);
  if (status !== 'approved') {
    const err = new AppError('Identity verification is required before you can make a reservation', 403);
    err.errors = [`verificationStatus:${status}`];
    throw err;
  }
  next();
});

module.exports = { requireVerifiedCustomer };
