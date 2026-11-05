const router = require('express').Router();
const c = require('../controllers/customerVerification.controller');
const { authenticate, authorize } = require('../middleware/auth');
const { verificationSubmitLimiter, verificationDocumentLimiter } = require('../middleware/rateLimit');
const { uploadDocuments, verifyDocuments } = require('../middleware/verificationUpload');
const validate = require('../middleware/validate');
const rules = require('../validators/verification');

// Mounted at /api/customer/verification. Only signed-in customers; partners and admins get 403.
router.use(authenticate, authorize('customer'));

router.get('/', c.get);
router.post('/', verificationSubmitLimiter, uploadDocuments, verifyDocuments, validate(rules.submit), c.submit);
router.patch('/', verificationSubmitLimiter, uploadDocuments, verifyDocuments, validate(rules.resubmit), c.resubmit);
// The customer's own uploaded files, for the "what I submitted" preview. Always the signed-in customer's record.
router.get('/documents/:side', verificationDocumentLimiter, validate(rules.sideParam), c.document);

module.exports = router;
