// const config = require('../../config/env');

// // Storage is chosen once from STORAGE_DRIVER. To move to cloud storage later, add a driver file
// // (e.g. s3.js) that exports the same save / keyFromUrl / removeByUrl methods as local.js and
// // register it below. No route, controller or frontend code needs to change.
// const drivers = {
//   local: () =>
//     require('./local')({
//       rootDir: config.upload.dir,
//       publicBaseUrl: config.upload.publicBaseUrl,
//     }),
// };

// const create = drivers[config.upload.driver];
// if (!create) {
//   throw new Error(`Unknown STORAGE_DRIVER "${config.upload.driver}". Available: ${Object.keys(drivers).join(', ')}`);
// }

// module.exports = create();


const config = require('../../config/env');

// Register available storage drivers.
const drivers = {
  // Local storage driver
  local: () =>
    require('./local')({
      rootDir: config.upload.dir,
      publicBaseUrl: config.upload.publicBaseUrl,
    }),

  // Cloudinary storage driver
  cloudinary: () =>
    require('./cloudinary'),
};

// Select driver from STORAGE_DRIVER environment variable.
const driverName = config.upload.driver;
const create = drivers[driverName];

if (!create) {
  throw new Error(
    `Unknown STORAGE_DRIVER "${driverName}". Available: ${Object.keys(drivers).join(', ')}`
  );
}

// Initialize selected storage driver.
const storage = create();

module.exports = storage;
