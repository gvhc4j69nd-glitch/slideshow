-- Accounts, and the key used to sign session cookies.

CREATE TABLE IF NOT EXISTS users (
  id             uuid        PRIMARY KEY,
  username       text        NOT NULL,
  password_hash  text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Usernames are compared case-insensitively, so uniqueness has to be too:
-- "Joseph" and "joseph" are the same account.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

-- Small key/value store for server-side settings. The session signing key lives
-- here rather than on disk, so cookies survive a redeploy with no volume
-- attached and every instance signs with the same key.
CREATE TABLE IF NOT EXISTS app_settings (
  key        text        PRIMARY KEY,
  value      text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
