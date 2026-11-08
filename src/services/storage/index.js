const config = require('../../config/env');

// Car photos are stored on the server's own disk (STORAGE_DRIVER=local) and served at /uploads.
// To move to object storage later, add a driver file (e.g. s3.js) exposing the same methods as local.js
// (save, keyFromUrl, removeByUrl, check) and register it below. No route, controller or frontend code changes.
const drivers = {
  local: () =>
    require('./local')({
      rootDir: config.upload.dir,
      publicBaseUrl: config.upload.publicBaseUrl,
    }),
};

const create = drivers[config.upload.driver];
if (!create) {
  throw new Error(
    `Unknown STORAGE_DRIVER "${config.upload.driver}". Set STORAGE_DRIVER=local (available: ${Object.keys(drivers).join(', ')}).`
  );
}

module.exports = create();
