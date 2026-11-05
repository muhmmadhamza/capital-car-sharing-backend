// Deletes identity-document files whose retention period has passed (VERIFICATION_RETENTION_DAYS, default 30
// days after the review decision). Personal details and the audit trail are kept; only the document files and
// their metadata rows are removed. Schedule it daily, e.g. with cron:   0 3 * * *  cd /path/to/backend && npm run verification:purge
require('../src/config/env');
const { pool } = require('../src/database/pool');
const { purgeExpiredDocuments } = require('../src/services/verification.service');

purgeExpiredDocuments()
  .then(({ purged, disabled }) => {
    if (disabled) console.log('Retention purge is disabled (VERIFICATION_RETENTION_DAYS=0). Nothing deleted.');
    else console.log(`Purged documents for ${purged} verification record(s).`);
  })
  .catch((err) => {
    console.error('Purge failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
