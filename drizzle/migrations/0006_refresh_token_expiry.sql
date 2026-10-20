-- Refresh tokens now expire 30 days after they are issued; every rotation
-- issues a fresh one. Existing refresh tokens get 30 days from now.
--
-- A superseded refresh token is no longer accepted, so
-- previous_refresh_token_hash is unused. SQLite cannot drop a UNIQUE column,
-- so it stays, cleared.
ALTER TABLE oauth_tokens ADD COLUMN refresh_expires_at INTEGER;
UPDATE oauth_tokens SET refresh_expires_at = unixepoch() + 2592000 WHERE refresh_token_hash IS NOT NULL;
UPDATE oauth_tokens SET previous_refresh_token_hash = NULL;
