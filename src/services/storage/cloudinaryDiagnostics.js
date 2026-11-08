'use strict';

// Read-only diagnostics for the Cloudinary connection.
//
// Why this exists: when Cloudinary (or something in front of it) answers with an HTTP status the SDK does not
// parse, the SDK throws "Server returned unexpected status code - <n>" and DISCARDS the response body and headers.
// This module talks to the same API with Node's own https client so the real status, headers and body can be seen.
//
// SAFETY: the API secret, API key, signatures and Authorization headers are never printed. Every string that
// leaves this file goes through a redactor, and only an allow-list of response header values is exposed.

const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://api.cloudinary.com';

// Header VALUES that are safe to show. All other headers are reported by name only.
const SAFE_HEADERS = [
  'server', 'via', 'content-type', 'date', 'retry-after',
  'x-request-id', 'x-cld-error', 'cf-ray', 'x-cache', 'x-served-by', 'x-powered-by',
];

// 1x1 transparent PNG used for the test upload.
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Returns a function that masks the given secrets (and any 40/64-char hex signature) in a string. */
function makeRedactor(secrets) {
  const list = secrets.filter((s) => typeof s === 'string' && s.length >= 4);
  return (text) => {
    let out = String(text == null ? '' : text);
    for (const s of list) out = out.split(s).join('[redacted]');
    return out.replace(/\b[a-f0-9]{64}\b|\b[a-f0-9]{40}\b/gi, '[redacted-hex]');
  };
}

/** Describes how the credentials LOOK (presence, length, stray whitespace/quotes) without revealing them. */
function describeConfig({ cloudName, apiKey, apiSecret }) {
  const shape = (v) => ({
    present: !!v,
    length: v ? v.length : 0,
    hasOuterWhitespace: !!v && v !== v.trim(),
    hasWhitespaceOrControlChars: !!v && /[\s\u0000-\u001f]/.test(v),
    hasQuoteChars: !!v && /["'`]/.test(v),
  });
  return {
    cloudName: cloudName || '', // not secret: it is part of every public image URL
    cloudNameLooksValid: /^[A-Za-z0-9_-]+$/.test(cloudName || ''),
    apiKey: { ...shape(apiKey), allDigits: /^\d+$/.test(apiKey || '') },
    apiSecret: shape(apiSecret),
  };
}

/** Cloudinary signature: sha1 of the sorted "k=v" pairs joined with "&", with the secret appended. */
function sign(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return crypto.createHash('sha1').update(toSign + apiSecret).digest('hex');
}

/** One HTTP(S) request. Never rejects: network failures come back as { networkError }. Body is capped at 4 KB. */
function request(baseUrl, { method, path, headers = {}, body, timeoutMs = 20000 }) {
  const url = new URL(path, baseUrl);
  const lib = url.protocol === 'http:' ? http : https;
  const started = Date.now();
  return new Promise((resolve) => {
    const req = lib.request(
      url,
      { method, headers: { 'User-Agent': 'capital-car-sharing-diagnostics', ...headers }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < 4096) {
            chunks.push(c);
            size += c.length;
          }
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            headerNames: Object.keys(res.headers),
            body: Buffer.concat(chunks).toString('utf8'),
            ms: Date.now() - started,
          })
        );
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', (err) =>
      resolve({ networkError: { code: err.code, syscall: err.syscall, message: err.message }, ms: Date.now() - started })
    );
    if (body) req.write(body);
    req.end();
  });
}

/** Decides who most likely produced the answer. This is a heuristic, and the output says so. */
function classify(res) {
  if (res.networkError) {
    return { ok: false, origin: 'NO HTTP ANSWER (network/DNS/TLS failure before any server replied)', detail: res.networkError.code || res.networkError.message };
  }
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* not JSON */ }
  const apiMessage = json && json.error && json.error.message;
  if (res.status >= 200 && res.status < 300) return { ok: true, origin: 'Cloudinary API', detail: 'accepted' };
  if (apiMessage) return { ok: false, origin: 'Cloudinary API (JSON error body)', detail: apiMessage };
  if (res.headers['x-cld-error']) return { ok: false, origin: 'Cloudinary API (x-cld-error header)', detail: res.headers['x-cld-error'] };
  return {
    ok: false,
    origin: 'LIKELY NOT the Cloudinary API: no Cloudinary error JSON/header (WAF, proxy, CDN or edge block). Check server/via headers and body',
    detail: `HTTP ${res.status}`,
  };
}

function summarize(res, redact) {
  if (res.networkError) {
    return { ms: res.ms, networkError: res.networkError, verdict: classify(res) };
  }
  const safeHeaders = {};
  for (const name of SAFE_HEADERS) if (res.headers[name] !== undefined) safeHeaders[name] = redact(res.headers[name]);
  return {
    status: res.status,
    ms: res.ms,
    headers: safeHeaders,
    allHeaderNames: res.headerNames,
    bodyPreview: redact(res.body).replace(/\s+/g, ' ').slice(0, 300),
    verdict: classify(res),
  };
}

/**
 * Runs, in order: DNS lookup, authenticated ping, a signed 1x1 PNG upload, then deletes that test image.
 * Returns { steps, uploadOk }. Safe to print as JSON.
 */
async function runProbe({ cloudName, apiKey, apiSecret, baseUrl = DEFAULT_BASE_URL }) {
  const redact = makeRedactor([apiSecret, apiKey]);
  const steps = [];
  const host = new URL(baseUrl).hostname;

  try {
    const { address, family } = await dns.lookup(host);
    steps.push({ step: 'dns', host, address, family });
  } catch (err) {
    steps.push({ step: 'dns', host, error: err.code || err.message });
  }

  const basic = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  const ping = await request(baseUrl, {
    method: 'GET',
    path: `/v1_1/${encodeURIComponent(cloudName)}/ping`,
    headers: { Authorization: `Basic ${basic}` },
  });
  steps.push({ step: 'ping (authenticated, Admin API)', ...summarize(ping, redact) });

  const publicId = `capital-car-sharing-diagnostics/probe-${Date.now()}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const form = new URLSearchParams({
    file: TINY_PNG,
    public_id: publicId,
    timestamp,
    api_key: apiKey,
    signature: sign({ public_id: publicId, timestamp }, apiSecret),
  }).toString();
  const upload = await request(baseUrl, {
    method: 'POST',
    path: `/v1_1/${encodeURIComponent(cloudName)}/image/upload`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) },
    body: form,
  });
  const uploadSummary = summarize(upload, redact);
  steps.push({ step: 'signed upload of a 1x1 PNG', publicId, ...uploadSummary });

  const uploadOk = !!uploadSummary.verdict.ok;
  if (uploadOk) {
    const ts = String(Math.floor(Date.now() / 1000));
    const delForm = new URLSearchParams({
      public_id: publicId,
      timestamp: ts,
      api_key: apiKey,
      signature: sign({ public_id: publicId, timestamp: ts }, apiSecret),
    }).toString();
    const del = await request(baseUrl, {
      method: 'POST',
      path: `/v1_1/${encodeURIComponent(cloudName)}/image/destroy`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(delForm) },
      body: delForm,
    });
    steps.push({ step: 'cleanup (delete test image)', ...summarize(del, redact) });
  }

  return { steps, uploadOk };
}

module.exports = { DEFAULT_BASE_URL, makeRedactor, describeConfig, sign, request, runProbe, TINY_PNG };
