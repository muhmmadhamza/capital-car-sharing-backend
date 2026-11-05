-- Customer identity & document verification.
-- Additive and non-destructive: only creates new tables. No existing table or row is touched.
--
-- Model: one verification record per customer (UNIQUE customer_id) that moves through
--   pending_review -> approved | rejected | resubmission_required -> (customer resubmits) -> pending_review ...
-- "not submitted" has no row: the absence of a record IS that status.
-- Every change is written to verification_events, so a full audit trail survives resubmissions
-- even though replaced document files are deleted.
--
-- Identity document files are NOT stored here. Only private storage keys and metadata are.
-- The document number is stored encrypted (AES-256-GCM, key from VERIFICATION_ENCRYPTION_KEY) plus its last 4 characters.

CREATE TABLE customer_verifications (
  id                        SERIAL PRIMARY KEY,
  customer_id               INTEGER      NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  status                    VARCHAR(30)  NOT NULL DEFAULT 'pending_review'
                            CHECK (status IN ('pending_review', 'approved', 'rejected', 'resubmission_required')),

  full_legal_name           VARCHAR(120) NOT NULL,
  date_of_birth             DATE         NOT NULL,
  country                   CHAR(2)      NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  phone                     VARCHAR(30)  NOT NULL,

  -- Accepted types are configured in the application (VERIFICATION_DOCUMENT_TYPES), so no enum CHECK here:
  -- a new type needs no migration.
  document_type             VARCHAR(30)  NOT NULL CHECK (document_type ~ '^[a-z][a-z_]{1,29}$'),
  document_number_encrypted TEXT,
  document_number_last4     VARCHAR(4),

  -- Review outcome. review_reason is shown to the customer, so admins must keep it free of sensitive details.
  review_reason             TEXT,
  reviewed_by               INTEGER      REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at               TIMESTAMPTZ,

  submitted_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Set when the document files were deleted under the retention policy.
  documents_purged_at       TIMESTAMPTZ,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_reason_required
    CHECK (status NOT IN ('rejected', 'resubmission_required') OR (review_reason IS NOT NULL AND LENGTH(BTRIM(review_reason)) > 0)),
  CONSTRAINT chk_reviewed_at_set
    CHECK (status = 'pending_review' OR reviewed_at IS NOT NULL)
);
CREATE INDEX idx_customer_verifications_status    ON customer_verifications (status, submitted_at);
CREATE INDEX idx_customer_verifications_reviewer  ON customer_verifications (reviewed_by);
CREATE INDEX idx_customer_verifications_reviewed  ON customer_verifications (reviewed_at) WHERE documents_purged_at IS NULL;

-- Metadata for the private files. `storage_key` is a server-generated random name inside PRIVATE storage;
-- it is never sent to a client and never part of a URL.
CREATE TABLE verification_documents (
  id              SERIAL PRIMARY KEY,
  verification_id INTEGER      NOT NULL REFERENCES customer_verifications (id) ON DELETE CASCADE,
  side            VARCHAR(10)  NOT NULL CHECK (side IN ('front', 'back')),
  storage_key     VARCHAR(255) NOT NULL UNIQUE,
  mime_type       VARCHAR(100) NOT NULL,
  size_bytes      INTEGER      NOT NULL CHECK (size_bytes > 0),
  sha256          CHAR(64)     NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (verification_id, side)
);

-- Audit trail. Rows are only ever inserted. Holds no document numbers and no file contents.
CREATE TABLE verification_events (
  id                SERIAL PRIMARY KEY,
  verification_id   INTEGER     NOT NULL REFERENCES customer_verifications (id) ON DELETE CASCADE,
  actor_id          INTEGER     REFERENCES users (id) ON DELETE SET NULL,
  actor_role        VARCHAR(20),
  event             VARCHAR(40) NOT NULL
                    CHECK (event IN ('submitted', 'resubmitted', 'approved', 'rejected', 'resubmission_requested', 'document_viewed', 'documents_purged')),
  from_status       VARCHAR(30),
  to_status         VARCHAR(30),
  reason            TEXT,
  -- NULL: no email attempted. TRUE: the SMTP server accepted it (not proof of inbox delivery). FALSE: not sent.
  customer_notified BOOLEAN,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_verification_events_verification ON verification_events (verification_id, created_at);
