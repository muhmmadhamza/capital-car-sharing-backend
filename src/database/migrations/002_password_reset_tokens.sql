-- Password reset tokens for Customer, Partner and Admin accounts.
-- Additive and non-destructive: only creates a new table. Only the SHA-256 hash of a token is stored,
-- never the token itself (that only exists in the email link).

CREATE TABLE password_reset_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER     NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Role the token was issued for. A token is only accepted by the reset endpoint of that same role.
  role        VARCHAR(20) NOT NULL CHECK (role IN ('customer', 'partner', 'admin')),
  token_hash  CHAR(64)    NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_password_reset_tokens_hash ON password_reset_tokens (token_hash);
CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens (user_id, created_at DESC);
CREATE INDEX idx_password_reset_tokens_expires ON password_reset_tokens (expires_at);
