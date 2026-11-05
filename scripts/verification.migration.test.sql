-- Checks migration 003 against a scratch database that already has 001 + 002 applied:
--   psql -v ON_ERROR_STOP=1 -d <scratch_db> -f scripts/verification.migration.test.sql
-- Everything runs in a transaction that is rolled back. Prints PASS lines; any failure raises an error.
BEGIN;

CREATE FUNCTION pg_temp.expect_fail(label TEXT, stmt TEXT, expected_code TEXT) RETURNS void AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE = expected_code THEN RAISE NOTICE 'PASS  %', label; RETURN; END IF;
    RAISE EXCEPTION 'FAIL  % (wrong error % : %)', label, SQLSTATE, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL  % (statement was accepted)', label;
END $$ LANGUAGE plpgsql;

INSERT INTO users (name, email, password_hash, role) VALUES
  ('Cust One', 'c1@example.com', 'x', 'customer'),
  ('Cust Two', 'c2@example.com', 'x', 'customer'),
  ('Admin',    'a1@example.com', 'x', 'admin');

INSERT INTO customer_verifications (customer_id, full_legal_name, date_of_birth, country, phone, document_type)
  SELECT id, 'Cust One', '1990-01-01', 'PK', '+92 300 0000000', 'passport' FROM users WHERE email = 'c1@example.com';
DO $$ BEGIN RAISE NOTICE 'PASS  insert a pending_review record (default status)'; END $$;

SELECT pg_temp.expect_fail('one record per customer (UNIQUE customer_id)',
  $q$INSERT INTO customer_verifications (customer_id, full_legal_name, date_of_birth, country, phone, document_type)
     SELECT id, 'Dup', '1990-01-01', 'PK', '1234567', 'passport' FROM users WHERE email = 'c1@example.com'$q$, '23505');

SELECT pg_temp.expect_fail('invalid status is refused',
  $q$UPDATE customer_verifications SET status = 'approved_by_customer'$q$, '23514');

SELECT pg_temp.expect_fail('rejecting requires a reason',
  $q$UPDATE customer_verifications SET status = 'rejected', reviewed_at = NOW()$q$, '23514');

SELECT pg_temp.expect_fail('blank reason does not count',
  $q$UPDATE customer_verifications SET status = 'resubmission_required', review_reason = '   ', reviewed_at = NOW()$q$, '23514');

SELECT pg_temp.expect_fail('a decision needs a review timestamp',
  $q$UPDATE customer_verifications SET status = 'approved'$q$, '23514');

SELECT pg_temp.expect_fail('country must be two capital letters',
  $q$INSERT INTO customer_verifications (customer_id, full_legal_name, date_of_birth, country, phone, document_type)
     SELECT id, 'X', '1990-01-01', 'pk', '1234567', 'passport' FROM users WHERE email = 'c2@example.com'$q$, '23514');

SELECT pg_temp.expect_fail('document_type must look like a type key',
  $q$INSERT INTO customer_verifications (customer_id, full_legal_name, date_of_birth, country, phone, document_type)
     SELECT id, 'X', '1990-01-01', 'PK', '1234567', 'Passport; DROP' FROM users WHERE email = 'c2@example.com'$q$, '23514');

SELECT pg_temp.expect_fail('customer must exist (foreign key)',
  $q$INSERT INTO customer_verifications (customer_id, full_legal_name, date_of_birth, country, phone, document_type)
     VALUES (999999, 'X', '1990-01-01', 'PK', '1234567', 'passport')$q$, '23503');

-- Valid review outcomes
UPDATE customer_verifications SET status = 'rejected', review_reason = 'Photo is blurry', reviewed_at = NOW(),
  reviewed_by = (SELECT id FROM users WHERE email = 'a1@example.com');
DO $$ BEGIN RAISE NOTICE 'PASS  reject with a reason and reviewer'; END $$;

-- Documents
INSERT INTO verification_documents (verification_id, side, storage_key, mime_type, size_bytes, sha256)
  SELECT id, 'front', 'verifications/1/a.jpg', 'image/jpeg', 100, repeat('a', 64) FROM customer_verifications;
SELECT pg_temp.expect_fail('one document per side',
  $q$INSERT INTO verification_documents (verification_id, side, storage_key, mime_type, size_bytes, sha256)
     SELECT id, 'front', 'verifications/1/b.jpg', 'image/jpeg', 100, repeat('b', 64) FROM customer_verifications$q$, '23505');
SELECT pg_temp.expect_fail('storage keys are unique',
  $q$INSERT INTO verification_documents (verification_id, side, storage_key, mime_type, size_bytes, sha256)
     SELECT id, 'back', 'verifications/1/a.jpg', 'image/jpeg', 100, repeat('b', 64) FROM customer_verifications$q$, '23505');
SELECT pg_temp.expect_fail('side must be front or back',
  $q$INSERT INTO verification_documents (verification_id, side, storage_key, mime_type, size_bytes, sha256)
     SELECT id, 'top', 'verifications/1/c.jpg', 'image/jpeg', 100, repeat('b', 64) FROM customer_verifications$q$, '23514');
SELECT pg_temp.expect_fail('empty files are refused',
  $q$INSERT INTO verification_documents (verification_id, side, storage_key, mime_type, size_bytes, sha256)
     SELECT id, 'back', 'verifications/1/d.jpg', 'image/jpeg', 0, repeat('b', 64) FROM customer_verifications$q$, '23514');

-- Events
INSERT INTO verification_events (verification_id, actor_id, actor_role, event, from_status, to_status)
  SELECT v.id, v.customer_id, 'customer', 'submitted', NULL, 'pending_review' FROM customer_verifications v;
SELECT pg_temp.expect_fail('unknown event type is refused',
  $q$INSERT INTO verification_events (verification_id, event) SELECT id, 'hacked' FROM customer_verifications$q$, '23514');

-- Deleting an admin keeps the record (ON DELETE SET NULL) and does not trip the checks
DELETE FROM users WHERE email = 'a1@example.com';
DO $$ BEGIN
  IF (SELECT reviewed_by FROM customer_verifications) IS NULL AND (SELECT status FROM customer_verifications) = 'rejected'
  THEN RAISE NOTICE 'PASS  deleting the reviewing admin keeps the decision (reviewed_by becomes NULL)';
  ELSE RAISE EXCEPTION 'FAIL  admin delete'; END IF;
END $$;

-- Deleting the customer removes their verification, documents and events
DELETE FROM users WHERE email = 'c1@example.com';
DO $$ BEGIN
  IF (SELECT COUNT(*) FROM customer_verifications) + (SELECT COUNT(*) FROM verification_documents) + (SELECT COUNT(*) FROM verification_events) = 0
  THEN RAISE NOTICE 'PASS  deleting a customer cascades to verification data';
  ELSE RAISE EXCEPTION 'FAIL  cascade'; END IF;
END $$;

ROLLBACK;
