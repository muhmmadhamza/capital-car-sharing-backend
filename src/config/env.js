require('dotenv').config();
const path = require('path');
const { expandHome } = require('../utils/paths');

const required = ['JWT_SECRET'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

const hasUrl = !!process.env.DATABASE_URL;
const hasParts = process.env.DB_HOST && process.env.DB_NAME && process.env.DB_USER;
if (!hasUrl && !hasParts) {
  throw new Error('Set DATABASE_URL or DB_HOST/DB_NAME/DB_USER/DB_PASSWORD/DB_PORT');
}

const isProduction = process.env.NODE_ENV === 'production';

// PORT: the hosting platform (Hostinger) supplies it at runtime, so it is never hardcoded in production.
// The 5000 fallback exists only for local development. In production without PORT we listen on port 0
// (the host/Passenger assigns the real one) and log a warning, instead of crashing the site.
const rawPort = (process.env.PORT || '').trim();
let port;
if (rawPort) {
  port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`PORT is invalid: "${rawPort}"`);
} else if (isProduction) {
  console.warn('PORT is not set; letting the hosting platform assign it. Do not hardcode PORT on Hostinger.');
  port = 0;
} else {
  port = 5000;
}

// PUBLIC_BASE_URL = the origin the BROWSER uses to reach this API. Every stored photo URL starts with it.
// Production: must be an https URL that is not localhost (a wrong value would be saved into the database, so
// it is checked once at startup). If it is not set in production it defaults to the real API domain.
const PRODUCTION_BASE_URL = 'https://api.capitalcarsharing.com';
function resolvePublicBaseUrl() {
  const raw = (process.env.PUBLIC_BASE_URL || '').trim();
  if (!raw) {
    if (isProduction) {
      console.warn(`PUBLIC_BASE_URL is not set; using ${PRODUCTION_BASE_URL}. Set it explicitly in the Hostinger environment variables.`);
      return PRODUCTION_BASE_URL;
    }
    return `http://localhost:${port}`;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a valid URL: "${raw}". Example: ${PRODUCTION_BASE_URL}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('PUBLIC_BASE_URL must start with https:// (or http:// for local development)');
  if (isProduction) {
    if (url.protocol !== 'https:') throw new Error(`PUBLIC_BASE_URL must use https in production (got "${raw}")`);
    if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/i.test(url.hostname)) {
      throw new Error(`PUBLIC_BASE_URL must not point to localhost in production (got "${raw}"). Use ${PRODUCTION_BASE_URL}`);
    }
  }
  return url.origin; // origin only: no path, no trailing slash
}
const publicBaseUrl = resolvePublicBaseUrl();

// The IANA time zone that decides what "today" means for car availability. The frontend shows the date
// the API reports, so every screen agrees. Default UTC keeps the previous behaviour.
const businessTimeZone = process.env.BUSINESS_TIME_ZONE || 'UTC';
try {
  new Intl.DateTimeFormat('en-CA', { timeZone: businessTimeZone });
} catch {
  throw new Error(`BUSINESS_TIME_ZONE is not a valid IANA time zone: ${businessTimeZone}`);
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction,
  port,
  businessTimeZone,
  db: {
    url: process.env.DATABASE_URL,
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  upload: {
    // Which storage driver saves car photos. Only "local" exists (see src/services/storage).
    driver: (process.env.STORAGE_DRIVER || 'local').trim().toLowerCase(),
    // Local driver: folder that holds the PUBLIC car photos (served at /uploads). Use an ABSOLUTE path in
    // production, outside the deployed app folder, so redeploys do not replace it. "~/" is expanded.
    dir: path.resolve(expandHome(process.env.UPLOAD_DIR || 'uploads')),
    dirWasConfigured: !!process.env.UPLOAD_DIR,
    maxFileSizeBytes: Math.round(parseFloat(process.env.UPLOAD_MAX_FILE_SIZE_MB || '5') * 1024 * 1024),
    // Origin the browser uses to reach this API. Stored image URLs are built from it,
    // so they work from the Next.js app (a different origin) and later from a CDN.
    publicBaseUrl,
    maxImagesPerCar: 15,
  },
  // Password-reset emails. When SMTP_HOST is empty no email can be sent (the API logs a warning and still
  // gives the same generic response, so nothing is revealed about which accounts exist).
  frontendUrl: (process.env.FRONTEND_URL || (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',')[0].trim()).replace(/\/+$/, ''),
  passwordReset: {
    ttlMinutes: parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '30', 10),
    // A new link is not issued/sent again for the same account within this window.
    cooldownSeconds: parseInt(process.env.PASSWORD_RESET_COOLDOWN_SECONDS || '60', 10),
  },
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    // true = implicit TLS (usually port 465). false = STARTTLS is used when the server offers it.
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || process.env.SMTP_PORT === '465',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@capitalcarsharing.com',
  },
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim()),
};


