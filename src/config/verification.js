// Customer verification policy. Everything an operator may want to tune lives here, driven by environment
// variables, so the operating region's rules can change without touching code. Values are read on every call
// (cheap) so tests can change process.env. NOTE: load config/env.js (it runs dotenv) before first use.
const path = require('path');

// Document types the code knows how to handle. VERIFICATION_DOCUMENT_TYPES picks which are accepted.
// Add a type here (and nothing else) to support it; the database accepts any lower_snake_case type.
const KNOWN_DOCUMENT_TYPES = {
  national_id: { label: 'National identity card', requiresBack: true, requiresNumber: true },
  passport: { label: 'Passport', requiresBack: false, requiresNumber: true },
  driving_licence: { label: 'Driving licence', requiresBack: true, requiresNumber: true },
};

const csv = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const flag = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
};

// Every ISO 3166-1 alpha-2 region the runtime knows, with its English name. Built once from Intl.
let regionCache;
function regions() {
  if (regionCache) return regionCache;
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const out = [];
  const A = 'A'.charCodeAt(0);
  for (let i = 0; i < 26; i += 1) {
    for (let j = 0; j < 26; j += 1) {
      const code = String.fromCharCode(A + i, A + j);
      let name;
      try {
        name = names.of(code);
      } catch {
        continue;
      }
      // Unassigned codes come back unchanged ("QQ" -> "QQ"); the pseudo-regions below are not countries.
      if (!name || name === code || /unknown|^European Union$|^United Nations$|^Outlying Oceania$/i.test(name)) continue;
      out.push({ code, name });
    }
  }
  regionCache = out.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return regionCache;
}

function getPolicy() {
  const env = process.env;

  const enabled = csv(env.VERIFICATION_DOCUMENT_TYPES);
  const typeKeys = (enabled.length ? enabled : Object.keys(KNOWN_DOCUMENT_TYPES)).filter((k) => KNOWN_DOCUMENT_TYPES[k]);
  if (!typeKeys.length) {
    throw new Error(`VERIFICATION_DOCUMENT_TYPES has no usable type. Known types: ${Object.keys(KNOWN_DOCUMENT_TYPES).join(', ')}`);
  }
  // VERIFICATION_REQUIRE_DOCUMENT_NUMBER=false turns the number off for every type ("only if required").
  const numberRequired = flag(env.VERIFICATION_REQUIRE_DOCUMENT_NUMBER, true);
  const documentTypes = typeKeys.map((type) => ({
    type,
    label: KNOWN_DOCUMENT_TYPES[type].label,
    requiresBack: KNOWN_DOCUMENT_TYPES[type].requiresBack,
    requiresNumber: numberRequired && KNOWN_DOCUMENT_TYPES[type].requiresNumber,
  }));

  const allCountries = regions();
  const allowed = csv(env.VERIFICATION_ALLOWED_COUNTRIES).map((c) => c.toUpperCase());
  const countries = allowed.length ? allCountries.filter((c) => allowed.includes(c.code)) : allCountries;

  const maxFileMb = Math.min(parseFloat(env.VERIFICATION_MAX_FILE_MB) > 0 ? parseFloat(env.VERIFICATION_MAX_FILE_MB) : 5, 25);

  return {
    documentTypes,
    countries,
    minAge: int(env.VERIFICATION_MIN_AGE, 18, { min: 16, max: 100 }),
    maxFileSizeBytes: Math.round(maxFileMb * 1024 * 1024),
    maxFileSizeMb: maxFileMb,
    // Accepted file formats. The real type is detected from the file's bytes, never from its name.
    acceptedFormats: [
      { mime: 'image/jpeg', ext: 'jpg', label: 'JPG' },
      { mime: 'image/png', ext: 'png', label: 'PNG' },
      { mime: 'image/webp', ext: 'webp', label: 'WebP' },
      { mime: 'application/pdf', ext: 'pdf', label: 'PDF' },
    ],
    // Documents are deleted this many days after a review decision. 0 = never delete automatically.
    retentionDays: int(env.VERIFICATION_RETENTION_DAYS, 30, { min: 0, max: 3650 }),
    // Private storage folder. Must NOT be inside the public upload folder (checked when storage starts).
    storageDir: path.resolve(env.VERIFICATION_STORAGE_DIR || 'private-uploads'),
    maxReasonLength: 500,
  };
}

const publicPolicy = (policy = getPolicy()) => ({
  documentTypes: policy.documentTypes,
  countries: policy.countries,
  minAge: policy.minAge,
  maxFileSizeMb: policy.maxFileSizeMb,
  acceptedFormats: policy.acceptedFormats.map(({ mime, label }) => ({ mime, label })),
});

module.exports = { getPolicy, publicPolicy, regions, KNOWN_DOCUMENT_TYPES };
