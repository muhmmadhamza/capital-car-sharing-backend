const asyncHandler = require('../utils/asyncHandler');
const { success } = require('../utils/response');
const verification = require('../services/verification.service');
const { sendDocument } = require('../utils/sendDocument');

exports.list = asyncHandler(async (req, res) => {
  const { verifications, counts, meta } = await verification.listForAdmin(req.query);
  success(res, { verifications, counts }, 200, meta);
});

exports.get = asyncHandler(async (req, res) => {
  success(res, { verification: await verification.getForAdmin(Number(req.params.id)) });
});

exports.setStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  success(res, { verification: await verification.setStatus(req.user, Number(req.params.id), { status, reason }) });
});

exports.document = asyncHandler(async (req, res) => {
  sendDocument(res, await verification.openDocumentForAdmin(req.user, Number(req.params.id), req.params.side));
});
