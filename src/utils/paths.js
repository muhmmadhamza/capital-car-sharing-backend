const os = require('os');
const path = require('path');

// Node does not expand "~" in paths from environment variables. This lets UPLOAD_DIR=~/capital-storage/uploads
// resolve to the account's home folder (e.g. /home/u123456789/capital-storage/uploads on Hostinger).
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

module.exports = { expandHome };
