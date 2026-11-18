# Advance reservations (Part 3)

An advance reservation is **a normal reservation made well ahead of pickup**. It uses the same `reservations` table,
the same overlap protection, pricing, verification gate and status workflow as every other booking. Nothing is duplicated.

## What changed

| Area | Change |
|------|--------|
| Database | `006_advance_reservations.sql` adds `reservations.booking_type` (`standard` \| `advance`, default `standard`, CHECK + index). Existing rows are untouched and stay `standard`. |
| Rule | `booking_type = 'advance'` when pickup is at least `BOOKING_ADVANCE_MIN_HOURS` (default **24**) after the booking is made. Decided and stored by the server at creation, so it does not change as the pickup day gets closer. |
| Car search | `GET /api/cars?bookingType=advance&pickupDate=&returnDate=` — dates required and must qualify (not sooner than the minimum lead, within `BOOKING_MAX_ADVANCE_DAYS`, within `BOOKING_MAX_DAYS`). Same availability filter as before: cars with pending/confirmed bookings or owner-blocked days in the window are left out. Without `bookingType` the search behaves exactly as before. |
| Quote / create | `POST /api/customers/me/reservations/quote` and `POST /api/customers/me/reservations` accept an optional `bookingType`. `advance` means "refuse unless this really is an advance reservation" (422). Responses carry `bookingType`; the quote also carries `leadHours` and `advanceMinHours`. |
| Customer | `GET /api/customers/me/reservations?bookingType=&upcoming=` |
| Partner | `GET /api/partners/me/reservations?bookingType=&upcoming=`; `…/stats` adds `advance`, `advancePending`, `upcomingAdvance`, `advanceNext7Days`. Still limited to the partner's own cars. |
| Admin | `GET /api/admin/reservations?bookingType=&upcoming=`; **new** `GET /api/admin/reservations/stats`; `/api/admin/dashboard` stats add `advanceReservations`, `pendingAdvanceReservations`. Status changes use the existing `PATCH /api/admin/reservations/:id/status`. |

`upcoming=true` means: pending or confirmed, and the pickup time has not passed.

## Apply

```bash
# back up first (pg_dump), then:
npm run migrate        # applies 006 only; safe to run again
```

Optional: `BOOKING_ADVANCE_MIN_HOURS` in `.env` (see `.env.example`).

## Tests (need a migrated PostgreSQL; they create and remove their own rows, and refuse NODE_ENV=production)

```bash
npm run test:advance:unit   # pure rules, no database
npm run test:advance        # integration against the real database
npm run test:workflow       # existing suite, still passes
```

## Things to know

- Reservations created before this module are `standard`: the lead time they were booked with was not recorded.
- The overlap guard is per **calendar day** (as before), so a car returned on day N cannot be picked up again on day N.
- A pending advance reservation that the partner never answers stays pending; it can no longer be approved once its pickup time passes. There is no automatic expiry (none exists for any booking today).

## Frontend (Next.js `src/`)

| Where | What |
|-------|------|
| `/customer/advance` (nav: **Reserve Ahead**) | Pick future dates, see only cars free for all of them (existing car search with `bookingType=advance`), then **Reserve** opens the existing checkout. |
| My Reservations / Dashboard / Confirmation / Details | **Advance** badge; new **Advance** filter tab and dashboard counter. |
| Partner → Reservations | Booking-type filter (applied by the API), badge, "Advance reservations ahead" dashboard card. |
| Admin → Reservations / Dashboard | Booking-type filter, badge, "Advance ahead" and "Advance Reservations" cards (`/admin/reservations?type=advance`). |
| `features/reservations/advance.ts` | Client-side hints only; the API is the authority. Keep `RENTAL_RULES.advanceMinHours` equal to `BOOKING_ADVANCE_MIN_HOURS`. |
