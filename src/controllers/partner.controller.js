const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const partnerService = require('../services/partner.service');
const carService = require('../services/car.service');
const storage = require('../services/storage');
const availabilityService = require('../services/availability.service');

exports.getMe = asyncHandler(async (req, res) => {
  success(res, { partner: await partnerService.getProfile(req.user.id) });
});

exports.updateMe = asyncHandler(async (req, res) => {
  const { name, phone, avatar, companyName, address } = req.body;
  success(res, { partner: await partnerService.updateProfile(req.user.id, { name, phone, avatar, companyName, address }) });
});

exports.listCars = asyncHandler(async (req, res) => {
  success(res, { cars: await carService.listPartnerCars(req.partner.id) });
});

exports.getCar = asyncHandler(async (req, res) => {
  success(res, { car: await carService.getPartnerCar(req.partner.id, Number(req.params.id)) });
});

exports.createCar = asyncHandler(async (req, res) => {
  success(res, { car: await carService.createPartnerCar(req.partner.id, req.body) }, 201);
});

exports.updateCar = asyncHandler(async (req, res) => {
  success(res, { car: await carService.updatePartnerCar(req.partner.id, Number(req.params.id), req.body) });
});

exports.deleteCar = asyncHandler(async (req, res) => {
  success(res, await carService.deletePartnerCar(req.partner.id, Number(req.params.id)));
});

// GET /partners/me/cars/:id/availability?startDate=&endDate=
// Works for every car the partner owns, published or not. Other partners' cars give 404.
exports.getCarAvailability = asyncHandler(async (req, res) => {
  const carId = Number(req.params.id);
  await carService.getPartnerCar(req.partner.id, carId); // ownership check
  const { startDate, endDate } = req.query;
  success(res, await availabilityService.getCarAvailability(carId, { startDate, endDate }));
});

exports.setCarAvailability = asyncHandler(async (req, res) => {
  const carId = Number(req.params.id);
  await carService.getPartnerCar(req.partner.id, carId); // ownership check
  await availabilityService.setCarDates(carId, req.body.dates, req.body.status);
  success(res, await availabilityService.getCarAvailability(carId));
});

// POST /partners/me/cars/:id/images  (multipart, field "image")
// Ownership was already checked by the route; the car row is locked again inside addPartnerCarImage.
exports.uploadCarImage = asyncHandler(async (req, res) => {
  const carId = Number(req.params.id);
  const { url } = await storage.save({ key: req.image.key, buffer: req.image.buffer });
  try {
    const { id, car } = await carService.addPartnerCarImage(req.partner.id, carId, url);
    success(res, { image: { id, url, carId }, car }, 201);
  } catch (err) {
    await storage.removeByUrl(url); // do not keep a file that has no database row
    throw err;
  }
});

// POST /partners/me/car-images  (multipart, field "image")
// For a car that is not saved yet: stores the file under the partner's own folder and returns its URL.
// The URL is saved with the car by POST/PUT /partners/me/cars, which only accepts the partner's own files.
exports.uploadStagedImage = asyncHandler(async (req, res) => {
  const { url } = await storage.save({ key: req.image.key, buffer: req.image.buffer });
  success(res, { image: { url } }, 201);
});
