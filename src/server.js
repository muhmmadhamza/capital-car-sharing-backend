const path = require('path');
const config = require('./config/env');
const app = require('./app');
const { pool } = require('./database/pool');
const storage = require('./services/storage');
const privateStore = require('./services/storage/privateStore');

const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// Checks the upload folders once at startup and says loudly what is wrong. It never stops the server:
// a storage problem must not turn the whole API into a 503 (login, search and bookings keep working).
async function checkStorage() {
  const appDir = path.resolve(__dirname, '..');
  const pub = await storage.check();
  if (pub.writable) {
    console.log(`Public uploads folder OK (writable): ${pub.rootDir}  ->  ${config.upload.publicBaseUrl}/uploads/`);
  } else {
    console.error(`!! Public uploads folder is NOT writable: ${pub.rootDir} (${pub.error}). Photo uploads will fail until UPLOAD_DIR points to a writable folder.`);
  }

  for (const [label, dir] of [['UPLOAD_DIR', storage.rootDir], ['VERIFICATION_STORAGE_DIR', privateStore.rootDir]]) {
    if (dir.includes(`${path.sep}hbuilds${path.sep}`) || (config.isProduction && inside(dir, appDir))) {
      console.warn(
        `!! ${label} (${dir}) is inside the deployed app folder. Hostinger builds every deployment into a new folder, ` +
          'so files saved here may be lost on the next deploy. Use an absolute path outside the app folder (see UPLOADS.md).'
      );
    }
  }
  if (config.isProduction && !config.upload.dirWasConfigured) {
    console.warn('!! UPLOAD_DIR is not set; using the default folder inside the app. Set UPLOAD_DIR to an absolute path.');
  }
}

async function start() {
  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected');
  } catch (err) {
    console.error('Cannot connect to PostgreSQL:', err.message);
    console.error('Check your .env database settings and that PostgreSQL is running.');
    process.exit(1);
  }

  await checkStorage();

  // config.port comes from the PORT variable the hosting platform provides (5000 only for local development).
  const server = app.listen(config.port, () => {
    const addr = server.address();
    const listening = addr && typeof addr === 'object' ? addr.port : config.port; // a socket path under some hosts
    console.log(`Capital Car Sharing API listening on port ${listening} (${config.nodeEnv}); public URL ${config.upload.publicBaseUrl}`);
  });

  const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();
