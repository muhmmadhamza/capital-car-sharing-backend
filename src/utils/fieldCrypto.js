// AES-256-GCM encryption for sensitive fields stored in PostgreSQL (the identity document number).
// Stored format: "v1.<iv>.<authTag>.<ciphertext>" (base64url parts).
//
// Key: VERIFICATION_ENCRYPTION_KEY = 64 hex characters (32 bytes) or base64 of 32 bytes. Generate one with
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// In production the key is mandatory. In development a key is derived from JWT_SECRET so the app works out of
// the box (with a one-time warning); do not rely on that for real customer data.
const crypto = require('crypto');

let warned = false;

function loadKey() {
  const raw = (process.env.VERIFICATION_ENCRYPTION_KEY || '').trim();
  if (raw) {
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('VERIFICATION_ENCRYPTION_KEY must be 32 bytes (64 hex characters or base64).');
    return key;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('VERIFICATION_ENCRYPTION_KEY is required in production.');
  }
  if (!process.env.JWT_SECRET) throw new Error('VERIFICATION_ENCRYPTION_KEY is not set.');
  if (!warned) {
    warned = true;
    console.warn('VERIFICATION_ENCRYPTION_KEY is not set: deriving a development key from JWT_SECRET. Set a dedicated key before real use.');
  }
  return crypto.createHash('sha256').update(`verification-field-key:${process.env.JWT_SECRET}`).digest();
}

const b64 = (buf) => buf.toString('base64url');

function encrypt(plain) {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', b64(iv), b64(cipher.getAuthTag()), b64(data)].join('.');
}

function decrypt(payload) {
  if (!payload) return null;
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unsupported encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
