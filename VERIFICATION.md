# Customer identity verification

## Setup
1. `npm install`, then add the `VERIFICATION_*` values from `.env.example` to `.env`.
   Generate the encryption key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (required in production; keep it safe, losing it makes stored document numbers unreadable).
2. Apply the migration (additive, creates 3 new tables, touches nothing else): `npm run migrate`
3. Private storage: `VERIFICATION_STORAGE_DIR` (default `private-uploads/`) must NOT be inside `UPLOAD_DIR`; the API refuses to start otherwise. Never serve it from a web server. For production use a disk outside the web root (or add an S3-style driver with the same `save/read/remove/exists` methods in `src/services/storage/private.js`).
4. Retention: schedule `npm run verification:purge` daily (cron). Files are deleted `VERIFICATION_RETENTION_DAYS` (default 30) after a decision; details and audit trail are kept.
5. Email: uses the existing SMTP settings. Without `SMTP_HOST` nothing is sent, and the audit trail records `customer_notified = false`.

## API
| Method / path | Who | Purpose |
|---|---|---|
| `GET /api/customer/verification` | customer | own status, safe details, form policy |
| `POST /api/customer/verification` | customer | first submission (multipart: fields + `front`, `back`) |
| `PATCH /api/customer/verification` | customer | resubmit after rejected / resubmission_required |
| `GET /api/customer/verification/documents/:side` | owner | own file |
| `GET /api/admin/verifications?status=&search=&page=` | admin | list + counts |
| `GET /api/admin/verifications/:id` | admin | detail + history |
| `GET /api/admin/verifications/:id/documents/:side` | admin | file (each view is logged) |
| `PATCH /api/admin/verifications/:id/status` | admin | `{status: approved\|rejected\|resubmission_required, reason}` |

Statuses: `not_submitted` (no record), `pending_review`, `approved`, `rejected`, `resubmission_required`.

## Booking integration
```js
const { requireVerifiedCustomer } = require('../middleware/requireVerifiedCustomer');
router.post('/', authenticate, authorize('customer'), requireVerifiedCustomer, create);
```
Or call `verificationService.getStatus(userId)` / `isVerified(userId)` inside the service. Non-approved customers get 403.

## Tests
- `npm run test:verification:unit`: no DB or network needed.
- `psql -d <scratch db with migrations 001-003> -f scripts/verification.migration.test.sql`
- `npm run test:verification`: end-to-end against a running API + DB (needs `npm run db:setup` and `npm run dev`).
