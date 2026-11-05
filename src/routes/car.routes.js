const router = require('express').Router();
const c = require('../controllers/car.controller');
const validate = require('../middleware/validate');
const rules = require('../validators');

router.get('/', validate(rules.carSearch), c.list);
router.get('/:id', validate(rules.idParam()), c.get);
router.get('/:id/availability', validate(rules.idParam()), validate(rules.availabilityQuery), c.availability);

module.exports = router;
