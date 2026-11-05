const v = require('../utils/validators');
const { getPolicy } = require('../config/verification');

const body = (req) => req.body || {};
const has = (o, k) => o[k] !== undefined && o[k] !== null;

const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} '’.\-]{1,119}$/u;
const PHONE_RE = /^[0-9+()\-\s]{7,30}$/;
const DOC_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9 \-/]{3,31}$/;

const STATUSES = ['pending_review', 'approved', 'rejected', 'resubmission_required'];
const REVIEW_TARGETS = ['approved', 'rejected', 'resubmission_required'];

// Whole years between a YYYY-MM-DD date of birth and today (UTC).
function ageOn(dob, today = new Date()) {
  const [y, m, d] = dob.split('-').map(Number);
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age -= 1;
  return age;
}

// Checks the text fields shared by submit and resubmit. `partial` lets a resubmission send only what changed.
function personalProblems(b, policy, partial) {
  const e = [];
  const need = (key, test, msg) => {
    if (!has(b, key) || b[key] === '') {
      if (!partial) e.push(msg.required);
      return;
    }
    if (!test(b[key])) e.push(msg.invalid);
  };

  need('fullLegalName', (x) => typeof x === 'string' && NAME_RE.test(x.trim()), {
    required: 'Full legal name is required',
    invalid: 'Enter your full legal name exactly as it appears on your document (letters, spaces, apostrophes, hyphens)',
  });
  need('dateOfBirth', (x) => v.isDate(x), { required: 'Date of birth is required', invalid: 'Date of birth must be a valid date (YYYY-MM-DD)' });
  if (has(b, 'dateOfBirth') && v.isDate(b.dateOfBirth)) {
    const age = ageOn(b.dateOfBirth);
    if (age < 0) e.push('Date of birth cannot be in the future');
    else if (age < policy.minAge) e.push(`You must be at least ${policy.minAge} years old`);
    else if (age > 120) e.push('Date of birth is not valid');
  }
  need('country', (x) => typeof x === 'string' && policy.countries.some((c) => c.code === x.trim().toUpperCase()), {
    required: 'Country of residence is required',
    invalid: 'Choose a country of residence from the list',
  });
  if (has(b, 'phone') && b.phone !== '' && !PHONE_RE.test(b.phone)) e.push('Phone number is invalid');
  return e;
}

function documentProblems(b, policy, { partial }) {
  const e = [];
  const type = has(b, 'documentType') ? policy.documentTypes.find((t) => t.type === b.documentType) : undefined;
  if (has(b, 'documentType') && b.documentType !== '' && !type) e.push('Choose one of the accepted document types');
  if ((!has(b, 'documentType') || b.documentType === '') && !partial) e.push('Document type is required');

  if (has(b, 'documentNumber') && b.documentNumber !== '') {
    if (typeof b.documentNumber !== 'string' || !DOC_NUMBER_RE.test(b.documentNumber.trim())) {
      e.push('Document number must be 4-32 letters, numbers, spaces, hyphens or slashes');
    }
  } else if (type && type.requiresNumber && !partial) {
    e.push('Document number is required for this document type');
  }
  return e;
}

// POST /api/customer/verification: every field required (files included, back only when the type needs it).
const submit = (req) => {
  const b = body(req);
  const policy = getPolicy();
  const e = [...personalProblems(b, policy, false), ...documentProblems(b, policy, { partial: false })];
  const type = policy.documentTypes.find((t) => t.type === b.documentType);
  const files = req.verificationFiles || {};
  if (!files.front) e.push('Upload the front of your document');
  if (type && type.requiresBack && !files.back) e.push('Upload the back of your document');
  if (type && !type.requiresBack && files.back) e.push('This document type does not need a back image');
  return e;
};

// PATCH /api/customer/verification: send only what changed. Whether the result is complete (all required
// documents present for the chosen type) is checked by the service against what is already stored.
const resubmit = (req) => {
  const b = body(req);
  const policy = getPolicy();
  return [...personalProblems(b, policy, true), ...documentProblems(b, policy, { partial: true })];
};

const sideParam = (req) => (['front', 'back'].includes(req.params.side) ? [] : ['Document side must be front or back']);

const adminList = (req) => {
  const q = req.query || {};
  const e = [];
  if (q.status !== undefined && q.status !== '' && q.status !== 'all' && !STATUSES.includes(q.status)) {
    e.push(`status must be one of: all, ${STATUSES.join(', ')}`);
  }
  if (q.search !== undefined && (typeof q.search !== 'string' || q.search.length > 100)) e.push('search must be text up to 100 characters');
  ['page', 'limit'].forEach((k) => {
    if (q[k] !== undefined && !v.isIntInRange(q[k], 1, 100000)) e.push(`${k} must be a positive whole number`);
  });
  return e;
};

// PATCH /api/admin/verifications/:id/status
const statusUpdate = (req) => {
  const b = body(req);
  const e = [];
  if (!/^\d+$/.test(req.params.id) || Number(req.params.id) <= 0) e.push('Invalid id');
  if (!REVIEW_TARGETS.includes(b.status)) e.push(`status must be one of: ${REVIEW_TARGETS.join(', ')}`);
  const max = getPolicy().maxReasonLength;
  const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
  if (b.status === 'rejected' || b.status === 'resubmission_required') {
    if (!reason) e.push(b.status === 'rejected' ? 'A reason is required when rejecting' : 'Instructions are required when requesting resubmission');
  }
  if (has(b, 'reason') && typeof b.reason !== 'string') e.push('reason must be text');
  if (reason.length > max) e.push(`reason must be at most ${max} characters`);
  return e;
};

const resolveType = (policy, key) => policy.documentTypes.find((t) => t.type === key);

module.exports = { submit, resubmit, sideParam, adminList, statusUpdate, STATUSES, REVIEW_TARGETS, ageOn, resolveType };
