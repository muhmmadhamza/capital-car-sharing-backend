const crypto = require('crypto');
const multer = require('multer');
const config = require('../config/env');
const { badRequest } = require('../utils/errors');

// Accepted formats. The extension we store comes from this table (never from the client's file name),
// and the file's real content must match one of these signatures.
const TYPES = {
  'image/jpeg': { ext: 'jpg' },
  'image/png': { ext: 'png' },
  'image/webp': { ext: 'webp' },
};
const ACCEPTED_MESSAGE = 'Only JPG, PNG and WebP images are allowed';

// Detects the real type from the first bytes of the file.
function sniff(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const parser = multer({
  storage: multer.memoryStorage(), // the storage driver decides where the bytes finally go
  limits: { fileSize: config.upload.maxFileSizeBytes, files: 1, fields: 5, parts: 7 },
  fileFilter: (_req, file, cb) => {
    // First, cheap rejection on the declared type. The content check below is the real one.
    if (!TYPES[file.mimetype]) return cb(badRequest(ACCEPTED_MESSAGE));
    cb(null, true);
  },
});

// Accepts one image in the multipart field "image".
const singleImage = parser.single('image');

// Verifies the uploaded bytes really are the image type they claim to be, and attaches
// req.image = { buffer, mime, ext, size, key } where `key` is a random, safe storage name.
const verifyImage = (keyPrefix) => (req, _res, next) => {
  if (!req.file) return next(badRequest('No image was uploaded. Send the file in the "image" field.'));
  const mime = sniff(req.file.buffer);
  if (!mime) return next(badRequest(ACCEPTED_MESSAGE));
  const { ext } = TYPES[mime];
  const id = crypto.randomUUID();
  const prefix = typeof keyPrefix === 'function' ? keyPrefix(req) : keyPrefix;
  req.image = { buffer: req.file.buffer, mime, ext, size: req.file.size, key: `${prefix}/${id}.${ext}` };
  next();
};

const MB = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;

// Turns Multer's own errors into the API's usual error shape.
// eslint-disable-next-line no-unused-vars
function handleUploadError(err, _req, _res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const e = badRequest(`Image is too large. The maximum size is ${MB(config.upload.maxFileSizeBytes)} MB`);
      e.statusCode = 413;
      return next(e);
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
      return next(badRequest('Upload exactly one image per request, in the "image" field'));
    }
    return next(badRequest('The upload could not be read'));
  }
  return next(err);
}

module.exports = { singleImage, verifyImage, handleUploadError, TYPES, sniff };
