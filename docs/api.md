# API reference

The complete surface of the RSilo server. This file is generated from the running
app — the interactive view is at `GET /api`, the raw spec at `GET /openapi.json`.

<!-- BEGIN GENERATED API REFERENCE -->

### Storage

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/storage/{username}/{path}` | `Bearer` | Get a file or folder listing |
| `PUT` | `/storage/{username}/{path}` | `Bearer` | Create or update a file |
| `DELETE` | `/storage/{username}/{path}` | `Bearer` | Delete a file |
| `HEAD` | `/storage/{username}/{path}` | `Bearer` | Get file metadata only |

### Public files

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/storage/{username}/public` |  | Redirect to the public folder |
| `GET` | `/storage/{username}/public/{path}` |  | Read a public file |

### WebFinger

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/.well-known/host-meta` |  | host-meta XRD document |
| `GET` | `/.well-known/webfinger` |  | WebFinger discovery |
| `GET` | `/webfinger/jrd` |  | JRD discovery |
| `GET` | `/webfinger/xrd` |  | XRD discovery |

### OAuth

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/oauth/{user}` |  | OAuth discovery document |
| `GET` | `/oauth/{user}/authorize` |  | Login and consent form |
| `POST` | `/oauth/{user}/authorize` |  | Submit login or consent |
| `POST` | `/oauth/{user}/token` |  | Exchange code or refresh token |

### Account

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/account` |  | Login page |
| `GET` | `/account/browse` |  | Browse the storage root |
| `GET` | `/account/browse/{path}` |  | Browse a folder |
| `GET` | `/account/client.js` |  | Account UI script |
| `POST` | `/account/delete/{path}` |  | Delete a file |
| `GET` | `/account/download/{path}` |  | Download a file |
| `POST` | `/account/login` |  | Sign in with username/password |
| `POST` | `/account/logout` |  | Sign out |
| `POST` | `/account/save/{path}` |  | Save edits to a text file |
| `GET` | `/account/tokens` |  | View OAuth tokens |
| `POST` | `/account/tokens/{id}/revoke` |  | Revoke a token |
| `POST` | `/account/upload/{path}` |  | Upload files to a folder |
| `GET` | `/account/view/{path}` |  | View a text file |

### Admin

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/admin` | `ADMIN_SECRET` | Dashboard |
| `GET` | `/admin/health` | `ADMIN_SECRET` | Health check |
| `GET` | `/admin/login` |  | Admin login page |
| `POST` | `/admin/login` |  | Sign in (sets session cookie) |
| `POST` | `/admin/logout` |  | Sign out |
| `GET` | `/admin/stats` | `ADMIN_SECRET` | Usage statistics |
| `DELETE` | `/admin/tokens/{id}` | `ADMIN_SECRET` | Revoke a token |
| `GET` | `/admin/users` | `ADMIN_SECRET` | List all users |
| `POST` | `/admin/users` | `ADMIN_SECRET` | Create a user |
| `GET` | `/admin/users/{username}` | `ADMIN_SECRET` | Get user details |
| `DELETE` | `/admin/users/{username}` | `ADMIN_SECRET` | Delete a user |
| `PATCH` | `/admin/users/{username}/password` | `ADMIN_SECRET` | Change a user password |
| `PATCH` | `/admin/users/{username}/quota` | `ADMIN_SECRET` | Update storage quota |

### Debug

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/admin/debug/echo` | `ADMIN_SECRET` | Echo a request; parse a storage path scope |
| `POST` | `/admin/debug/echo` | `ADMIN_SECRET` | Echo a request body |
| `GET` | `/admin/debug/env` | `ADMIN_SECRET` | Redacted runtime and bindings |
| `GET` | `/admin/debug/health/deep` | `ADMIN_SECRET` | Live round-trip check of each binding |
| `GET` | `/admin/debug/oauth` | `ADMIN_SECRET` | OAuth clients, tokens and pending codes |
| `GET` | `/admin/debug/storage/{username}` | `ADMIN_SECRET` | Actual storage vs DB counter |
| `GET` | `/admin/debug/token` | `ADMIN_SECRET` | Introspect a storage/OAuth token |
| `POST` | `/admin/debug/token` | `ADMIN_SECRET` | Introspect a token (body) |

### Meta

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/` |  | Landing page |
| `GET` | `/health` |  | Liveness check |

<!-- END GENERATED API REFERENCE -->

## Notes

**Storage.** Requires `Authorization: Bearer <token>` with appropriate scope. Paths ending in `/` are folders. Downloads stream from object storage. Upload request bodies are read with a hard size bound and then buffered so RSilo can reserve the exact size delta before writing; the default limit is 10 MiB. PUT, account upload/save, and delete operations update per-user usage through the same quota-aware path. Reservations are atomic and are rolled back if object storage fails.

**WebFinger / OAuth.** Endpoints are listed above; the flow is documented under [Authentication](../README.md#authentication) in the README.

**Admin.** Requires `Authorization: Bearer <ADMIN_SECRET>`. The dashboard uses a session cookie (8-hour expiry, HttpOnly, SameSite=Strict) after login. User deletion is an immediate purge: RSilo deletes every stored object, then transactionally revokes OAuth codes, tokens, and clients and removes the user. If storage cleanup fails, the user row is retained and the username cannot be reused until a retry succeeds.

**Debug (observability).** Read-only endpoints for diagnosing a running instance. They live under `/admin`, so they inherit the same `ADMIN_SECRET` gate; secret values are never returned (booleans only). `/admin/debug/storage/:user` recomputes usage by listing objects, which is an R2 **Class A** operation — call it on demand, not on a timer. `drift_bytes = actual_bytes - db_used_storage_bytes`; a positive value means the denormalised counter under-reports (quota is being under-enforced). `/admin/debug/echo` redacts `Authorization`, `Cookie` and `X-RS-Token`; to introspect a storage token pass it as `?token=` (or the `X-RS-Token` header), not as `Authorization`, which the admin gate consumes.

```bash
# Who is this token, and what can it do?
TOKEN="$(bun run dev-token alice 'documents:rw')"
curl "http://localhost:8787/admin/debug/token?token=$TOKEN&scope=documents:rw&scope=pictures:r"

# Does the DB usage counter match what is actually in storage?
curl http://localhost:8787/admin/debug/storage/alice

# Are R2, D1 and KV actually reachable?
curl http://localhost:8787/admin/debug/health/deep

# What scope would a request to this URL need?
curl "http://localhost:8787/admin/debug/echo?path=/storage/alice/documents/note.txt&method=PUT"
```

**Account.** Cookie-based session (8-hour expiry, HttpOnly, SameSite=Lax). Sign in at `/account/login`; the UI script is served at `/account/client.js`.
