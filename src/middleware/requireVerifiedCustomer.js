const asyncHandler = require('../utils/asyncHandler');
const { AppError, unauthorized, forbidden } = require('../utils/errors');
const { bookingBlockedMessage } = require('../utils/bookingRules');
const verificationService = require('../services/verification.service');

// BOOKING INTEGRATION POINT.
//
// Put this on any route that creates or confirms a reservation, AFTER authenticate + authorize('customer'):
//
//   router.post('/', authenticate, authorize('customer'), requireVerifiedCustomer, reservationController.create);
//
// It reads the status from the database on every request, using the id from the verified token (never from the
// request body), so a frontend-only check can never be the thing that lets a booking through.
// A customer who is not approved gets 403 with a message explaining why (per status) and
// errors: ['verificationStatus:<status>'], which the frontend uses to link to the Verification page.
const requireVerifiedCustomer = asyncHandler(async (req, _res, next) => {
  if (!req.user) throw unauthorized();
  if (req.user.role !== 'customer') throw forbidden('Only customers can make reservations');

  const status = await verificationService.getStatus(req.user.id);
  if (status !== 'approved') {
    const err = new AppError(bookingBlockedMessage(status), 403);
    err.errors = [`verificationStatus:${status}`];
    throw err;
  }
  next();
});

module.exports = { requireVerifiedCustomer };
