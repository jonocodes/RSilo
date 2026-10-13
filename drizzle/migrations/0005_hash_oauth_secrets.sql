-- Access tokens, refresh tokens and authorization codes are now stored only as
-- base64url SHA-256 hashes, so a copy of the database holds nothing a client
-- could present. The code flow now requires S256 PKCE, so every code has a
-- code_challenge (the code_challenge_method column from 0004 is dropped: it can
-- only be S256). A refresh token stays valid until its replacement is first used.
--
-- D1's SQL has no SHA-256, so existing plaintext rows cannot be converted in
-- place. They are dropped, along with the clients they belonged to, and each
-- connected app reconnects once.

DROP TABLE IF EXISTS oauth_tokens;
DROP TABLE IF EXISTS oauth_codes;
DELETE FROM oauth_clients;

CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT UNIQUE NOT NULL,
  refresh_token_hash TEXT UNIQUE,
  previous_refresh_token_hash TEXT UNIQUE,
  expires_at INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(username),
  client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  scope TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_id ON oauth_tokens(user_id);
