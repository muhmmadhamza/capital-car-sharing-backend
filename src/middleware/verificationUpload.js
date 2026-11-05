const crypto = require('crypto');
const multer = require('multer');
const { getPolicy } = require('../config/verification');
const { sniffDocument } = require('../utils/fileSniff');
const { badRequest } = require('../utils/errors');

const ACCEPTED_MESSAGE = 'Only JPG, PNG, WebP or PDF files are allowed';
const DECLARED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
const SIDES = ['front', 'back'];

const MB = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// Files are held in memory (never written to a temp folder), so a rejected or failed upload leaves nothing on disk.
// Only after every check passes does the service write them to PRIVATE storage.
function buildParser() {
  const { maxFileSizeBytes } = getPolicy();
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSizeBytes, files: 2, fields: 10, parts: 12, fieldSize: 2048, fieldNameSize: 50 },
    fileFilter: (_req, file, cb) => {
      // Cheap first rejection on the declared type. The byte check in verifyDocuments is the real one.
      if (!DECLARED_TYPES.has(file.mimetype)) return cb(badRequest(ACCEPTED_MESSAGE));
      cb(null, true);
    },
  }).fields(SIDES.map((name) => ({ name, maxCount: 1 })));
}

let parse;

// Reads multipart/form-data with the optional files "front" and "back". Requests that are not multipart (for
// example a JSON resubmission that keeps the existing documents) pass straight through.
const uploadDocuments = (req, res, next) => {
  parse = parse || buildParser();
  parse(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const e = badRequest(`File is too large. The maximum size is ${MB(getPolicy().maxFileSizeBytes)} MB per file`);
        e.statusCode = 413;
        return next(e);
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest('Unexpected file field. Upload the "front" and "back" files only'));
      return next(badRequest('The upload could not be read'));
    }
    return next(err);
  });
};

// Verifies the bytes really are an accepted file type and attaches
//   req.verificationFiles = { front?: { buffer, mime, ext, size, sha256 }, back?: {...} }
// An empty or mismatching file is rejected with 400.
const verifyDocuments = (req, _res, next) => {
  const files = {};
  for (const side of SIDES) {
    const file = req.files && req.files[side] && req.files[side][0];
    if (!file) continue;
    const kind = sniffDocument(file.buffer);
    if (!kind) return next(badRequest(`The ${side} file is not a valid JPG, PNG, WebP or PDF. ${ACCEPTED_MESSAGE}`));
    files[side] = {
      buffer: file.buffer,
      mime: kind.mime,
      ext: kind.ext,
      size: file.size,
      sha256: crypto.createHash('sha256').update(file.buffer).digest('hex'),
    };
  }
  req.verificationFiles = files;
  next();
};

module.exports = { uploadDocuments, verifyDocuments, SIDES };
