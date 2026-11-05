// End-to-end check of the Customer Verification module against a RUNNING API and its PostgreSQL database.
//   1. npm run db:setup     (once; applies migration 003 and seeds the demo admin)
//   2. npm run dev          (in another terminal)
//   3. npm run test:verification
// Uses the seeded admin (admin@capitalcarsharing.com / Password123!) and partner1, and registers throw-away
// customers (verif-test-*@example.com) that are deleted again at the end, together with their private files.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const config = require('../src/config/env');
const { signToken } = require('../src/utils/token');
const { getPolicy } = require('../src/config/verification');
const { query, pool } = require('../src/database/pool');

const API = (process.env.API_URL || `http://localhost:${config.port}`) + '/api';
const PASSWORD = 'Password123!';
const RUN = Date.now();
const policy = getPolicy();

const JPG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');
const NUMBER = '35202-1234567-1';

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  PASS  ${name}`); } else { failures.push(name); console.log(`  FAIL  ${name} ${detail}`); }
};
const section = (t) => console.log(`\n${t}`);

// fields: object of text fields; files: { front: {buf, type, name}, back: ... }; json: JSON body
async function call(method, url, { token, json, fields, files } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (fields || files) {
    body = new FormData();
    for (const [k, v] of Object.entries(fields || {})) if (v !== undefined) body.append(k, v);
    for (const [k, f] of Object.entries(files || {})) body.append(k, new Blob([f.buf], { type: f.type || 'image/jpeg' }), f.name || `${k}.jpg`);
  }
  const res = await fetch(API + url, { method, headers, body });
  const raw = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(raw.toString('utf8')); } catch { /* binary or empty */ }
  return { status: res.status, data, raw, headers: res.headers };
}

const img = (buf = JPG, type = 'image/jpeg', name) => ({ buf, type, name });
const valid = (over = {}) => ({
  fullLegalName: 'Aisha Khan', dateOfBirth: '1990-05-17', country: 'PK', phone: '+92 300 1234567',
  documentType: 'national_id', documentNumber: NUMBER, ...over,
});

let counter = 0;
// Customers are inserted directly (and their token signed locally) so this script does not use up the API's
// per-IP registration/login rate limit; the real login and register endpoints are still exercised in section 9.
async function newCustomer(label) {
  counter += 1;
  const email = `verif-test-${RUN}-${counter}@example.com`;
  const hash = await bcrypt.hash(PASSWORD, 4);
  const { rows } = await query(
    "INSERT INTO users (name, email, phone, password_hash, role) VALUES ($1, $2, '+92 300 0000000', $3, 'customer') RETURNING id, role",
    [`Test ${label}`, email, hash]
  );
  return { email, token: signToken(rows[0]), id: rows[0].id };
}
const login = async (role, email) => (await call('POST', `/auth/${role}/login`, { json: { email, password: PASSWORD } })).data.data.token;

const privateFile = (key) => path.join(policy.storageDir, key);
async function dbDocs(customerId) {
  return (await query(
    `SELECT d.side, d.storage_key FROM verification_documents d JOIN customer_verifications v ON v.id = d.verification_id WHERE v.customer_id = $1 ORDER BY d.side`,
    [customerId]
  )).rows;
}
const dbRecord = async (customerId) => (await query('SELECT * FROM customer_verifications WHERE customer_id = $1', [customerId])).rows[0];

async function main() {
  const admin = await login('admin', 'admin@capitalcarsharing.com');
  const partner = await login('partner', 'partner1@capitalcarsharing.com');
  const A = await newCustomer('A');
  const B = await newCustomer('B');

  // ------------------------------------------------------------------ 1. view status
  section('1. A customer can view their verification status');
  let r = await call('GET', '/customer/verification', { token: A.token });
  check('GET returns 200 and not_submitted for a new customer', r.status === 200 && r.data.data.verification.status === 'not_submitted', JSON.stringify(r.data));
  check('a new customer may submit; booking is not allowed', r.data.data.verification.canSubmit === true && r.data.data.verification.bookingEligible === false);
  check('profile prefill (name, email, phone) is provided', r.data.data.verification.profile.phone === '+92 300 0000000' && r.data.data.verification.profile.email === A.email);
  check('policy lists document types, countries, limits', r.data.data.policy.documentTypes.length >= 1 && r.data.data.policy.countries.length > 100 && r.data.data.policy.maxFileSizeMb > 0);
  check('policy does not reveal the storage folder', !JSON.stringify(r.data).includes(policy.storageDir));

  // ------------------------------------------------------------------ 4. unauthenticated
  section('4. Unauthenticated users cannot submit or read');
  check('POST without a token -> 401', (await call('POST', '/customer/verification', { fields: valid(), files: { front: img(), back: img() } })).status === 401);
  check('GET without a token -> 401', (await call('GET', '/customer/verification')).status === 401);
  check('GET document without a token -> 401', (await call('GET', '/customer/verification/documents/front')).status === 401);
  check('admin list without a token -> 401', (await call('GET', '/admin/verifications')).status === 401);
  check('a partner token cannot use the customer endpoint -> 403', (await call('GET', '/customer/verification', { token: partner })).status === 403);
  check('an admin token cannot use the customer endpoint -> 403', (await call('GET', '/customer/verification', { token: admin })).status === 403);

  // ------------------------------------------------------------------ 3. invalid uploads
  section('3. Invalid files and invalid data are rejected (nothing is stored)');
  const badIds = [];
  const bad = async (name, opts, want) => {
    const C = await newCustomer('bad'); // a fresh customer per case keeps every case clear of the rate limit
    badIds.push(C.id);
    const res = await call('POST', '/customer/verification', { token: C.token, ...opts });
    check(`${name} -> ${want}`, res.status === want, `got ${res.status} ${res.data && res.data.message}`);
  };
  await bad('GIF image', { fields: valid(), files: { front: img(GIF, 'image/gif', 'a.gif'), back: img() } }, 400);
  await bad('text file declared as image/jpeg (bytes checked, not the label)', { fields: valid(), files: { front: img(Buffer.from('hello, not an image at all'), 'image/jpeg', 'id.jpg'), back: img() } }, 400);
  await bad('HTML/script declared as image/png', { fields: valid(), files: { front: img(Buffer.from('<html><script>alert(1)</script></html>'), 'image/png', 'id.png'), back: img() } }, 400);
  await bad('PHP file declared as application/pdf', { fields: valid(), files: { front: img(Buffer.from('<?php system($_GET[1]); ?>'), 'application/pdf', 'id.pdf'), back: img() } }, 400);
  await bad('declared type text/plain', { fields: valid(), files: { front: img(JPG, 'text/plain', 'id.txt'), back: img() } }, 400);
  await bad('empty file', { fields: valid(), files: { front: img(Buffer.alloc(0)), back: img() } }, 400);
  await bad(`file over ${policy.maxFileSizeMb} MB`, { fields: valid(), files: { front: img(Buffer.concat([JPG, Buffer.alloc(policy.maxFileSizeBytes)])), back: img() } }, 413);
  await bad('unexpected file field', { fields: valid(), files: { front: img(), back: img(), selfie: img() } }, 400);
  await bad('missing front image', { fields: valid(), files: { back: img() } }, 422);
  await bad('missing back image for a national id', { fields: valid(), files: { front: img() } }, 422);
  await bad('under-age date of birth', { fields: valid({ dateOfBirth: new Date().toISOString().slice(0, 10) }), files: { front: img(), back: img() } }, 422);
  await bad('invalid country', { fields: valid({ country: 'XX' }), files: { front: img(), back: img() } }, 422);
  await bad('unaccepted document type', { fields: valid({ documentType: 'library_card' }), files: { front: img(), back: img() } }, 422);
  await bad('missing document number', { fields: valid({ documentNumber: '' }), files: { front: img(), back: img() } }, 422);
  await bad('script in the legal name', { fields: valid({ fullLegalName: '<script>alert(1)</script>' }), files: { front: img(), back: img() } }, 422);
  const stored = (await query('SELECT COUNT(*) AS n FROM customer_verifications WHERE customer_id = ANY($1)', [badIds])).rows[0].n;
  const docRows = (await query('SELECT COUNT(*) AS n FROM verification_documents d JOIN customer_verifications v ON v.id = d.verification_id WHERE v.customer_id = ANY($1)', [badIds])).rows[0].n;
  check('nothing was stored in the database for the rejected attempts', stored === 0 && docRows === 0);
  const leftovers = badIds.filter((id) => fs.existsSync(path.join(policy.storageDir, 'verifications', String(id))));
  check('no file was left on disk for the rejected attempts', leftovers.length === 0, leftovers.join(','));

  // ------------------------------------------------------------------ 2. valid submission
  section('2. A customer can submit valid information and documents');
  r = await call('POST', '/customer/verification', {
    token: A.token,
    // status / customerId / reviewedBy in the body must be ignored
    fields: { ...valid(), status: 'approved', customerId: String(B.id), reviewedBy: '1' },
    files: { front: img(JPG, 'image/jpeg', '../../evil.jpg'), back: img(PNG, 'image/png', 'back.png') },
  });
  check('POST returns 201 pending_review', r.status === 201 && r.data.data.verification.status === 'pending_review', JSON.stringify(r.data));
  check('a status injected in the request is ignored (not approved)', r.data.data.verification.status === 'pending_review');
  const v = r.data.data.verification;
  check('document number is masked in the response', v.details.documentNumberMasked === '••••1231' && !JSON.stringify(r.data).includes('35202'), JSON.stringify(v.details));
  check('response has no storage key / path / url', !/storageKey|storage_key|private-uploads|verifications\/\d|\.jpg"|\.png"/.test(JSON.stringify(r.data)));
  check('not yet bookable (pending review)', v.bookingEligible === false && v.canSubmit === false);
  const rec = await dbRecord(A.id);
  check('the record belongs to the signed-in customer, not the injected customerId', rec && rec.customerId === A.id && !(await dbRecord(B.id)));
  check('document number is encrypted in the database', rec.documentNumberEncrypted && !rec.documentNumberEncrypted.includes('35202') && rec.documentNumberLast4 === '1231');
  const docs = await dbDocs(A.id);
  check('two documents are stored as private references', docs.length === 2 && docs.every((d) => /^verifications\/\d+\/[0-9a-f-]{36}\.(jpg|png)$/.test(d.storageKey)), JSON.stringify(docs));
  check('the client file name was not used for storage', docs.every((d) => !/evil|back\.png/.test(d.storageKey)));
  check('files exist in the PRIVATE folder with owner-only permissions', docs.every((d) => fs.existsSync(privateFile(d.storageKey)) && (fs.statSync(privateFile(d.storageKey)).mode & 0o077) === 0));
  check('private folder is outside the public upload folder', !policy.storageDir.startsWith(config.upload.dir + path.sep) && policy.storageDir !== config.upload.dir);
  const pub = await fetch(`${config.upload.publicBaseUrl}/uploads/${docs[0].storageKey}`);
  check('the document is NOT reachable through the public /uploads URL', pub.status === 404);
  const pub2 = await fetch(`${config.upload.publicBaseUrl}/private-uploads/${docs[0].storageKey}`);
  check('nor under any guessed static path', pub2.status === 404);
  r = await call('GET', '/customer/verification', { token: A.token });
  check('GET now shows pending_review with the submitted details', r.data.data.verification.status === 'pending_review' && r.data.data.verification.details.fullLegalName === 'Aisha Khan');
  r = await call('POST', '/customer/verification', { token: A.token, fields: valid(), files: { front: img(), back: img() } });
  check('submitting a second time -> 409', r.status === 409, JSON.stringify(r.data));
  check('a failed duplicate submission left no extra file on disk', fs.readdirSync(path.join(policy.storageDir, 'verifications', String(A.id))).length === 2);
  r = await call('PATCH', '/customer/verification', { token: A.token, json: { fullLegalName: 'Changed Name' } });
  check('the customer cannot edit while it is under review -> 409', r.status === 409);

  // PDF + passport variant (no back image)
  const P = await newCustomer('P');
  r = await call('POST', '/customer/verification', { token: P.token, fields: valid({ documentType: 'passport', documentNumber: 'AB1234567' }), files: { front: img(PDF, 'application/pdf', 'passport.pdf') } });
  check('passport with a PDF and no back image -> 201', r.status === 201, JSON.stringify(r.data));
  check('the PDF is stored with its real type', (await query('SELECT mime_type FROM verification_documents WHERE verification_id = $1', [(await dbRecord(P.id)).id])).rows[0].mimeType === 'application/pdf');

  // ------------------------------------------------------------------ 5. isolation / IDOR
  section('5. A customer cannot reach another customer\'s record or documents');
  r = await call('GET', '/customer/verification', { token: B.token });
  check('B sees their own (empty) record, not A\'s', r.data.data.verification.status === 'not_submitted' && r.data.data.verification.details === null);
  r = await call('GET', `/customer/verification?customerId=${A.id}`, { token: B.token });
  check('a customerId query parameter changes nothing', r.data.data.verification.status === 'not_submitted');
  r = await call('GET', '/customer/verification/documents/front', { token: B.token });
  check('B cannot read a document (B has none; A\'s is never reachable) -> 404', r.status === 404);
  r = await call('GET', `/admin/verifications/${rec.id}`, { token: B.token });
  check('B cannot open the admin detail endpoint -> 403', r.status === 403);
  r = await call('GET', `/admin/verifications/${rec.id}/documents/front`, { token: B.token });
  check('B cannot fetch A\'s document through the admin endpoint -> 403', r.status === 403);
  r = await call('GET', `/admin/verifications/${rec.id}/documents/front`, { token: partner });
  check('a partner cannot fetch it either -> 403', r.status === 403);
  r = await call('PATCH', '/customer/verification', { token: B.token, json: { fullLegalName: 'Hijack' } });
  check('B cannot update anything (B has no record) -> 404, and A is untouched', r.status === 404 && (await dbRecord(A.id)).fullLegalName === 'Aisha Khan');
  r = await call('GET', '/customer/verification/documents/..%2F..%2Fetc%2Fpasswd', { token: A.token });
  check('a path-traversal "side" is refused -> 422', r.status === 422 || r.status === 404);
  r = await call('GET', '/customer/verification/documents/front', { token: A.token });
  check('the owner can read their own document (200, correct bytes)', r.status === 200 && r.raw.equals(JPG));
  check('document response is private: no-store, nosniff, sandboxed', /no-store/.test(r.headers.get('cache-control')) && r.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(r.headers.get('content-security-policy')));

  // ------------------------------------------------------------------ 6. self-approval
  section('6. A customer cannot approve their own verification');
  for (const tok of [A.token, B.token]) {
    r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: tok, json: { status: 'approved' } });
    check('customer calling the admin approve endpoint -> 403', r.status === 403);
  }
  r = await call('PATCH', '/customer/verification', { token: A.token, json: { status: 'approved' } });
  check('customer PATCH with status=approved while pending -> 409, still pending', r.status === 409 && (await dbRecord(A.id)).status === 'pending_review');
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: partner, json: { status: 'approved' } });
  check('a partner cannot approve -> 403', r.status === 403);
  check('status is still pending_review after every attempt', (await dbRecord(A.id)).status === 'pending_review');

  // ------------------------------------------------------------------ 7. admin review
  section('7. Authorized admins can review and update status');
  r = await call('GET', '/admin/verifications?status=pending_review', { token: admin });
  check('admin list filtered by pending_review contains A', r.status === 200 && r.data.data.verifications.some((x) => x.id === rec.id) && r.data.data.verifications.every((x) => x.status === 'pending_review'));
  check('list gives status counts and paging meta', r.data.data.counts.pending_review >= 2 && r.data.meta && r.data.meta.page === 1);
  r = await call('GET', `/admin/verifications?search=${encodeURIComponent(A.email)}`, { token: admin });
  check('admin search by email finds A', r.data.data.verifications.length === 1 && r.data.data.verifications[0].customerId === A.id);
  check('admin list does not expose the document number or storage keys', !/documentNumber|storage/i.test(JSON.stringify(r.data)));
  r = await call('GET', '/admin/verifications?status=bogus', { token: admin });
  check('invalid status filter -> 422', r.status === 422);
  r = await call('GET', `/admin/verifications/${rec.id}`, { token: admin });
  const d = r.data.data.verification;
  check('admin detail shows the submitted data, full document number, timestamps, history', d.details.fullLegalName === 'Aisha Khan' && d.details.documentNumber === NUMBER && d.submittedAt && d.history.some((h) => h.event === 'submitted'));
  check('admin detail lists documents without storage keys', d.documents.length === 2 && !/storage/i.test(JSON.stringify(d)));
  check('admin is offered approve / reject / resubmission', d.allowedActions.length === 3);
  r = await call('GET', `/admin/verifications/${rec.id}/documents/back`, { token: admin });
  check('admin can open a document through the secure endpoint (bytes match)', r.status === 200 && r.raw.equals(PNG) && r.headers.get('content-type') === 'image/png');
  check('every admin document view is recorded in the audit trail', (await query("SELECT COUNT(*) AS n FROM verification_events WHERE verification_id = $1 AND event = 'document_viewed'", [rec.id])).rows[0].n >= 1);
  r = await call('GET', '/admin/verifications/999999', { token: admin });
  check('unknown id -> 404', r.status === 404);
  r = await call('GET', '/admin/verifications/abc', { token: admin });
  check('malformed id -> 422', r.status === 422);

  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'rejected' } });
  check('rejecting without a reason -> 422', r.status === 422);
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'resubmission_required' } });
  check('requesting resubmission without instructions -> 422', r.status === 422);
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'pending_review' } });
  check('an admin cannot set pending_review by hand -> 422', r.status === 422);
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'rejected', reason: 'The photo of the front is too blurry to read.' } });
  check('admin rejects with a reason -> 200 rejected', r.status === 200 && r.data.data.verification.status === 'rejected' && r.data.data.verification.reviewedBy, JSON.stringify(r.data));
  check('reviewer and review time are recorded', (await dbRecord(A.id)).reviewedBy && (await dbRecord(A.id)).reviewedAt);
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'approved' } });
  check('a rejected record cannot be approved directly -> 409 (the customer must resubmit)', r.status === 409);

  // ------------------------------------------------------------------ 8. resubmission
  section('8. Rejected customers can correct and resubmit');
  r = await call('GET', '/customer/verification', { token: A.token });
  const rej = r.data.data.verification;
  check('the customer sees rejected + the admin\'s reason, and may resubmit', rej.status === 'rejected' && /blurry/.test(rej.reason) && rej.canSubmit === true && rej.bookingEligible === false);
  const oldFront = (await dbDocs(A.id)).find((x) => x.side === 'front').storageKey;
  r = await call('PATCH', '/customer/verification', { token: A.token, fields: { fullLegalName: 'Aisha Khan-Malik' }, files: { front: img(PNG, 'image/png', 'clear.png') } });
  check('resubmitting with a corrected name and a new front image -> 200 pending_review', r.status === 200 && r.data.data.verification.status === 'pending_review' && r.data.data.verification.details.fullLegalName === 'Aisha Khan-Malik', JSON.stringify(r.data));
  check('the old reason is cleared for the customer', r.data.data.verification.reason === null);
  check('unchanged fields and the existing back image were kept', r.data.data.verification.documents.length === 2 && r.data.data.verification.details.documentNumberMasked === '••••1231');
  check('the replaced front file was deleted from private storage', !fs.existsSync(privateFile(oldFront)));
  check('the new front file is stored', fs.existsSync(privateFile((await dbDocs(A.id)).find((x) => x.side === 'front').storageKey)));
  r = await call('GET', `/admin/verifications/${rec.id}`, { token: admin });
  const hist = r.data.data.verification.history.map((h) => h.event);
  check('the audit trail kept the whole story (submitted, rejected, resubmitted)', ['submitted', 'rejected', 'resubmitted'].every((e) => hist.includes(e)), hist.join(','));
  check('the rejection reason is preserved in the history', r.data.data.verification.history.some((h) => h.event === 'rejected' && /blurry/.test(h.reason)));

  // a second round through "resubmission_required"
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'resubmission_required', reason: 'Please also upload the back of the card.' } });
  check('admin requests resubmission with instructions -> 200', r.status === 200 && r.data.data.verification.status === 'resubmission_required');
  r = await call('PATCH', '/customer/verification', { token: A.token, fields: { phone: '+92 321 7654321' } });
  check('customer resubmits again (phone only) -> pending_review', r.status === 200 && r.data.data.verification.status === 'pending_review' && r.data.data.verification.details.phone === '+92 321 7654321');

  // changing to a passport removes the back image
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'rejected', reason: 'Use your passport instead.' } });
  r = await call('PATCH', '/customer/verification', { token: A.token, fields: { documentType: 'passport' } });
  check('switching to a passport without a new number -> 422', r.status === 422);
  r = await call('PATCH', '/customer/verification', { token: A.token, fields: { documentType: 'passport', documentNumber: 'AB7654321' } });
  check('switching to a passport with its number -> 200, back image dropped', r.status === 200 && r.data.data.verification.documents.length === 1 && r.data.data.verification.documents[0].side === 'front', JSON.stringify(r.data));
  check('the unneeded back file is gone from disk', (await dbDocs(A.id)).length === 1 && fs.readdirSync(path.join(policy.storageDir, 'verifications', String(A.id))).length === 1);

  // ------------------------------------------------------------------ approval + 10. booking eligibility
  section('10. The backend exposes the right status for the booking eligibility check');
  const verificationService = require('../src/services/verification.service');
  const { requireVerifiedCustomer } = require('../src/middleware/requireVerifiedCustomer');
  const gate = (user) => new Promise((resolve) => requireVerifiedCustomer({ user }, {}, (err) => resolve(err || 'next')));
  check('not submitted -> not eligible', (await verificationService.getStatus(B.id)) === 'not_submitted' && !(await verificationService.isVerified(B.id)));
  check('booking gate refuses a not-submitted customer with 403', (await gate({ id: B.id, role: 'customer' })).statusCode === 403);
  check('pending_review -> not eligible; gate says 403', (await verificationService.getStatus(A.id)) === 'pending_review' && (await gate({ id: A.id, role: 'customer' })).statusCode === 403);
  check('the gate refuses a partner or admin account', (await gate({ id: 1, role: 'partner' })).statusCode === 403 && (await gate({ id: 1, role: 'admin' })).statusCode === 403);
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'rejected', reason: 'Test' } });
  check('rejected -> not eligible', (await verificationService.getStatus(A.id)) === 'rejected' && (await gate({ id: A.id, role: 'customer' })).statusCode === 403);
  r = await call('PATCH', '/customer/verification', { token: A.token, fields: { fullLegalName: 'Aisha Khan' } });
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'approved', reason: 'ignored on approval' } });
  check('admin approves -> 200 approved', r.status === 200 && r.data.data.verification.status === 'approved' && r.data.data.verification.reason === null, JSON.stringify(r.data));
  check('approved -> eligible; the gate lets the request through', (await verificationService.getStatus(A.id)) === 'approved' && (await verificationService.isVerified(A.id)) && (await gate({ id: A.id, role: 'customer' })) === 'next');
  r = await call('GET', '/customer/verification', { token: A.token });
  check('the customer API reports bookingEligible=true and no further submission', r.data.data.verification.bookingEligible === true && r.data.data.verification.canSubmit === false);
  r = await call('PATCH', '/customer/verification', { token: A.token, json: { fullLegalName: 'Sneaky Edit' } });
  check('an approved customer cannot alter the approved record -> 409', r.status === 409 && (await dbRecord(A.id)).fullLegalName === 'Aisha Khan');
  r = await call('POST', '/customer/verification', { token: A.token, fields: valid(), files: { front: img(), back: img() } });
  check('nor create a new submission over it -> 409', r.status === 409);
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'approved' } });
  check('approving twice -> 409', r.status === 409);
  r = await call('PATCH', `/admin/verifications/${rec.id}/status`, { token: admin, json: { status: 'rejected', reason: 'Approval revoked after a fraud check.' } });
  check('an admin may revoke an approval -> eligibility is lost immediately', r.status === 200 && !(await verificationService.isVerified(A.id)));

  // ------------------------------------------------------------------ notifications
  section('Notifications are recorded honestly');
  await new Promise((res) => setTimeout(res, 800)); // emails are sent after the response
  const ev = (await query("SELECT customer_notified FROM verification_events WHERE verification_id = $1 AND event IN ('submitted','resubmitted','approved','rejected','resubmission_requested')", [rec.id])).rows;
  if (config.smtp.host) {
    check('SMTP is configured: every event has a recorded outcome (true = accepted by the SMTP server)', ev.every((e) => e.customerNotified !== null));
  } else {
    check('SMTP is NOT configured: no event claims the customer was notified', ev.length > 0 && ev.every((e) => e.customerNotified === false));
  }

  // ------------------------------------------------------------------ retention
  section('Retention policy');
  const approvedAgain = (await query("SELECT id FROM customer_verifications WHERE customer_id = $1", [P.id])).rows[0].id;
  await call('PATCH', `/admin/verifications/${approvedAgain}/status`, { token: admin, json: { status: 'approved' } });
  const pdfKey = (await dbDocs(P.id))[0].storageKey;
  if (policy.retentionDays > 0) {
    await query("UPDATE customer_verifications SET reviewed_at = NOW() - make_interval(days => $2) WHERE id = $1", [approvedAgain, policy.retentionDays + 1]);
    const out = await verificationService.purgeExpiredDocuments();
    check('purge deletes the files of decisions older than the retention period', out.purged >= 1 && !fs.existsSync(privateFile(pdfKey)) && (await dbDocs(P.id)).length === 0);
    r = await call('GET', '/customer/verification', { token: P.token });
    check('the customer sees documentsPurged and still sees their approved status', r.data.data.verification.documentsPurged === true && r.data.data.verification.status === 'approved');
    r = await call('GET', `/admin/verifications/${approvedAgain}/documents/front`, { token: admin });
    check('a purged document is gone (404)', r.status === 404);
    check('the audit trail records the purge', (await query("SELECT COUNT(*) AS n FROM verification_events WHERE verification_id = $1 AND event = 'documents_purged'", [approvedAgain])).rows[0].n === 1);
  } else {
    console.log('  SKIP  retention purge (VERIFICATION_RETENTION_DAYS=0 disables it)');
  }

  // ------------------------------------------------------------------ 9. existing features
  section('9. Existing features still work');
  r = await call('POST', '/auth/customer/login', { json: { email: A.email, password: PASSWORD } });
  check('customer login', r.status === 200 && r.data.data.token);
  r = await call('GET', '/auth/me', { token: A.token });
  check('GET /auth/me', r.status === 200 && r.data.data.user.email === A.email);
  r = await call('GET', '/customers/me', { token: A.token });
  check('GET /customers/me', r.status === 200 && r.data.data.customer.email === A.email);
  r = await call('PUT', '/customers/me', { token: A.token, json: { name: 'Aisha K', phone: '+92 300 1111111' } });
  check('PUT /customers/me (profile update)', r.status === 200 && r.data.data.customer.name === 'Aisha K');
  r = await call('GET', '/customers/me/reservations', { token: A.token });
  check('GET /customers/me/reservations', r.status === 200 && Array.isArray(r.data.data.reservations));
  check('partner login', !!partner);
  r = await call('GET', '/admin/customers', { token: admin });
  check('admin customers list', r.status === 200 && Array.isArray(r.data.data.customers));
  r = await call('GET', '/admin/dashboard', { token: admin });
  check('admin dashboard', r.status === 200);
  r = await call('GET', '/cars');
  check('public car search', r.status === 200);
  r = await call('GET', '/health');
  check('health check', r.status === 200);

  // ------------------------------------------------------------------ rate limit
  section('Rate limiting');
  const R = await newCustomer('R');
  let last;
  const limit = parseInt(process.env.VERIFICATION_SUBMIT_LIMIT || '20', 10);
  for (let i = 0; i < limit + 1; i += 1) last = await call('POST', '/customer/verification', { token: R.token, fields: valid() });
  check(`request ${limit + 1} within 15 minutes -> 429`, last.status === 429);
  check('the limit is per customer: another customer is unaffected', (await call('GET', '/customer/verification', { token: B.token })).status === 200 && (await call('POST', '/customer/verification', { token: B.token, fields: valid() })).status === 422);
}

async function cleanup() {
  try {
    const { rows } = await query(
      `SELECT d.storage_key FROM verification_documents d
         JOIN customer_verifications v ON v.id = d.verification_id JOIN users u ON u.id = v.customer_id
        WHERE u.email LIKE 'verif-test-%@example.com'`
    );
    for (const { storageKey } of rows) fs.rmSync(privateFile(storageKey), { force: true });
    const users = await query("DELETE FROM users WHERE email LIKE 'verif-test-%@example.com' RETURNING id");
    for (const { id } of users.rows) fs.rmSync(path.join(policy.storageDir, 'verifications', String(id)), { recursive: true, force: true });
    console.log(`\nCleaned up ${users.rowCount} test customer(s) and their files.`);
  } catch (err) {
    console.log('\nCleanup problem:', err.message);
  }
}

main()
  .catch((err) => { failures.push(`unexpected error: ${err.message}`); console.error(err); })
  .finally(async () => {
    await cleanup();
    await pool.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) { failures.forEach((f) => console.log(`  - ${f}`)); process.exit(1); }
  });
