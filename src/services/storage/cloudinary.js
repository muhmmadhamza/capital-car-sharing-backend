// 





const { v2: cloudinary } = require('cloudinary');
const config = require('../../config/env');
const diag = require('./cloudinaryDiagnostics');

const cloudName = config.upload.cloudinary.cloudName;
const apiKey = config.upload.cloudinary.apiKey;
const apiSecret = config.upload.cloudinary.apiSecret;

if (!cloudName || !apiKey || !apiSecret) {
  throw new Error('Missing Cloudinary environment variables');
}

// Configure Cloudinary
cloudinary.config({
  cloud_name: cloudName,
  api_key: apiKey,
  api_secret: apiSecret,
  secure: true,
});

// ---- Diagnostics (safe: never logs the API secret, API key or signatures) ----
const redact = diag.makeRedactor([apiSecret, apiKey]);
const logJson = (level, label, data) => console[level](`[cloudinary] ${label} ${JSON.stringify(data)}`);

let sdkVersion = 'unknown';
try { sdkVersion = require('cloudinary/package.json').version; } catch { /* ignore */ }

// Printed once when this driver is loaded, so the server log proves which driver is active and how the
// credentials look (presence / length / stray whitespace or quotes), without revealing them.
logJson('log', 'driver loaded', {
  sdkVersion,
  node: process.version,
  nodeEnv: process.env.NODE_ENV || '(unset)',
  cloudinaryUrlEnvIsSet: !!process.env.CLOUDINARY_URL,
  credentials: diag.describeConfig({ cloudName, apiKey, apiSecret }),
});

// Opt-in (CLOUDINARY_DIAG_ON_FAIL=true): after a failed upload, run the raw probe once per 10 minutes from
// inside this very process, so it uses the same server, outbound IP and environment variables as the app.
let lastProbeAt = 0;
function maybeProbeAfterFailure() {
  if (String(process.env.CLOUDINARY_DIAG_ON_FAIL).toLowerCase() !== 'true') return;
  if (Date.now() - lastProbeAt < 10 * 60 * 1000) return;
  lastProbeAt = Date.now();
  diag
    .runProbe({ cloudName, apiKey, apiSecret })
    .then((result) => logJson('error', 'diagnostic probe after failed upload', result))
    .catch((err) => logJson('error', 'diagnostic probe crashed', { message: redact(err && err.message) }));
}

// Convert Cloudinary URL into public ID.
function getPublicId(url) {
  try {
    if (typeof url !== 'string') return null;

    const parsed = new URL(url);

    if (
      parsed.hostname !== 'res.cloudinary.com' ||
      parsed.pathname.split('/')[1] !== cloudName
    ) {
      return null;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    const uploadIndex = parts.indexOf('upload');

    if (uploadIndex === -1) return null;

    const versionIndex = parts.findIndex(
      (part, index) =>
        index > uploadIndex && /^v\d+$/.test(part)
    );

    if (versionIndex === -1) return null;

    const publicId = parts
      .slice(versionIndex + 1)
      .join('/');

    return publicId.replace(/\.[^/.]+$/, '') || null;

  } catch {
    return null;
  }
}

function create() {
  return {
    name: 'cloudinary',

    // Upload image to Cloudinary
    async save({ key, buffer }) {
      if (!key || !Buffer.isBuffer(buffer)) {
        throw new Error('Invalid image upload data');
      }

      const publicId = key
        .replace(/\\/g, '/')
        .replace(/\.[^/.]+$/, '');

      if (
        publicId.startsWith('/') ||
        publicId.split('/').some(
          part => !part || part === '.' || part === '..'
        )
      ) {
        throw new Error('Invalid image storage key');
      }

      const startedAt = Date.now();
      logJson('log', 'upload start', { publicId, bytes: buffer.length });

      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            public_id: publicId,
            resource_type: 'image',
            overwrite: false,
            unique_filename: false,
            use_filename: false,
          },
          (error, uploaded) => {
            if (error) {
              logJson('error', 'upload FAILED', {
                publicId,
                bytes: buffer.length,
                elapsedMs: Date.now() - startedAt,
                name: error.name,
                message: redact(error.message),
                http_code: error.http_code,
                code: error.code, // network-level code such as ECONNRESET / ENOTFOUND / ETIMEDOUT
                syscall: error.syscall,
                errorKeys: Object.keys(error),
                hint:
                  error.name === 'UnexpectedResponse' || /unexpected status code/i.test(String(error.message))
                    ? 'The SDK received an HTTP status it does not parse and discarded the body. ' +
                      'Run `node scripts/diagnose-cloudinary.js` on this server, or set CLOUDINARY_DIAG_ON_FAIL=true, to see the raw response.'
                    : undefined,
              });
              maybeProbeAfterFailure();

              return reject(error);
            }

            logJson('log', 'upload ok', {
              publicId,
              elapsedMs: Date.now() - startedAt,
              bytes: uploaded && uploaded.bytes,
              format: uploaded && uploaded.format,
              version: uploaded && uploaded.version,
            });
            resolve(uploaded);
          }
        );

        stream.end(buffer);
      });

      return {
        url: result.secure_url,
        key: publicId,
      };
    },

    // Extract storage key from Cloudinary URL
    keyFromUrl(url) {
      return getPublicId(url);
    },

    // Delete image from Cloudinary
    async removeByUrl(url) {
      const publicId = getPublicId(url);

      if (!publicId) return false;

      const result = await cloudinary.uploader.destroy(
        publicId,
        {
          resource_type: 'image',
          invalidate: true,
        }
      );

      return result.result === 'ok';
    },
  };
}

module.exports = create();
