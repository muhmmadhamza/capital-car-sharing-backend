const router = require('express').Router();
const c = require('../controllers/adminVerification.controller');
const { verificationDocumentLimiter } = require('../middleware/rateLimit');
const validate = require('../middleware/validate');
const baseRules = require('../validators');
const rules = require('../validators/verification');

// Mounted by admin.routes.js at /api/admin/verifications, AFTER its authenticate + authorize('admin'),
// so every route here is admin-only. Customers and partners receive 403.
const both = (...fns) => (req) => fns.flatMap((f) => f(req));

router.get('/', validate(rules.adminList), c.list);
router.get('/:id', validate(baseRules.idParam()), c.get);
router.get('/:id/documents/:side', verificationDocumentLimiter, validate(both(baseRules.idParam(), rules.sideParam)), c.document);
router.patch('/:id/status', validate(rules.statusUpdate), c.setStatus);

module.exports = router;
