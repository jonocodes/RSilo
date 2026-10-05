-- The application treats a token's subject as the username (storage routes
-- compare the token subject to the URL username), but oauth_clients.user_id and
-- oauth_tokens.user_id were declared as foreign keys to users(id) (a UUID).
-- Because D1 enforces foreign keys, inserting a token failed. Recreate the
-- OAuth tables so user_id references users(username), which is UNIQUE.
--
-- SQLite cannot alter a foreign key in place, so the tables are rebuilt. Any
-- existing OAuth rows were unusable (token issuance was broken), so they are
-- dropped rather than migrated.

DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_clients;

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_id TEXT NOT NULL REFERENCES users(username)
);

CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token TEXT UNIQUE NOT NULL,
  refresh_token TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(username),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_access_token ON oauth_tokens(access_token);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh_token ON oauth_tokens(refresh_token);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id);
