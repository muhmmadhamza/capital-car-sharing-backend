-- Booking status workflow (Part 2).
--
-- Status vocabulary becomes:  pending | confirmed | completed | cancelled | rejected
--   pending    a customer requested the booking, the partner has not answered yet (the dates are held)
--   confirmed  the partner (or an admin) approved it                               (the dates are held)
--   completed  the rental took place
--   cancelled  the customer (or an admin) cancelled it                             (the dates are free again)
--   rejected   the partner (or an admin) declined it                               (the dates are free again)
--
-- Mapping of the old values:  upcoming -> confirmed,  active -> confirmed  (they were accepted bookings).
-- "Out on rental right now" is no longer a stored status: it is a confirmed booking whose dates include today.
-- Nothing is deleted. Existing rows keep every other value.

-- The overlap guard mentions the old status names, so it is dropped first and recreated below.
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_no_overlap;
ALTER TABLE reservations DROP CONSTRAINT IF EXISTS reservations_status_check;

UPDATE reservations SET status = 'confirmed' WHERE status IN ('upcoming', 'active');

ALTER TABLE reservations
  ADD CONSTRAINT reservations_status_check
  CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled', 'rejected')),
  ALTER COLUMN status SET DEFAULT 'pending';

-- ---------------------------------------------------------------- status history
-- One row per status change: who (user + role), from what, to what, why, and when. Append-only.
CREATE TABLE reservation_status_history (
  id              SERIAL PRIMARY KEY,
  reservation_id  INTEGER NOT NULL REFERENCES reservations (id) ON DELETE CASCADE,
  from_status     VARCHAR(20),                       -- NULL for the first row (creation)
  to_status       VARCHAR(20) NOT NULL
                  CHECK (to_status IN ('pending', 'confirmed', 'completed', 'cancelled', 'rejected')),
  changed_by      INTEGER REFERENCES users (id) ON DELETE SET NULL,
  changed_by_role VARCHAR(20) NOT NULL CHECK (changed_by_role IN ('customer', 'partner', 'admin', 'system')),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reservation_status_history_reservation ON reservation_status_history (reservation_id, id);

-- Existing reservations get a first history row, so every booking has a history.
INSERT INTO reservation_status_history (reservation_id, from_status, to_status, changed_by, changed_by_role, reason, created_at)
SELECT id, NULL, status, customer_id, 'system', 'Reservation existed before status history was introduced', created_at
FROM reservations;

-- ---------------------------------------------------------------- double-booking guard, new status names
-- Pending and confirmed bookings both hold the car. Same behaviour as in 004: a warning, not a failed deploy,
-- if the extension is not allowed or old data already overlaps.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
  ALTER TABLE reservations
    ADD CONSTRAINT reservations_no_overlap
    EXCLUDE USING gist (
      car_id WITH =,
      daterange(pickup_date, return_date, '[]') WITH &&
    ) WHERE (status IN ('pending', 'confirmed'));
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING 'reservations_no_overlap NOT created: cannot create the btree_gist extension (%). API row locking still protects against double booking.', SQLERRM;
  WHEN exclusion_violation THEN
    RAISE WARNING 'reservations_no_overlap NOT created: existing reservations already overlap for the same car (%). Fix the data and add the constraint manually.', SQLERRM;
END
$$;

-- Partner inbox: "my bookings, by status, newest first".
CREATE INDEX idx_reservations_partner_status ON reservations (partner_id, status, created_at DESC);
