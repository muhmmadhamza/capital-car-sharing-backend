-- Partner availability management.
-- Extends the EXISTING `availability` table. No new table; every existing row keeps its values (the new columns are NULL).
--
--   reason      why the owner blocked the day (free text, optional). Only 'unavailable' rows can carry one.
--   blocked_by  the user (partner) who blocked it. SET NULL if that user is ever deleted.
--   blocked_at  when it was blocked or last re-blocked.

ALTER TABLE availability
  ADD COLUMN reason     VARCHAR(200),
  ADD COLUMN blocked_by INTEGER REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN blocked_at TIMESTAMPTZ;

ALTER TABLE availability
  ADD CONSTRAINT chk_availability_reason_only_when_blocked
  CHECK (reason IS NULL OR status = 'unavailable');
