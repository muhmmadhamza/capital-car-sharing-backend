const crypto = require('crypto');
const { query, withTransaction } = require('../database/pool');
const { getPolicy } = require('../config/verification');
const store = require('./storage/privateStore');
const { encrypt, decrypt } = require('../utils/fieldCrypto');
const { sendVerificationEmail } = require('./email.service');
const { notFound, conflict, unprocessable } = require('../utils/errors');

// Status vocabulary. 'not_submitted' is virtual: it is what a customer without a record has.
const NOT_SUBMITTED = 'not_submitted';
const RESUBMITTABLE = ['rejected', 'resubmission_required'];

// What an admin may do next. Anything not listed is refused with 409, so the rules live on the server.
//   pending_review -> approved | rejected | resubmission_required
//   approved       -> rejected | resubmission_required      (revoking an earlier approval)
const ADMIN_TRANSITIONS = {
  pending_review: ['approved', 'rejected', 'resubmission_required'],
  approved: ['rejected', 'resubmission_required'],
};
const EVENT_FOR_STATUS = { approved: 'approved', rejected: 'rejected', resubmission_required: 'resubmission_requested' };

// ---------------------------------------------------------------------------------------------- helpers

const clean = (s) => String(s).trim().replace(/\s+/g, ' ');
const lastFour = (number) => number.replace(/[\s\-/]/g, '').slice(-4).toUpperCase();

async function saveFiles(customerId, files) {
  const saved = [];
  try {
    for (const [side, file] of Object.entries(files || {})) {
      const key = `verifications/${customerId}/${crypto.randomUUID()}.${file.ext}`;
      await store.save({ key, buffer: file.buffer });
      saved.push({ side, key, mime: file.mime, size: file.size, sha256: file.sha256 });
    }
  } catch (err) {
    await removeKeys(saved.map((f) => f.key));
    throw err;
  }
  return saved;
}

const removeKeys = (keys) => Promise.all(keys.map((k) => store.remove(k)));

// Sends the email after the database change is committed. Never throws, never blocks the response, and records
// honestly whether the SMTP server accepted it (it does not prove the customer's inbox received it).
function notify({ to, name, kind, reason, eventId }) {
  sendVerificationEmail({ to, name, kind, reason })
    .then((ok) => query('UPDATE verification_events SET customer_notified = $2 WHERE id = $1', [eventId, ok]))
    .catch(() => undefined);
}

const insertEvent = async (q, { verificationId, actor, event, fromStatus, toStatus, reason }) => {
  const { rows } = await q(
    `INSERT INTO verification_events (verification_id, actor_id, actor_role, event, from_status, to_status, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [verificationId, actor ? actor.id : null, actor ? actor.role : null, event, fromStatus || null, toStatus || null, reason || null]
  );
  return rows[0].id;
};

// ------------------------------------------------------------------------------------ customer: read

// Everything here is safe for the customer's own eyes: no storage keys, no full document number.
function customerView(row, docs, user) {
  const policy = getPolicy();
  const status = row ? row.status : NOT_SUBMITTED;
  return {
    status,
    canSubmit: !row || RESUBMITTABLE.includes(row.status),
    bookingEligible: status === 'approved',
    submittedAt: row ? row.submittedAt : null,
    reviewedAt: row ? row.reviewedAt : null,
    // The admin's customer-facing message. Only meaningful (and only sent) for rejected / resubmission_required.
    reason: row && RESUBMITTABLE.includes(row.status) ? row.reviewReason : null,
    details: row
      ? {
          fullLegalName: row.fullLegalName,
          dateOfBirth: row.dateOfBirth,
          country: row.country,
          phone: row.phone,
          documentType: row.documentType,
          documentNumberMasked: row.documentNumberLast4 ? `••••${row.documentNumberLast4}` : null,
        }
      : null,
    documents: docs.map((d) => ({ side: d.side, mimeType: d.mimeType, sizeBytes: d.sizeBytes, uploadedAt: d.createdAt })),
    documentsPurged: Boolean(row && row.documentsPurgedAt),
    // Prefill values from the account, so the form never asks for what we already hold.
    profile: { name: user.name, email: user.email, phone: user.phone || null },
    maxReasonLength: policy.maxReasonLength,
  };
}

async function loadByCustomer(q, customerId, { lock = false } = {}) {
  const { rows } = await q(`SELECT * FROM customer_verifications WHERE customer_id = $1${lock ? ' FOR UPDATE' : ''}`, [customerId]);
  return rows[0] || null;
}

async function getForCustomer(user) {
  const row = await loadByCustomer(query, user.id);
  const docs = row ? (await query('SELECT side, mime_type, size_bytes, created_at FROM verification_documents WHERE verification_id = $1 ORDER BY side', [row.id])).rows : [];
  return customerView(row, docs, user);
}

/** The status the booking module checks: 'approved' | 'pending_review' | 'rejected' | 'resubmission_required' | 'not_submitted'. */
async function getStatus(customerId) {
  const { rows } = await query('SELECT status FROM customer_verifications WHERE customer_id = $1', [customerId]);
  return rows[0] ? rows[0].status : NOT_SUBMITTED;
}

const isVerified = async (customerId) => (await getStatus(customerId)) === 'approved';

// ---------------------------------------------------------------------------------- customer: submit

function normalizeFields(fields, user, fallback = {}) {
  const phone = (fields.phone && clean(fields.phone)) || fallback.phone || user.phone || null;
  if (!phone) throw unprocessable('Phone number is required', ['Phone number is required']);
  return {
    fullLegalName: fields.fullLegalName ? clean(fields.fullLegalName) : fallback.fullLegalName,
    dateOfBirth: fields.dateOfBirth || fallback.dateOfBirth,
    country: fields.country ? clean(fields.country).toUpperCase() : fallback.country,
    phone,
  };
}

async function submit(user, fields, files) {
  const policy = getPolicy();
  const type = policy.documentTypes.find((t) => t.type === fields.documentType);
  const base = normalizeFields(fields, user);
  const number = fields.documentNumber ? clean(fields.documentNumber).toUpperCase() : null;

  const saved = await saveFiles(user.id, files);
  let result;
  try {
    result = await withTransaction(async (q) => {
      const { rows } = await q(
        `INSERT INTO customer_verifications
           (customer_id, status, full_legal_name, date_of_birth, country, phone,
            document_type, document_number_encrypted, document_number_last4)
         VALUES ($1, 'pending_review', $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (customer_id) DO NOTHING
         RETURNING id`,
        [user.id, base.fullLegalName, base.dateOfBirth, base.country, base.phone, type.type, number ? encrypt(number) : null, number ? lastFour(number) : null]
      );
      if (!rows[0]) throw conflict('You have already submitted your verification. Check its status, or update it if changes were requested.');
      const verificationId = rows[0].id;
      for (const f of saved) {
        await q(
          'INSERT INTO verification_documents (verification_id, side, storage_key, mime_type, size_bytes, sha256) VALUES ($1, $2, $3, $4, $5, $6)',
          [verificationId, f.side, f.key, f.mime, f.size, f.sha256]
        );
      }
      const eventId = await insertEvent(q, { verificationId, actor: user, event: 'submitted', toStatus: 'pending_review' });
      return { eventId };
    });
  } catch (err) {
    await removeKeys(saved.map((f) => f.key)); // nothing was committed, so nothing may stay on disk
    throw err;
  }
  notify({ to: user.email, name: user.name, kind: 'received', eventId: result.eventId });
  return getForCustomer(user);
}

// ------------------------------------------------------------------------------- customer: resubmit

// Only allowed while the record is rejected / resubmission_required. Fields and files that are not sent keep their
// current value. Replaced files are deleted from private storage right after the change is committed.
async function resubmit(user, fields, files) {
  const policy = getPolicy();
  const saved = await saveFiles(user.id, files);
  let outcome;
  try {
    outcome = await withTransaction(async (q) => {
      const cur = await loadByCustomer(q, user.id, { lock: true });
      if (!cur) throw notFound('There is no verification to update yet. Submit your documents first.');
      if (!RESUBMITTABLE.includes(cur.status)) {
        throw conflict(
          cur.status === 'approved'
            ? 'Your verification is already approved.'
            : 'Your verification is being reviewed and cannot be changed right now.'
        );
      }

      const typeKey = fields.documentType || cur.documentType;
      const type = policy.documentTypes.find((t) => t.type === typeKey);
      if (!type) throw unprocessable('Choose one of the accepted document types', ['Choose one of the accepted document types']);
      const typeChanged = typeKey !== cur.documentType;

      const existing = (await q('SELECT id, side, storage_key FROM verification_documents WHERE verification_id = $1', [cur.id])).rows;
      const incoming = Object.fromEntries(saved.map((f) => [f.side, f]));
      const has = (side) => Boolean(incoming[side] || existing.some((d) => d.side === side));
      if (!has('front')) throw unprocessable('Upload the front of your document', ['Upload the front of your document']);
      if (type.requiresBack && !has('back')) throw unprocessable('Upload the back of your document', ['Upload the back of your document']);
      if (!type.requiresBack && incoming.back) throw unprocessable('This document type does not need a back image', ['This document type does not need a back image']);

      // Document number: keep the stored one unless the customer sent a new one or switched document type.
      let encrypted = cur.documentNumberEncrypted;
      let last4 = cur.documentNumberLast4;
      if (fields.documentNumber) {
        const number = clean(fields.documentNumber).toUpperCase();
        encrypted = encrypt(number);
        last4 = lastFour(number);
      } else if (typeChanged) {
        if (type.requiresNumber) throw unprocessable('Document number is required for this document type', ['Document number is required for this document type']);
        encrypted = null;
        last4 = null;
      } else if (type.requiresNumber && !encrypted) {
        throw unprocessable('Document number is required for this document type', ['Document number is required for this document type']);
      }

      const merged = normalizeFields(fields, user, {
        fullLegalName: cur.fullLegalName,
        dateOfBirth: cur.dateOfBirth,
        country: cur.country,
        phone: cur.phone,
      });

      // Files to delete after commit: anything replaced, and a back image the new type does not use.
      const replaced = existing.filter((d) => incoming[d.side] || (!type.requiresBack && d.side === 'back'));
      for (const d of replaced) await q('DELETE FROM verification_documents WHERE id = $1', [d.id]);
      for (const f of saved) {
        await q(
          'INSERT INTO verification_documents (verification_id, side, storage_key, mime_type, size_bytes, sha256) VALUES ($1, $2, $3, $4, $5, $6)',
          [cur.id, f.side, f.key, f.mime, f.size, f.sha256]
        );
      }

      await q(
        `UPDATE customer_verifications SET
           status = 'pending_review',
           full_legal_name = $2, date_of_birth = $3, country = $4, phone = $5,
           document_type = $6, document_number_encrypted = $7, document_number_last4 = $8,
           review_reason = NULL, reviewed_by = NULL, reviewed_at = NULL,
           submitted_at = NOW(), documents_purged_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [cur.id, merged.fullLegalName, merged.dateOfBirth, merged.country, merged.phone, type.type, encrypted, last4]
      );
      const eventId = await insertEvent(q, {
        verificationId: cur.id,
        actor: user,
        event: 'resubmitted',
        fromStatus: cur.status,
        toStatus: 'pending_review',
      });
      return { eventId, replacedKeys: replaced.map((d) => d.storageKey) };
    });
  } catch (err) {
    await removeKeys(saved.map((f) => f.key));
    throw err;
  }
  await removeKeys(outcome.replacedKeys); // best effort; a leftover file is not referenced by anything
  notify({ to: user.email, name: user.name, kind: 'received', eventId: outcome.eventId });
  return getForCustomer(user);
}

// ----------------------------------------------------------------------------------------- documents

// Returns { stream, size, mimeType } or throws 404. The storage key comes from the database, never from the request.
async function readDocument(row) {
  if (!row) throw notFound('Document not found');
  try {
    const { stream, size } = await store.read(row.storageKey);
    return { stream, size, mimeType: row.mimeType, side: row.side };
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound('Document is no longer available');
    throw err;
  }
}

/** The signed-in customer's OWN document. The customer id comes from the verified token. */
async function openOwnDocument(customerId, side) {
  const { rows } = await query(
    `SELECT d.side, d.storage_key, d.mime_type
       FROM verification_documents d JOIN customer_verifications v ON v.id = d.verification_id
      WHERE v.customer_id = $1 AND d.side = $2`,
    [customerId, side]
  );
  return readDocument(rows[0]);
}

/** Any customer's document, for an admin. Every view is written to the audit trail. */
async function openDocumentForAdmin(admin, verificationId, side) {
  const { rows } = await query('SELECT side, storage_key, mime_type FROM verification_documents WHERE verification_id = $1 AND side = $2', [verificationId, side]);
  const doc = await readDocument(rows[0]);
  await insertEvent(query, { verificationId, actor: admin, event: 'document_viewed', reason: side });
  return doc;
}

// ------------------------------------------------------------------------------------------- admin

const paging = ({ page, limit }) => {
  const pg = Math.max(parseInt(page, 10) || 1, 1);
  const lim = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  return { pg, lim, offset: (pg - 1) * lim };
};

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function listForAdmin(opts) {
  const { pg, lim, offset } = paging(opts);
  const params = [];
  let where = 'TRUE';
  if (opts.status && opts.status !== 'all') {
    params.push(opts.status);
    where += ` AND v.status = $${params.length}`;
  }
  if (opts.search && opts.search.trim()) {
    params.push(`%${escapeLike(opts.search.trim())}%`);
    where += ` AND (u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR v.full_legal_name ILIKE $${params.length})`;
  }
  const from = `FROM customer_verifications v JOIN users u ON u.id = v.customer_id LEFT JOIN users r ON r.id = v.reviewed_by`;
  const total = (await query(`SELECT COUNT(*) AS total ${from} WHERE ${where}`, params)).rows[0].total;
  const { rows } = await query(
    `SELECT v.id, v.customer_id, v.status, v.full_legal_name, v.document_type, v.country,
            v.submitted_at, v.reviewed_at, v.documents_purged_at,
            u.name AS customer_name, u.email AS customer_email, r.name AS reviewer_name
       ${from} WHERE ${where}
      ORDER BY (v.status <> 'pending_review'),
               CASE WHEN v.status = 'pending_review' THEN v.submitted_at END ASC,
               v.submitted_at DESC, v.id DESC
      LIMIT ${lim} OFFSET ${offset}`,
    params
  );
  const counts = Object.fromEntries((await query('SELECT status, COUNT(*) AS n FROM customer_verifications GROUP BY status')).rows.map((r) => [r.status, r.n]));
  return {
    verifications: rows,
    counts,
    meta: { page: pg, limit: lim, total, totalPages: Math.ceil(total / lim) },
  };
}

async function getForAdmin(id) {
  const { rows } = await query(
    `SELECT v.*, u.name AS customer_name, u.email AS customer_email, u.status AS customer_account_status,
            r.name AS reviewer_name
       FROM customer_verifications v JOIN users u ON u.id = v.customer_id LEFT JOIN users r ON r.id = v.reviewed_by
      WHERE v.id = $1`,
    [id]
  );
  const v = rows[0];
  if (!v) throw notFound('Verification not found');
  const docs = (await query('SELECT side, mime_type, size_bytes, created_at FROM verification_documents WHERE verification_id = $1 ORDER BY side', [id])).rows;
  const events = (
    await query(
      `SELECT e.id, e.event, e.from_status, e.to_status, e.reason, e.customer_notified, e.created_at, e.actor_role, a.name AS actor_name
         FROM verification_events e LEFT JOIN users a ON a.id = e.actor_id
        WHERE e.verification_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 100`,
      [id]
    )
  ).rows;

  // The full document number is needed to compare against the photo, so admins (and only admins) get it.
  let documentNumber = null;
  let documentNumberUnreadable = false;
  if (v.documentNumberEncrypted) {
    try {
      documentNumber = decrypt(v.documentNumberEncrypted);
    } catch {
      documentNumberUnreadable = true; // e.g. the encryption key was changed
    }
  }

  return {
    id: v.id,
    status: v.status,
    customer: { id: v.customerId, name: v.customerName, email: v.customerEmail, accountStatus: v.customerAccountStatus },
    details: {
      fullLegalName: v.fullLegalName,
      dateOfBirth: v.dateOfBirth,
      country: v.country,
      phone: v.phone,
      documentType: v.documentType,
      documentNumber,
      documentNumberUnreadable,
    },
    reason: v.reviewReason,
    reviewedBy: v.reviewerName || null,
    reviewedAt: v.reviewedAt,
    submittedAt: v.submittedAt,
    documentsPurged: Boolean(v.documentsPurgedAt),
    documents: docs.map((d) => ({ side: d.side, mimeType: d.mimeType, sizeBytes: d.sizeBytes, uploadedAt: d.createdAt })),
    allowedActions: ADMIN_TRANSITIONS[v.status] || [],
    history: events,
  };
}

async function setStatus(admin, id, { status, reason }) {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  const result = await withTransaction(async (q) => {
    const { rows } = await q(
      `SELECT v.id, v.status, v.document_type, u.name AS customer_name, u.email AS customer_email
         FROM customer_verifications v JOIN users u ON u.id = v.customer_id
        WHERE v.id = $1 FOR UPDATE OF v`,
      [id]
    );
    const cur = rows[0];
    if (!cur) throw notFound('Verification not found');
    if (!(ADMIN_TRANSITIONS[cur.status] || []).includes(status)) {
      throw conflict(`This verification is ${cur.status.replace('_', ' ')} and cannot be changed to ${status.replace('_', ' ')}.`);
    }
    if (status === 'approved') {
      // Never approve without the documents in front of the reviewer's decision.
      const type = getPolicy().documentTypes.find((t) => t.type === cur.documentType);
      const sides = (await q('SELECT side FROM verification_documents WHERE verification_id = $1', [id])).rows.map((r) => r.side);
      if (!sides.includes('front') || (type && type.requiresBack && !sides.includes('back'))) {
        throw conflict('The required documents are missing. Request a resubmission instead.');
      }
    }
    await q(
      `UPDATE customer_verifications
          SET status = $2, review_reason = $3, reviewed_by = $4, reviewed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [id, status, status === 'approved' ? null : trimmed, admin.id]
    );
    const eventId = await insertEvent(q, {
      verificationId: id,
      actor: admin,
      event: EVENT_FOR_STATUS[status],
      fromStatus: cur.status,
      toStatus: status,
      reason: status === 'approved' ? null : trimmed,
    });
    return { eventId, name: cur.customerName, email: cur.customerEmail };
  });
  notify({ to: result.email, name: result.name, kind: status, reason: status === 'approved' ? null : trimmed, eventId: result.eventId });
  return getForAdmin(id);
}

// -------------------------------------------------------------------------------------------- retention

// Deletes document files (and their rows) for decisions older than VERIFICATION_RETENTION_DAYS. The personal
// details and the audit trail stay. Run it daily: `npm run verification:purge`.
async function purgeExpiredDocuments() {
  const { retentionDays } = getPolicy();
  if (!retentionDays) return { purged: 0, disabled: true };

  const { rows: due } = await query(
    `SELECT id FROM customer_verifications
      WHERE documents_purged_at IS NULL AND reviewed_at IS NOT NULL
        AND reviewed_at < NOW() - make_interval(days => $1)`,
    [retentionDays]
  );
  let purged = 0;
  for (const { id } of due) {
    const keys = await withTransaction(async (q) => {
      const docs = (await q('SELECT storage_key FROM verification_documents WHERE verification_id = $1', [id])).rows;
      await q('DELETE FROM verification_documents WHERE verification_id = $1', [id]);
      await q('UPDATE customer_verifications SET documents_purged_at = NOW(), updated_at = NOW() WHERE id = $1', [id]);
      await insertEvent(q, { verificationId: id, event: 'documents_purged', reason: 'Retention policy' });
      return docs.map((d) => d.storageKey);
    });
    await removeKeys(keys);
    purged += 1;
  }
  return { purged, disabled: false };
}

module.exports = {
  NOT_SUBMITTED,
  getForCustomer,
  getStatus,
  isVerified,
  submit,
  resubmit,
  openOwnDocument,
  openDocumentForAdmin,
  listForAdmin,
  getForAdmin,
  setStatus,
  purgeExpiredDocuments,
};
