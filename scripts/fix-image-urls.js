// One-time, NON-DESTRUCTIVE repair of car photo URLs that were saved with a localhost address.
//
//   node scripts/fix-image-urls.js            -> dry run: only prints what would change
//   node scripts/fix-image-urls.js --apply    -> rewrites the URL text in car_images
//
// It only changes the text of car_images.image_url:
//   http://localhost:5000/uploads/cars/1/x.jpg  ->  <PUBLIC_BASE_URL>/uploads/cars/1/x.jpg
//   /uploads/cars/1/x.jpg                       ->  <PUBLIC_BASE_URL>/uploads/cars/1/x.jpg
// It never deletes rows or files, never touches other URLs (placeholder / external images are left alone),
// and runs in a single transaction. It also reports which of the files really exist in UPLOAD_DIR.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../src/config/env');
const { query, withTransaction, pool } = require('../src/database/pool');

const APPLY = process.argv.includes('--apply');
const base = config.upload.publicBaseUrl;
// Same rule as the storage driver's keyFromUrl: localhost / 127.0.0.1 on any port, or a site-relative path.
const LOCAL_URL = /^(?:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?)?\/uploads\/(cars\/[A-Za-z0-9_\-]+\/[A-Za-z0-9_\-.]+)$/;

(async () => {
  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'}: rewriting local photo URLs to ${base}/uploads/...`);
  if (config.isProduction && /localhost/.test(base)) throw new Error('PUBLIC_BASE_URL still points to localhost');

  const { rows } = await query('SELECT id, car_id, image_url FROM car_images ORDER BY id');
  const plan = [];
  let current = 0;
  let external = 0;
  for (const r of rows) {
    const m = LOCAL_URL.exec(r.imageUrl);
    if (m) plan.push({ id: r.id, carId: r.carId, from: r.imageUrl, key: m[1], to: `${base}/uploads/${m[1]}` });
    else if (r.imageUrl.startsWith(`${base}/uploads/`)) current += 1;
    else external += 1;
  }
  const toChange = plan.filter((p) => p.from !== p.to);
  const missing = plan.filter((p) => !fs.existsSync(path.join(config.upload.dir, p.key)));

  console.log(`car_images rows: ${rows.length}`);
  console.log(`  already correct (${base}/uploads/...): ${current}`);
  console.log(`  other URLs left untouched (external/placeholder images): ${external}`);
  console.log(`  local URLs to rewrite: ${toChange.length}`);
  for (const p of toChange) console.log(`    #${p.id} car ${p.carId}: ${p.from}  ->  ${p.to}`);
  if (missing.length) {
    console.log(`\n  WARNING: ${missing.length} of the local photos are NOT in ${config.upload.dir} (uploaded on another machine, or lost). Their URLs will 404 until the photo is uploaded again:`);
    for (const p of missing) console.log(`    #${p.id} car ${p.carId}: ${p.key}`);
  }

  if (!APPLY) console.log('\nNothing was changed. Run again with --apply to rewrite the URLs.');
  else if (toChange.length) {
    await withTransaction(async (q) => {
      for (const p of toChange) await q('UPDATE car_images SET image_url = $1 WHERE id = $2 AND image_url = $3', [p.to, p.id, p.from]);
    });
    console.log(`\nUpdated ${toChange.length} row(s).`);
  } else console.log('\nNothing to update.');
  await pool.end();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
