const router = require('express').Router();
const c = require('../controllers/partner.controller');
const { authenticate, authorize, requirePartner } = require('../middleware/auth');
const validate = require('../middleware/validate');
const rules = require('../validators');
const { singleImage, verifyImage, handleUploadError } = require('../middleware/upload');
const { uploadLimiter } = require('../middleware/rateLimit');
const carService = require('../services/car.service');
const asyncHandler = require('../utils/asyncHandler');

router.use(authenticate, authorize('partner'));

router.get('/me', c.getMe);
router.put('/me', validate(rules.profile), c.updateMe);

// Everything below only touches cars owned by req.partner
router.use('/me/cars', requirePartner);
router.get('/me/cars', c.listCars);
router.post('/me/cars', validate(rules.car(false)), c.createCar);
router.get('/me/cars/:id', validate(rules.idParam()), c.getCar);
router.put('/me/cars/:id', validate(rules.idParam()), validate(rules.car(true)), c.updateCar);
router.delete('/me/cars/:id', validate(rules.idParam()), c.deleteCar);
router.get(
  '/me/cars/:id/availability',
  validate(rules.idParam()),
  validate(rules.availabilityQuery),
  c.getCarAvailability
);
router.put(
  '/me/cars/:id/availability',
  validate(rules.idParam()),
  validate(rules.availabilityUpdate),
  c.setCarAvailability
);

// Bookings of this partner's cars. Ownership is enforced inside the service (partner_id comes from the session).
router.use('/me/reservations', requirePartner);
router.get('/me/reservations', c.listReservations);
router.get('/me/reservations/stats', c.reservationStats);
router.get('/me/reservations/:id', validate(rules.idParam()), c.getReservation);
router.patch('/me/reservations/:id/approve', validate(rules.idParam()), c.approveReservation);
router.patch('/me/reservations/:id/reject', validate(rules.idParam()), validate(rules.reasonBody), c.rejectReservation);
router.patch('/me/reservations/:id/complete', validate(rules.idParam()), c.completeReservation);

// Car photos. Auth, partner status and car ownership are all checked BEFORE the upload body is read.
const partnerKey = (req) => `cars/${req.partner.id}`;
const ownsCar = asyncHandler(async (req, _res, next) => {
  await carService.getPartnerCar(req.partner.id, Number(req.params.id)); // 404 for other partners' cars
  next();
});

router.post(
  '/me/cars/:id/images',
  uploadLimiter,
  validate(rules.idParam()),
  ownsCar,
  singleImage,
  handleUploadError,
  verifyImage(partnerKey),
  c.uploadCarImage
);
router.post(
  '/me/car-images',
  requirePartner,
  uploadLimiter,
  singleImage,
  handleUploadError,
  verifyImage(partnerKey),
  c.uploadStagedImage
);

module.exports = router;
