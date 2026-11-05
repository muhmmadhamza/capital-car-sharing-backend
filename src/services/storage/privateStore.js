const config = require('../../config/env');
const { getPolicy } = require('../../config/verification');
const createPrivateStore = require('./private');

// The one private store used for identity documents. Fails at startup (on first require) if it is misconfigured,
// for example when it points into the public /uploads folder.
module.exports = createPrivateStore({ rootDir: getPolicy().storageDir, publicDir: config.upload.dir });
