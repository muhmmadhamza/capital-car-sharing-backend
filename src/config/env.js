require('dotenv').config();
const path = require('path');

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

const port = parseInt(process.env.PORT || '5000', 10);

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
    // Which storage driver saves car photos. Only "local" exists today (see src/services/storage).
    driver: process.env.STORAGE_DRIVER || 'local',
    // Local driver: folder (relative to the backend folder, or absolute) that holds the files.
    dir: path.resolve(process.env.UPLOAD_DIR || 'uploads'),
    maxFileSizeBytes: Math.round(parseFloat(process.env.UPLOAD_MAX_FILE_SIZE_MB || '5') * 1024 * 1024),
    // Origin the browser uses to reach this API. Stored image URLs are built from it,
    // so they work from the Next.js app (a different origin) and later from a CDN.
    publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
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
