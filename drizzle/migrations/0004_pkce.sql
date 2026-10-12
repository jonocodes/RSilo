-- PKCE (RFC 7636, S256 only): an authorization code remembers the challenge it
-- was requested with, and the token endpoint redeems it only with the matching
-- code_verifier. NULL for codes requested without PKCE.
ALTER TABLE oauth_codes ADD COLUMN code_challenge TEXT;
ALTER TABLE oauth_codes ADD COLUMN code_challenge_method TEXT;
