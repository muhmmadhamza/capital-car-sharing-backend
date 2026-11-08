'use strict';

// Run this ON THE HOSTINGER SERVER (same machine/IP/env as the app):
//
//   node scripts/diagnose-cloudinary.js
//   node scripts/diagnose-cloudinary.js --show-egress-ip     (also prints this server's public IP)
//
// It reports where the credentials come from, how they look (never their values), and then makes the raw
// Cloudinary calls the SDK hides: DNS, authenticated ping, signed 1x1 PNG upload, cleanup.
// Exit code 0 = upload accepted, 2 = upload failed.

const watched = ['STORAGE_DRIVER', 'NODE_ENV', 'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_URL'];
// Snapshot BEFORE dotenv runs: a variable already present here came from the host (hPanel), not from .env.
const presentBeforeDotenv = Object.fromEntries(watched.map((k) => [k, process.env[k] !== undefined]));
try {
  require('dotenv').config();
} catch {
  /* dotenv not installed: only host-provided variables are used */
}

const diag = require('../src/services/storage/cloudinaryDiagnostics');

const args = process.argv.slice(2);
const argValue = (name) => (args.find((a) => a.startsWith(`${name}=`)) || '').slice(name.length + 1);
const baseUrl = argValue('--base-url') || diag.DEFAULT_BASE_URL; // --base-url exists so the script itself can be tested offline

const cfg = {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  apiKey: process.env.CLOUDINARY_API_KEY || '',
  apiSecret: process.env.CLOUDINARY_API_SECRET || '',
};

let sdkVersion = 'not installed';
try { sdkVersion = require('cloudinary/package.json').version; } catch { /* ignore */ }

const print = (title, value) => console.log(`\n=== ${title}\n${JSON.stringify(value, null, 2)}`);

(async () => {
  print('environment', {
    node: process.version,
    cloudinarySdk: sdkVersion,
    NODE_ENV: process.env.NODE_ENV || '(unset)',
    STORAGE_DRIVER: process.env.STORAGE_DRIVER || '(unset, app defaults to "local")',
    CLOUDINARY_URL_isSet: !!process.env.CLOUDINARY_URL,
    valueCameFromHostEnvironment: presentBeforeDotenv, // true = set outside .env (hPanel / server env)
  });
  print('credential shape (values are never printed)', diag.describeConfig(cfg));

  if (args.includes('--show-egress-ip')) {
    const ip = await diag.request('https://api.ipify.org', { method: 'GET', path: '/?format=json', timeoutMs: 8000 });
    print('this server public IP (as seen from outside)', ip.networkError ? { error: ip.networkError.code } : { status: ip.status, body: ip.body.slice(0, 80) });
  }

  if (!cfg.cloudName || !cfg.apiKey || !cfg.apiSecret) {
    console.error('\nCannot probe: CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not all set in this process.');
    process.exit(2);
  }

  const { steps, uploadOk } = await diag.runProbe({ ...cfg, baseUrl });
  steps.forEach((s) => print(s.step, s));
  console.log(`\nRESULT: ${uploadOk ? 'upload ACCEPTED by the endpoint' : 'upload FAILED - read the "verdict" of the failing step above'}`);
  process.exit(uploadOk ? 0 : 2);
})().catch((err) => {
  console.error('Diagnostic script crashed:', err && err.message);
  process.exit(1);
});
