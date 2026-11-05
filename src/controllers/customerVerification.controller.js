const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const { publicPolicy } = require('../config/verification');
const verification = require('../services/verification.service');
const { sendDocument } = require('../utils/sendDocument');

// The customer is always req.user (from the verified token). No id is ever read from the body, query or URL.
const fieldsOf = (b = {}) => ({
  fullLegalName: b.fullLegalName,
  dateOfBirth: b.dateOfBirth,
  country: b.country,
  phone: b.phone,
  documentType: b.documentType,
  documentNumber: b.documentNumber,
  // Anything else in the body (status, reviewedBy, customerId, ...) is deliberately ignored.
});

exports.get = asyncHandler(async (req, res) => {
  success(res, { verification: await verification.getForCustomer(req.user), policy: publicPolicy() });
});

exports.submit = asyncHandler(async (req, res) => {
  const result = await verification.submit(req.user, fieldsOf(req.body), req.verificationFiles);
  success(res, { verification: result }, 201);
});

exports.resubmit = asyncHandler(async (req, res) => {
  const result = await verification.resubmit(req.user, fieldsOf(req.body), req.verificationFiles);
  success(res, { verification: result });
});

exports.document = asyncHandler(async (req, res) => {
  sendDocument(res, await verification.openOwnDocument(req.user.id, req.params.side));
});
