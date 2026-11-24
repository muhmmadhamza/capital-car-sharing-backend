# Partner availability management

Reuses the existing `availability` table, `availability.service.js` and the partner routes. No second table or API.

## Rules
- A day is **booked** when a `pending` or `confirmed` reservation (standard or advance) covers it, or an `availability` row says `booked`.
  Reservations are read live, so booking, cancelling or rejecting changes every screen at once.
- A day is **unavailable** when the owner blocked it (optional reason, max 200 characters, visible only to the owner).
- Booked days can never be blocked or re-opened: the whole request fails with 409 and nothing is written.
- Past dates are refused (422). Today is allowed. A range is at most 366 days.
- Owner changes and bookings take the same row lock on the car (`SELECT ... FROM cars ... FOR UPDATE`), and PostgreSQL
  also refuses overlapping pending/confirmed reservations (`reservations_no_overlap`).
- Cancelling or rejecting a reservation also removes stale `booked` availability rows for its days (unless another live booking covers them).

## Endpoints (all under `/api`)
| Method | Path | Who | What |
|---|---|---|---|
| GET | `/partners/me/cars` | partner | Own cars, each with `availabilityToday` |
| GET | `/partners/me/cars/:id` | partner (owner) | One own car |
| GET | `/partners/me/cars/:id/availability?startDate&endDate` | partner (owner) | `availableDates`, `unavailableDates`, `bookedDates`, `blockedDetails[{date,reason,blockedAt}]` |
| PUT | `/partners/me/cars/:id/availability` | partner (owner) | Body `{status:'available'|'unavailable', dates[] OR startDate+endDate, reason?}` |
| GET | `/cars/:id/availability?startDate&endDate` | public | Same arrays, never reasons; 404 unless the car is published |
| GET | `/cars?pickupDate&returnDate&...` | public | Search; leaves out cars blocked or booked in the window |
| POST | `/customers/me/reservations` | verified customer | Create booking (pending); 409 when a day is taken |
| POST | `/customers/me/reservations/:id/cancel` | customer (owner) | Frees the days |
| PATCH | `/partners/me/reservations/:id/approve` / `reject` / `complete` | partner (owner of the car) | `reject` frees the days |
| PATCH | `/admin/reservations/:id/status` | admin | Same workflow |

## Database
`007_availability_block_reason.sql`: adds `reason`, `blocked_by`, `blocked_at` to `availability` (all nullable) and a check that only `unavailable` rows carry a reason.

## Tests
- `npm run test:availability:unit` request validation (no DB)
- `npm run test:availability:service` transactions and SQL parameters against a scripted database (no DB)
- `npm run test:availability` existing availability checks (live API + PostgreSQL)
- `npm run test:availability:manage` the 12-point checklist (live API + PostgreSQL)
- `npm run test:reservations`, `test:workflow`, `test:advance` existing booking checks (live API + PostgreSQL)

## Stale data
Older data or seed scripts may have written `booked` rows for bookings that were already cancelled. New cancellations clean up after themselves; to clear old ones once:
```sql
DELETE FROM availability a WHERE a.status = 'booked' AND NOT EXISTS (
  SELECT 1 FROM reservations r WHERE r.car_id = a.car_id AND r.status IN ('pending','confirmed')
  AND a.date BETWEEN r.pickup_date AND r.return_date);
```
