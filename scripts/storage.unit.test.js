// Offline checks for the production upload configuration. No database, no network, no running server.
//   npm run test:storage:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ENV_PATH = require.resolve('../src/config/env');
const BASE = { JWT_SECRET: 'test-secret', DATABASE_URL: 'postgres://u:p@localhost/db' };

// Loads src/config/env.js fresh with exactly these environment variables.
function loadConfig(vars) {
  const keep = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(PORT|NODE_ENV|PUBLIC_BASE_URL|UPLOAD_DIR|STORAGE_DRIVER|VERIFICATION_STORAGE_DIR)$/.test(k)) delete process.env[k];
  Object.assign(process.env, BASE, vars);
  delete require.cache[ENV_PATH];
  try {
    return require(ENV_PATH);
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, keep);
    delete require.cache[ENV_PATH];
  }
}
const PROD = { NODE_ENV: 'production', PORT: '3000' };

test('production: PUBLIC_BASE_URL is normalised to the https origin (no trailing slash or path)', () => {
  assert.equal(loadConfig({ ...PROD, PUBLIC_BASE_URL: 'https://api.capitalcarsharing.com/' }).upload.publicBaseUrl, 'https://api.capitalcarsharing.com');
  assert.equal(loadConfig({ ...PROD, PUBLIC_BASE_URL: ' https://api.capitalcarsharing.com ' }).upload.publicBaseUrl, 'https://api.capitalcarsharing.com');
});
test('production: unset PUBLIC_BASE_URL falls back to the real API domain, never localhost', () => {
  assert.equal(loadConfig(PROD).upload.publicBaseUrl, 'https://api.capitalcarsharing.com');
});
test('production: localhost, http and garbage PUBLIC_BASE_URL are rejected at startup', () => {
  for (const bad of ['http://localhost:5000', 'https://localhost', 'http://api.capitalcarsharing.com', 'not a url', 'api.capitalcarsharing.com', 'ftp://x.com'])
    assert.throws(() => loadConfig({ ...PROD, PUBLIC_BASE_URL: bad }), /PUBLIC_BASE_URL/, bad);
});
test('development keeps the localhost default', () => {
  const c = loadConfig({ NODE_ENV: 'development' });
  assert.equal(c.upload.publicBaseUrl, 'http://localhost:5000');
  assert.equal(c.port, 5000);
});
test('PORT comes from the environment; it is never forced to 5000 in production', () => {
  assert.equal(loadConfig({ ...PROD, PORT: '43210' }).port, 43210);
  assert.equal(loadConfig({ NODE_ENV: 'production' }).port, 0); // host assigns it
  assert.throws(() => loadConfig({ ...PROD, PORT: 'abc' }), /PORT/);
});
test('UPLOAD_DIR: absolute stays absolute, "~/" expands to the home folder', () => {
  assert.equal(loadConfig({ ...PROD, UPLOAD_DIR: '/home/u1/capital-storage/uploads' }).upload.dir, '/home/u1/capital-storage/uploads');
  assert.equal(loadConfig({ ...PROD, UPLOAD_DIR: '~/capital-storage/uploads' }).upload.dir, path.join(os.homedir(), 'capital-storage', 'uploads'));
  assert.ok(path.isAbsolute(loadConfig(PROD).upload.dir));
});

const createLocal = require('../src/services/storage/local');
const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-uploads-'));
const BASE_URL = 'https://api.capitalcarsharing.com';

test('local driver: save() returns an https URL under /uploads and writes the file', async () => {
  const dir = mkdtemp();
  const s = createLocal({ rootDir: dir, publicBaseUrl: BASE_URL });
  const { url, key } = await s.save({ key: 'cars/1/abc-123.jpg', buffer: Buffer.from('x') });
  assert.equal(url, 'https://api.capitalcarsharing.com/uploads/cars/1/abc-123.jpg');
  assert.ok(!/localhost|NaN|undefined/.test(url));
  assert.equal(fs.readFileSync(path.join(dir, key), 'utf8'), 'x');
  assert.equal(new URL(url).protocol, 'https:');
});
test('local driver: never overwrites and refuses unsafe keys', async () => {
  const s = createLocal({ rootDir: mkdtemp(), publicBaseUrl: BASE_URL });
  await s.save({ key: 'cars/1/a.png', buffer: Buffer.from('1') });
  await assert.rejects(s.save({ key: 'cars/1/a.png', buffer: Buffer.from('2') }), /not available/);
  for (const k of ['../x.png', 'cars/../../x.png', '/etc/passwd', 'cars\\1\\a.png', '']) await assert.rejects(s.save({ key: k, buffer: Buffer.from('x') }), k);
});
test('local driver: keyFromUrl understands current URLs, legacy localhost URLs and relative paths', () => {
  const s = createLocal({ rootDir: mkdtemp(), publicBaseUrl: BASE_URL });
  assert.equal(s.keyFromUrl(`${BASE_URL}/uploads/cars/7/a.jpg`), 'cars/7/a.jpg');
  assert.equal(s.keyFromUrl('http://localhost:5000/uploads/cars/7/a.jpg'), 'cars/7/a.jpg');
  assert.equal(s.keyFromUrl('/uploads/cars/7/a.jpg'), 'cars/7/a.jpg');
});
test('local driver: keyFromUrl returns null for foreign hosts and traversal attempts', () => {
  const s = createLocal({ rootDir: mkdtemp(), publicBaseUrl: BASE_URL });
  for (const u of [
    'https://res.cloudinary.com/x/image/upload/a.jpg', 'https://evil.com/uploads/cars/7/a.jpg', 'https://api.capitalcarsharing.com.evil.com/uploads/cars/7/a.jpg',
    `${BASE_URL}/uploads/../.env`, `${BASE_URL}/uploads/%2e%2e/.env`, `${BASE_URL}/uploads/cars/7/..%2f..%2fx.jpg`, `${BASE_URL}/other/cars/7/a.jpg`,
    '//evil.com/uploads/cars/7/a.jpg', '', null, undefined, 42,
  ]) assert.equal(s.keyFromUrl(u), null, String(u));
});
test('local driver: removeByUrl deletes our files (also legacy localhost URLs) and ignores everything else', async () => {
  const dir = mkdtemp();
  const s = createLocal({ rootDir: dir, publicBaseUrl: BASE_URL });
  await s.save({ key: 'cars/1/a.png', buffer: Buffer.from('1') });
  await s.save({ key: 'cars/1/b.png', buffer: Buffer.from('2') });
  await s.removeByUrl(`${BASE_URL}/uploads/cars/1/a.png`);
  await s.removeByUrl('http://localhost:5000/uploads/cars/1/b.png');
  await s.removeByUrl('https://res.cloudinary.com/x/a.png');
  await s.removeByUrl(`${BASE_URL}/uploads/cars/1/missing.png`); // no throw
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cars', '1')), []);
});
test('local driver: check() reports writable / not writable without throwing', async () => {
  assert.equal((await createLocal({ rootDir: mkdtemp(), publicBaseUrl: BASE_URL }).check()).writable, true);
  const blocked = path.join(mkdtemp(), 'file');
  fs.writeFileSync(blocked, 'x'); // a FILE where a folder is needed
  const r = await createLocal({ rootDir: path.join(blocked, 'uploads'), publicBaseUrl: BASE_URL }).check();
  assert.equal(r.writable, false);
  assert.ok(r.error);
});
test('private store refuses to live inside the public upload folder (and the reverse)', () => {
  const createPrivate = require('../src/services/storage/private');
  const pub = mkdtemp();
  assert.throws(() => createPrivate({ rootDir: path.join(pub, 'private'), publicDir: pub }), /different folder/);
  assert.throws(() => createPrivate({ rootDir: pub, publicDir: path.join(pub, 'x') }), /different folder/);
  assert.doesNotThrow(() => createPrivate({ rootDir: mkdtemp(), publicDir: pub }));
});
test('no Cloudinary left in code, config or dependencies', () => {
  const root = path.join(__dirname, '..');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', '.git'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  const hits = walk(root).filter((f) => !f.endsWith('storage.unit.test.js') && !f.endsWith('UPLOADS.md') && /cloudinary/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});
