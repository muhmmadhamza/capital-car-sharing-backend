# Reservation / Booking system (Part 1 + Part 2)

## Apply the database changes (non-destructive, in order)

```bash
cp .env.example .env        # then fill in your own values (DATABASE_URL, JWT_SECRET, ...)
npm install
npm run migrate             # runs every migration not yet applied, in filename order
```

Migrations are tracked, so running `npm run migrate` again is safe. **Back up the database first** (`pg_dump`).

| # | File | What it does to existing data |
|---|------|-------------------------------|
| 001-003 | existing | unchanged |
| 004 | `004_reservation_booking.sql` | Adds booking columns (reference, pick-up/return times, price breakdown), the `generate_booking_reference()` function, indexes and a database-level overlap guard. Existing reservations get a reference and `00:00` times. Nothing is deleted. |
| 005 | `005_booking_status_workflow.sql` | Status vocabulary becomes `pending, confirmed, completed, cancelled, rejected`. **Existing `upcoming` and `active` rows become `confirmed`** (they were already accepted bookings). Creates `reservation_status_history` and backfills one `system` row per existing booking. Recreates the overlap guard for `pending`+`confirmed`. If old data already contains overlapping bookings, the guard is skipped with a NOTICE instead of failing; the application still blocks double booking. |

Rollback: restore the backup (005 rewrites status values, so there is no automatic down-migration).

## Configuration (all optional, see `.env.example`)

`BOOKING_MIN_HOURS` (4), `BOOKING_MAX_DAYS` (30), `BOOKING_MAX_ADVANCE_DAYS` (365),
`BOOKING_CANCEL_MIN_HOURS` (24), `BOOKING_SERVICE_FEE_PERCENT` (0), `BOOKING_TAX_PERCENT` (0), `BOOKING_RATE_LIMIT_MAX` (60).

## Cancellation rules (proposed defaults, configurable)

No cancellation rules existed, so these were chosen as a starting point. Change them with the variables above:
a customer can cancel a **pending** booking any time before pick-up, and a **confirmed** booking until
`BOOKING_CANCEL_MIN_HOURS` (24) before pick-up. Started, completed, rejected and cancelled bookings cannot be cancelled by the customer.
No fees or refunds are modelled because payments are not connected yet.

## Status workflow

| From | To | Who |
|------|----|-----|
| pending | confirmed | partner (own cars), admin |
| pending | rejected (reason required) | partner (own cars), admin |
| pending / confirmed | cancelled | customer (own booking, rules above); admin (reason required) |
| confirmed | completed (only after pick-up time) | partner (own cars), admin |

Everything else is refused (409). Each change writes a row to `reservation_status_history` (who, role, when, reason).
Nothing completes a booking automatically; a partner or admin does it.

## API added in Part 2

Customer: `POST /api/customers/me/reservations/:id/cancel` `{reason?}`; `GET /api/customers/me/reservations/:id` now includes `history`, `canCancel`, `statusReason`.
Partner (own cars only): `GET /api/partners/me/reservations?status=&carId=&search=&limit=`, `GET .../stats`, `GET .../:id`,
`PATCH .../:id/approve`, `PATCH .../:id/reject {reason}`, `PATCH .../:id/complete`.
Admin: `GET /api/admin/reservations?status=&customerId=&carId=&partnerId=&search=`, `GET /api/admin/reservations/:id`, `PATCH /api/admin/reservations/:id/status {status, reason?}`.

## Tests (need a PostgreSQL database that has been migrated; they create and delete their own rows)

```bash
npm run test:reservations:unit   # pure rules, no database
npm run test:reservations        # Part 1 integration
npm run test:workflow            # Part 2 integration
```
