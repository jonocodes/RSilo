ALTER TABLE users ADD COLUMN password_hash TEXT;

CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
