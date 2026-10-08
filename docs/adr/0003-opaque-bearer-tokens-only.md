# Access tokens are opaque bearer tokens only

Storage authentication accepted two token forms: opaque rows in `oauth_tokens` (what the OAuth flow actually issues) and self-contained JWTs signed with `JWT_SECRET`. We decided to keep only the opaque form and drop the signed-JWT path. The remoteStorage spec's own model is opaque bearer tokens, opaque tokens are revocable the instant the row is deleted, and removing the JWT path means the application holds no secrets of its own.

Status: accepted

## Consequences

- `JWT_SECRET`, `verifyToken`, and `createTestToken` are removed; tests and the dev-token script seed opaque token rows (or use dev mode) instead.
- Every storage request performs one D1 lookup; acceptable for a single-user instance.
- Per-instance production configuration reduces to the Access variables; there are no application-held secrets.
