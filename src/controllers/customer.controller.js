const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const customerService = require('../services/customer.service');
const reservationService = require('../services/reservation.service');

exports.getMe = asyncHandler(async (req, res) => {
  success(res, { customer: await customerService.getProfile(req.user.id) });
});

exports.updateMe = asyncHandler(async (req, res) => {
  const { name, phone, avatar } = req.body;
  success(res, { customer: await customerService.updateProfile(req.user.id, { name, phone, avatar }) });
});

exports.getReservations = asyncHandler(async (req, res) => {
  success(res, { reservations: await reservationService.listForCustomer(req.user.id, { status: req.query.status }) });
});

exports.getReservation = asyncHandler(async (req, res) => {
  success(res, { reservation: await reservationService.detailForCustomer(req.user.id, Number(req.params.id)) });
});

// The customer is always the signed-in user; the booking must be theirs and eligible (see bookingRules.checkTransition).
exports.cancelReservation = asyncHandler(async (req, res) => {
  success(res, { reservation: await reservationService.cancelForCustomer(req.user, Number(req.params.id), req.body && req.body.reason) });
});

// Only the car and the rental window are read from the body. The customer is always the signed-in user.
const windowOf = (b) => ({ carId: b.carId, pickupDate: b.pickupDate, pickupTime: b.pickupTime, returnDate: b.returnDate, returnTime: b.returnTime });

exports.quoteReservation = asyncHandler(async (req, res) => {
  success(res, await reservationService.quote(req.user, windowOf(req.body)));
});

exports.createReservation = asyncHandler(async (req, res) => {
  success(res, { reservation: await reservationService.create(req.user, windowOf(req.body)) }, 201);
});
