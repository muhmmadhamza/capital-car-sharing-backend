-- Advance reservations (Part 3).
-- Extends the EXISTING `reservations` table. No new table, no data is changed or dropped.
--
-- booking_type:
--   standard  pickup is less than BOOKING_ADVANCE_MIN_HOURS (default 24) after the booking was made
--   advance   pickup is at least that far ahead (decided by the API when the booking is created, then stored,
--             so it does not flip when the pickup day gets closer)
--
-- Every existing reservation becomes 'standard': the lead time it was booked with was never recorded, and
-- guessing would mislabel real bookings. The overlap guard, statuses, pricing and history are untouched, so an
-- advance reservation is held, priced, approved and cancelled by exactly the same rules as any other booking.

ALTER TABLE reservations
  ADD COLUMN booking_type VARCHAR(10) NOT NULL DEFAULT 'standard';

ALTER TABLE reservations
  ADD CONSTRAINT reservations_booking_type_check CHECK (booking_type IN ('standard', 'advance'));

-- Admin and partner "advance reservations" views and the upcoming-pickup counts.
CREATE INDEX idx_reservations_booking_type ON reservations (booking_type, status, pickup_date);
