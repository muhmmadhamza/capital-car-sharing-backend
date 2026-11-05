const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const customerService = require('../services/customer.service');

exports.getMe = asyncHandler(async (req, res) => {
  success(res, { customer: await customerService.getProfile(req.user.id) });
});

exports.updateMe = asyncHandler(async (req, res) => {
  const { name, phone, avatar } = req.body;
  success(res, { customer: await customerService.updateProfile(req.user.id, { name, phone, avatar }) });
});

exports.getReservations = asyncHandler(async (req, res) => {
  success(res, { reservations: await customerService.listReservations(req.user.id, { status: req.query.status }) });
});
