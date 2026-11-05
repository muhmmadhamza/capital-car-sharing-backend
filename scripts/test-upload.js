// End-to-end check of car photo uploads against a RUNNING API and its PostgreSQL database.
//   1. npm run db:setup     (once)      2. npm run dev      3. npm run test:upload
// Uses the seeded demo accounts (password: Password123!). Creates and then deletes its own test cars.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../src/config/env');
const { query, pool } = require('../src/database/pool');

const API = (process.env.API_URL || `http://localhost:${config.port}`) + '/api';
const PASSWORD = 'Password123!';

// Tiny but genuine 1x1 images
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else { failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
};

async function call(method, url, { token, json, file, filename = 'photo.png', type = 'image/png', field = 'image' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (file) { body = new FormData(); body.append(field, new Blob([file], { type }), filename); }
  const res = await fetch(url.startsWith('http') ? url : API + url, { method, headers, body });
  let data = null;
  try { data = await res.clone().json(); } catch { /* not json */ }
  return { status: res.status, data, res };
}
const login = async (role, email) => (await call('POST', `/auth/${role}/login`, { json: { email, password: PASSWORD } })).data.data.token;

const carBody = (over = {}) => ({
  make: 'Test', model: 'Upload', year: 2022, type: 'Sedan', seats: 5, doors: 4, transmission: 'Automatic',
  fuelType: 'Petrol', dailyPrice: 50, location: 'Islamabad', ...over,
});
const dbImages = async (carId) => (await query('SELECT car_id, image_url, sort_order FROM car_images WHERE car_id = $1 ORDER BY sort_order, id', [carId])).rows;
const onDisk = (url) => fs.existsSync(path.join(config.upload.dir, url.slice(config.upload.publicBaseUrl.length + '/uploads/'.length)));

(async () => {
  const p1 = await login('partner', 'partner1@capitalcarsharing.com');
  const p2 = await login('partner', 'partner2@capitalcarsharing.com');
  const cust = await login('customer', 'customer1@capitalcarsharing.com');
  const admin = await login('admin', 'admin@capitalcarsharing.com');
  const car = (await call('POST', '/partners/me/cars', { token: p1, json: carBody() })).data.data.car;
  const created = [car.id];
  const up = (token, id, opts) => call('POST', `/partners/me/cars/${id}/images`, { token, ...opts });

  console.log('\nAuthentication and authorization');
  check('no token -> 401', (await up(undefined, car.id, { file: PNG })).status === 401);
  check('customer -> 403', (await up(cust, car.id, { file: PNG })).status === 403);
  check('admin -> 403 (admins do not edit partner cars)', (await up(admin, car.id, { file: PNG })).status === 403);
  const foreign = await up(p2, car.id, { file: PNG });
  check("other partner's car -> 404 and nothing stored", foreign.status === 404 && (await dbImages(car.id)).length === 0);

  console.log('\nValid uploads are stored and saved to car_images');
  const sent = [['png', PNG, 'image/png', 'a.png'], ['jpg', JPG, 'image/jpeg', 'b.jpg'], ['webp', WEBP, 'image/webp', 'c.webp']];
  const urls = [];
  for (const [ext, buf, type, filename] of sent) {
    const r = await up(p1, car.id, { file: buf, type, filename });
    const url = r.data?.data?.image?.url;
    check(`${ext} -> 201 with URL`, r.status === 201 && url && url.endsWith(`.${ext}`) && url.startsWith(config.upload.publicBaseUrl + '/uploads/cars/'), JSON.stringify(r.data));
    if (url) urls.push(url);
  }
  const rows = await dbImages(car.id);
  check('3 rows in car_images for this car_id, in order', rows.length === 3 && rows.every((r, i) => r.carId === car.id && r.imageUrl === urls[i] && r.sortOrder === i), JSON.stringify(rows));
  check('files exist on disk', urls.every(onDisk));
  const shown = (await call('GET', `/partners/me/cars/${car.id}`, { token: p1 })).data.data.car;
  check('car details API returns the URLs', JSON.stringify(shown.images) === JSON.stringify(urls));
  for (const [i, url] of urls.entries()) {
    const r = await fetch(url);
    const bytes = Buffer.from(await r.arrayBuffer());
    check(`GET ${path.basename(url)} serves identical bytes as ${sent[i][2]}`, r.status === 200 && r.headers.get('content-type') === sent[i][2] && bytes.equals(sent[i][1]));
  }
  const head = await fetch(urls[0]);
  check('image served with cross-origin + nosniff headers', head.headers.get('cross-origin-resource-policy') === 'cross-origin' && head.headers.get('x-content-type-options') === 'nosniff');

  console.log('\nInvalid files are rejected');
  const before = fs.readdirSync(path.join(config.upload.dir, 'cars', String(shown.partnerId)));
  const bad = [
    ['text file renamed .png (claims image/png)', Buffer.from('this is not an image'), 'image/png', 'fake.png', 400],
    ['GIF', GIF, 'image/gif', 'a.gif', 400],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'x.svg', 400],
    ['HTML claiming image/jpeg', Buffer.from('<html><script>alert(1)</script></html>'), 'image/jpeg', 'x.jpg', 400],
    ['PDF', Buffer.from('%PDF-1.4'), 'application/pdf', 'x.pdf', 400],
  ];
  for (const [name, buf, type, filename, status] of bad) {
    const r = await up(p1, car.id, { file: buf, type, filename });
    check(`${name} -> ${status}`, r.status === status && r.data?.success === false, `${r.status} ${JSON.stringify(r.data)}`);
  }
  const tooBig = Buffer.concat([PNG, Buffer.alloc(config.upload.maxFileSizeBytes + 1024)]);
  const big = await up(p1, car.id, { file: tooBig });
  check(`file over ${config.upload.maxFileSizeBytes / 1048576} MB -> 413`, big.status === 413, `${big.status} ${JSON.stringify(big.data)}`);
  const none = await call('POST', `/partners/me/cars/${car.id}/images`, { token: p1, json: {} });
  check('no file -> 400', none.status === 400);
  const wrongField = await up(p1, car.id, { file: PNG, field: 'photo' });
  check('wrong field name -> 400', wrongField.status === 400);
  check('rejected uploads left no rows and no files',
    (await dbImages(car.id)).length === 3 && fs.readdirSync(path.join(config.upload.dir, 'cars', String(shown.partnerId))).length === before.length);

  console.log('\nFile serving is safe');
  for (const p of ['/uploads/../.env', '/uploads/%2e%2e/.env', '/uploads/cars/', '/uploads/..%2f..%2fpackage.json']) {
    const r = await fetch(config.upload.publicBaseUrl + p);
    check(`GET ${p} is not served`, r.status !== 200 || !(await r.clone().text()).includes('JWT_SECRET') );
  }

  console.log('\nUpload before the car exists (create form), then save with the car');
  const staged = await call('POST', '/partners/me/car-images', { token: p1, file: PNG });
  const sUrl = staged.data?.data?.image?.url;
  check('staged upload -> 201 with URL, file on disk', staged.status === 201 && !!sUrl && onDisk(sUrl));
  check('staged upload as customer -> 403', (await call('POST', '/partners/me/car-images', { token: cust, file: PNG })).status === 403);
  check("another partner cannot attach my staged photo to their car", (await call('POST', '/partners/me/cars', { token: p2, json: carBody({ images: [sUrl] }) })).status === 403);
  const withStaged = await call('POST', '/partners/me/cars', { token: p1, json: carBody({ images: [sUrl] }) });
  const car2 = withStaged.data?.data?.car;
  if (car2) created.push(car2.id);
  check('my own staged photo saves with the new car', withStaged.status === 201 && (await dbImages(car2.id)).map((r) => r.imageUrl).join() === sUrl);

  console.log('\nRemoving a photo deletes its file; deleting a car cleans up');
  const keep = [urls[0], urls[2]];
  const upd = await call('PUT', `/partners/me/cars/${car.id}`, { token: p1, json: { images: keep } });
  check('update with fewer images -> rows updated', upd.status === 200 && (await dbImages(car.id)).length === 2);
  check('removed photo file deleted, kept photos remain', !onDisk(urls[1]) && onDisk(urls[0]) && onDisk(urls[2]));
  check('cannot upload to a deleted/unknown car -> 404', (await up(p1, 999999, { file: PNG })).status === 404);

  console.log('\nPer-car limit');
  let last;
  for (let i = 0; i < config.upload.maxImagesPerCar; i += 1) last = await up(p1, car2.id, { file: PNG });
  check(`photo #${config.upload.maxImagesPerCar + 1} is refused with 400`, last.status === 400, `${last.status}`);

  const allUrls = [...(await dbImages(car.id)), ...(await dbImages(car2.id))].map((r) => r.imageUrl);
  for (const id of created) await call('DELETE', `/partners/me/cars/${id}`, { token: p1 });
  check('deleting the cars removes rows and files', (await dbImages(car.id)).length === 0 && allUrls.every((u) => !onDisk(u)));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) console.log('Failed:\n - ' + failures.join('\n - '));
  await pool.end();
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => { console.error('Test run crashed:', e); await pool.end().catch(() => {}); process.exit(1); });
