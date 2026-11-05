const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const adminService = require('../services/admin.service');
const carService = require('../services/car.service');

exports.dashboard = asyncHandler(async (_req, res) => success(res, await adminService.dashboard()));

exports.customers = asyncHandler(async (req, res) => {
  const { customers, meta } = await adminService.listCustomers(req.query);
  success(res, { customers }, 200, meta);
});

exports.partners = asyncHandler(async (req, res) => {
  const { partners, meta } = await adminService.listPartners(req.query);
  success(res, { partners }, 200, meta);
});

exports.cars = asyncHandler(async (req, res) => {
  const { cars, meta } = await carService.listAllCars(req.query);
  success(res, { cars }, 200, meta);
});

exports.reservations = asyncHandler(async (req, res) => {
  const { reservations, meta } = await adminService.listReservations(req.query);
  success(res, { reservations }, 200, meta);
});

const carAction = (status) =>
  asyncHandler(async (req, res) => {
    success(res, { car: await carService.setApprovalStatus(Number(req.params.id), status) });
  });
exports.approveCar = carAction('approved');
exports.rejectCar = carAction('rejected');
exports.suspendCar = carAction('suspended');

const partnerAction = (status) =>
  asyncHandler(async (req, res) => {
    success(res, { partner: await adminService.setPartnerStatus(Number(req.params.id), status) });
  });
exports.suspendPartner = partnerAction('suspended');
exports.activatePartner = partnerAction('active');
