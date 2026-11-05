const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { notFound } = require('../utils/errors');
const carService = require('../services/car.service');
const availabilityService = require('../services/availability.service');

exports.list = asyncHandler(async (req, res) => {
  const { cars, meta } = await carService.searchCars(req.query);
  success(res, { cars }, 200, meta);
});

exports.get = asyncHandler(async (req, res) => {
  success(res, { car: await carService.getPublicCar(Number(req.params.id)) });
});

exports.availability = asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await carService.carIsPublic(id))) throw notFound('Car not found');
  const { startDate, endDate } = req.query;
  success(res, await availabilityService.getCarAvailability(id, { startDate, endDate }));
});
