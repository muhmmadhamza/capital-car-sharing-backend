// Unit tests for the verification module's pure logic. No database, no network, no npm packages needed:
//   npm run test:verification:unit
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JWT_SECRET = 'unit-test-secret';
delete process.env.VERIFICATION_ENCRYPTION_KEY;

const { sniffDocument } = require('../src/utils/fileSniff');
const { encrypt, decrypt } = require('../src/utils/fieldCrypto');
const { getPolicy, publicPolicy } = require('../src/config/verification');
const createPrivateStore = require('../src/services/storage/private');
const rules = require('../src/validators/verification');

const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');

// ------------------------------------------------------------------------------------- file sniffing
test('sniffDocument accepts the real formats', () => {
  assert.equal(sniffDocument(JPG).mime, 'image/jpeg');
  assert.equal(sniffDocument(PNG).mime, 'image/png');
  assert.equal(sniffDocument(WEBP).mime, 'image/webp');
  assert.equal(sniffDocument(PDF).mime, 'application/pdf');
});

test('sniffDocument rejects disguised and unsupported files', () => {
  assert.equal(sniffDocument(Buffer.from('<?php echo 1; ?>')), null);
  assert.equal(sniffDocument(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(sniffDocument(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniffDocument(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')), null, 'GIF is not accepted');
  assert.equal(sniffDocument(Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1')), null, 'a Windows executable');
  assert.equal(sniffDocument(Buffer.alloc(0)), null, 'empty file');
  assert.equal(sniffDocument(Buffer.from('%PDF')), null, 'truncated PDF header');
  assert.equal(sniffDocument(Buffer.concat([Buffer.from('junk'), PDF])), null, 'PDF with leading junk');
  assert.equal(sniffDocument('not a buffer'), null);
});

// --------------------------------------------------------------------------------- field encryption
test('fieldCrypto round-trips and does not leak the plaintext', () => {
  const secret = 'AB1234567';
  const enc = encrypt(secret);
  assert.match(enc, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!enc.includes(secret));
  assert.equal(decrypt(enc), secret);
  assert.notEqual(encrypt(secret), enc, 'a fresh random IV per value');
  assert.equal(decrypt(null), null);
});

test('fieldCrypto detects tampering and a wrong key', () => {
  const enc = encrypt('X99999999');
  const parts = enc.split('.');
  const flipped = [...parts.slice(0, 3), Buffer.from('tampered-data').toString('base64url')].join('.');
  assert.throws(() => decrypt(flipped));
  process.env.VERIFICATION_ENCRYPTION_KEY = 'a'.repeat(64);
  assert.throws(() => decrypt(enc), 'a different key cannot read it');
  assert.equal(decrypt(encrypt('hello')), 'hello');
  delete process.env.VERIFICATION_ENCRYPTION_KEY;
});

test('fieldCrypto rejects a malformed key and requires a key in production', () => {
  process.env.VERIFICATION_ENCRYPTION_KEY = 'too-short';
  assert.throws(() => encrypt('x'), /32 bytes/);
  delete process.env.VERIFICATION_ENCRYPTION_KEY;
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  assert.throws(() => encrypt('x'), /required in production/);
  process.env.NODE_ENV = prev;
});

// ------------------------------------------------------------------------------------------ policy
test('policy defaults and configuration', () => {
  const p = getPolicy();
  assert.deepEqual(p.documentTypes.map((t) => t.type), ['national_id', 'passport', 'driving_licence']);
  assert.equal(p.documentTypes.find((t) => t.type === 'passport').requiresBack, false);
  assert.equal(p.documentTypes.find((t) => t.type === 'national_id').requiresBack, true);
  assert.ok(p.countries.length > 200);
  assert.ok(p.countries.some((c) => c.code === 'PK' && /Pakistan/.test(c.name)));
  assert.ok(!p.countries.some((c) => c.code === 'ZZ'), 'unknown region code is not offered');

  process.env.VERIFICATION_DOCUMENT_TYPES = 'passport, bogus';
  process.env.VERIFICATION_ALLOWED_COUNTRIES = 'pk, gb';
  process.env.VERIFICATION_REQUIRE_DOCUMENT_NUMBER = 'false';
  process.env.VERIFICATION_MAX_FILE_MB = '2';
  const q = getPolicy();
  assert.deepEqual(q.documentTypes.map((t) => t.type), ['passport'], 'unknown types are ignored');
  assert.equal(q.documentTypes[0].requiresNumber, false);
  assert.deepEqual(q.countries.map((c) => c.code).sort(), ['GB', 'PK']);
  assert.equal(q.maxFileSizeBytes, 2 * 1024 * 1024);
  assert.ok(!('storageDir' in publicPolicy(q)), 'the public policy never reveals the storage folder');

  process.env.VERIFICATION_DOCUMENT_TYPES = 'bogus';
  assert.throws(() => getPolicy());
  for (const k of ['VERIFICATION_DOCUMENT_TYPES', 'VERIFICATION_ALLOWED_COUNTRIES', 'VERIFICATION_REQUIRE_DOCUMENT_NUMBER', 'VERIFICATION_MAX_FILE_MB']) delete process.env[k];
});

// ---------------------------------------------------------------------------------- private storage
test('private store: safe keys, no overwrite, owner-only files, no overlap with public folder', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-priv-'));
  const pub = path.join(base, 'uploads');
  const priv = path.join(base, 'private-uploads');
  fs.mkdirSync(pub);

  const store = createPrivateStore({ rootDir: priv, publicDir: pub });
  await store.save({ key: 'verifications/7/abc.jpg', buffer: JPG });
  assert.equal(fs.statSync(path.join(priv, 'verifications/7/abc.jpg')).mode & 0o777, 0o600);
  await assert.rejects(store.save({ key: 'verifications/7/abc.jpg', buffer: PNG }), { code: 'EEXIST' });
  const { stream, size } = await store.read('verifications/7/abc.jpg');
  assert.equal(size, JPG.length);
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  assert.ok(Buffer.concat(chunks).equals(JPG));

  for (const bad of ['../escape.jpg', 'verifications/../../escape.jpg', '/etc/passwd', 'a\\b.jpg', 'a b.jpg', '', null]) {
    await assert.rejects(store.save({ key: bad, buffer: JPG }), /Invalid storage key/, `rejects key ${JSON.stringify(bad)}`);
    await assert.rejects(store.read(bad), /Invalid storage key/);
  }
  assert.equal(await store.exists('verifications/7/abc.jpg'), true);
  assert.equal(await store.remove('verifications/7/abc.jpg'), true);
  assert.equal(await store.remove('verifications/7/abc.jpg'), false, 'removing a missing file is not an error');
  await assert.rejects(store.read('verifications/7/abc.jpg'), { code: 'ENOENT' });

  assert.throws(() => createPrivateStore({ rootDir: pub, publicDir: pub }), /different folder/);
  assert.throws(() => createPrivateStore({ rootDir: path.join(pub, 'private'), publicDir: pub }), /different folder/);
  assert.throws(() => createPrivateStore({ rootDir: base, publicDir: pub }), /different folder/);
  fs.rmSync(base, { recursive: true, force: true });
});

// -------------------------------------------------------------------------------------- validators
const adult = '1990-05-17';
const valid = {
  fullLegalName: "Aisha O'Neil-Khan",
  dateOfBirth: adult,
  country: 'PK',
  phone: '+92 300 1234567',
  documentType: 'national_id',
  documentNumber: '35202-1234567-1',
};
const file = (mime = 'image/jpeg') => ({ buffer: JPG, mime, ext: 'jpg', size: JPG.length });
const run = (rule, body, files, params = {}, query = {}) => rule({ body, verificationFiles: files, params, query });

test('submit: a complete submission is valid', () => {
  assert.deepEqual(run(rules.submit, valid, { front: file(), back: file() }), []);
});

test('submit: passport needs no back image and rejects an unneeded one', () => {
  const body = { ...valid, documentType: 'passport', documentNumber: 'AB1234567' };
  assert.deepEqual(run(rules.submit, body, { front: file() }), []);
  assert.match(run(rules.submit, body, { front: file(), back: file() }).join('|'), /does not need a back/);
});

test('submit: missing pieces are reported', () => {
  const errors = run(rules.submit, {}, {});
  for (const part of [/full legal name/i, /date of birth/i, /country/i, /document type/i, /front/i]) {
    assert.ok(errors.some((e) => part.test(e)), `reports ${part}`);
  }
  assert.ok(run(rules.submit, valid, { front: file() }).some((e) => /back/i.test(e)), 'national id needs a back image');
  assert.ok(run(rules.submit, { ...valid, documentNumber: '' }, { front: file(), back: file() }).some((e) => /document number is required/i.test(e)));
});

test('submit: bad values are rejected', () => {
  const f = { front: file(), back: file() };
  const bad = (over, re) => assert.ok(run(rules.submit, { ...valid, ...over }, f).some((e) => re.test(e)), `${JSON.stringify(over)} -> ${re}`);
  bad({ fullLegalName: '<script>alert(1)</script>' }, /full legal name/i);
  bad({ fullLegalName: 'A' }, /full legal name/i);
  bad({ fullLegalName: '12345' }, /full legal name/i);
  bad({ dateOfBirth: '1990-13-40' }, /date of birth/i);
  bad({ dateOfBirth: '1990/05/17' }, /date of birth/i);
  bad({ dateOfBirth: '2999-01-01' }, /future/i);
  bad({ dateOfBirth: new Date().toISOString().slice(0, 10) }, /at least 18/i);
  bad({ dateOfBirth: '1850-01-01' }, /not valid/i);
  bad({ country: 'XX' }, /country/i);
  bad({ country: 'Pakistan' }, /country/i);
  bad({ phone: 'call me' }, /phone/i);
  bad({ documentType: 'library_card' }, /accepted document types/i);
  bad({ documentNumber: "1; DROP TABLE users;--" }, /document number/i);
  bad({ documentNumber: 'ab' }, /document number/i);
});

test('submit: age boundary is exact', () => {
  const today = new Date();
  const dob = (years, dayOffset = 0) => {
    const d = new Date(Date.UTC(today.getUTCFullYear() - years, today.getUTCMonth(), today.getUTCDate() + dayOffset));
    return d.toISOString().slice(0, 10);
  };
  const f = { front: file(), back: file() };
  assert.deepEqual(run(rules.submit, { ...valid, dateOfBirth: dob(18) }, f), [], 'turns 18 today -> allowed');
  assert.ok(run(rules.submit, { ...valid, dateOfBirth: dob(18, 1) }, f).some((e) => /at least 18/.test(e)), 'turns 18 tomorrow -> refused');
});

test('submit: country allow-list is enforced', () => {
  process.env.VERIFICATION_ALLOWED_COUNTRIES = 'GB';
  assert.ok(run(rules.submit, valid, { front: file(), back: file() }).some((e) => /country/i.test(e)));
  delete process.env.VERIFICATION_ALLOWED_COUNTRIES;
});

test('resubmit: partial updates validate only what is sent', () => {
  assert.deepEqual(run(rules.resubmit, {}), []);
  assert.deepEqual(run(rules.resubmit, { fullLegalName: 'Aisha Khan' }), []);
  assert.ok(run(rules.resubmit, { dateOfBirth: 'nope' }).length);
  assert.ok(run(rules.resubmit, { documentType: 'x' }).length);
});

test('admin status update: reasons are required to reject / request resubmission', () => {
  const upd = (body, id = '5') => run(rules.statusUpdate, body, undefined, { id });
  assert.deepEqual(upd({ status: 'approved' }), []);
  assert.deepEqual(upd({ status: 'rejected', reason: 'The photo is blurry' }), []);
  assert.deepEqual(upd({ status: 'resubmission_required', reason: 'Please upload the back of the card' }), []);
  assert.ok(upd({ status: 'rejected' }).some((e) => /reason is required/i.test(e)));
  assert.ok(upd({ status: 'rejected', reason: '   ' }).some((e) => /reason is required/i.test(e)));
  assert.ok(upd({ status: 'resubmission_required' }).some((e) => /instructions are required/i.test(e)));
  assert.ok(upd({ status: 'pending_review' }).length, 'cannot set pending_review by hand');
  assert.ok(upd({ status: 'superuser' }).length);
  assert.ok(upd({ status: 'rejected', reason: 'x'.repeat(501) }).some((e) => /at most 500/.test(e)));
  assert.ok(upd({ status: 'approved' }, 'abc').some((e) => /invalid id/i.test(e)));
  assert.ok(upd({ status: 'approved' }, '0').some((e) => /invalid id/i.test(e)));
});

test('admin list query is validated', () => {
  const list = (query) => run(rules.adminList, {}, undefined, {}, query);
  assert.deepEqual(list({}), []);
  assert.deepEqual(list({ status: 'pending_review', page: '2', limit: '20', search: 'khan' }), []);
  assert.deepEqual(list({ status: 'all' }), []);
  assert.ok(list({ status: 'weird' }).length);
  assert.ok(list({ page: '0' }).length);
  assert.ok(list({ search: 'x'.repeat(101) }).length);
});

test('document side parameter is restricted', () => {
  assert.deepEqual(rules.sideParam({ params: { side: 'front' } }), []);
  assert.deepEqual(rules.sideParam({ params: { side: 'back' } }), []);
  for (const side of ['../../etc/passwd', 'FRONT', '', 'front.jpg']) assert.ok(rules.sideParam({ params: { side } }).length);
});
