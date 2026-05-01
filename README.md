# RSilo

A [RemoteStorage.io](https://remotestorage.io)-compatible personal cloud storage server for Cloudflare Workers, with a built-in web file manager and OAuth server.

## What is RemoteStorage?

RemoteStorage is an open protocol for syncing app data across devices. Apps like note-takers, todo lists, and editors store data in your own server rather than a vendor's cloud.

- **WebFinger** advertises your storage and auth endpoints
- **OAuth 2.0** scopes grant apps access to specific modules
- **HTTP REST** reads and writes files under `/:username/:module/:path`

## Quick Start (offline dev)

```bash
bun install
bun run db:setup:local   # creates DB + storage directory
bun run dev:offline
```

Server runs at `http://localhost:8787`. No Cloudflare account needed.

Go to `http://localhost:8787/admin/` to manage users (default admin secret: `admin`, or set `ADMIN_SECRET` in `.dev.vars`). Create a user there, then sign in at `http://localhost:8787/account`.

To use a different admin secret:

```bash
ADMIN_SECRET=mysecret bun run db:setup:local
```

### Use the storage API directly

```bash
# Dev token — no OAuth needed for testing
TOKEN="eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhbGljZSIsInNjb3BlcyI6ImRvY3VtZW50czpydyBwaWN0dXJlczpydyIsImlhdCI6MTcwNjAwMDAwMDAsImV4cCI6OTk5OTk5OTk5OX0."

# Upload
curl -X PUT http://localhost:8787/storage/alice/documents/hello.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -d "Hello, RemoteStorage!"

# Download
curl http://localhost:8787/storage/alice/documents/hello.txt \
  -H "Authorization: Bearer $TOKEN"

# List folder
curl http://localhost:8787/storage/alice/documents/ \
  -H "Authorization: Bearer $TOKEN"

# Delete
curl -X DELETE http://localhost:8787/storage/alice/documents/hello.txt \
  -H "Authorization: Bearer $TOKEN"
```

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                      │
│                                                           │
│  ┌──────────┐ ┌───────┐ ┌─────────┐ ┌───────┐ ┌───────┐ │
│  │WebFinger │ │ OAuth │ │ Storage │ │ Admin │ │Account│ │
│  └──────────┘ └───────┘ └─────────┘ └───────┘ └───────┘ │
└──────────────────────────────────────────────────────────┘
         │                    │                │
    ┌────▼────┐          ┌────▼────┐    ┌──────▼──────┐
    │   R2    │          │   D1    │    │  KV (rate)  │
    └─────────┘          └─────────┘    └─────────────┘
```

For offline development: R2 → local filesystem, D1 → SQLite.

## API Endpoints

### Storage

```
GET    /storage/:username/*        Get file or folder listing
PUT    /storage/:username/*        Create or update a file
DELETE /storage/:username/*        Delete a file
HEAD   /storage/:username/*        Get metadata only
```

Requires `Authorization: Bearer <token>` with appropriate scope.

### WebFinger (discovery)

```
GET    /.well-known/webfinger?resource=acct:alice@example.com
GET    /.well-known/host-meta
GET    /webfinger/jrd
GET    /webfinger/xrd
```

### OAuth

```
GET    /oauth/:user                 OAuth discovery document
GET    /oauth/:user/authorize       Login and consent form
POST   /oauth/:user/authorize       Submit login or consent
POST   /oauth/:user/token           Exchange code or refresh token
```

### Admin

```
GET    /admin/                      Dashboard (HTML)
GET    /admin/health                Health check
GET    /admin/stats                 Usage statistics
GET    /admin/users                 List all users
GET    /admin/users/:username       Get user details
POST   /admin/users                 Create a user
PATCH  /admin/users/:username/quota Update storage quota
PATCH  /admin/users/:username/password Change password
```

Optionally requires `Authorization: Bearer <ADMIN_SECRET>`. Set `ADMIN_SECRET` in env to enable.

### Account

```
GET    /account                       Login page
POST   /account/login                 Sign in with username/password
POST   /account/logout                Sign out
GET    /account/browse                Browse root storage
GET    /account/browse/*              Browse a subfolder
GET    /account/download/*            Download a file
POST   /account/upload/*              Upload files to a folder
POST   /account/delete/*              Delete a file
GET    /account/tokens                View OAuth tokens
POST   /account/tokens/:id/revoke     Revoke a token
```

Cookie-based session (8-hour expiry, HttpOnly, SameSite=Lax).

## Authentication

### OAuth flow (production)

1. App queries WebFinger to discover auth and storage endpoints
2. App redirects user to `/oauth/:user/authorize?client_id=...&redirect_uri=...&response_type=code&scope=documents:rw`
3. User enters password, reviews scope, approves
4. Server redirects back with `?code=...`
5. App exchanges code at `/oauth/:user/token` → gets `access_token` + `refresh_token`
6. App uses `Authorization: Bearer <access_token>` on storage requests

Both `response_type=code` (authorization code) and `response_type=token` (implicit) are supported.

### Dev tokens (testing only)

Unsigned JWTs — accepted by the server when no DB token matches. Never use in production.

```typescript
import { createTestToken } from './src/index';
const token = createTestToken('alice', 'documents:rw pictures:rw');
```

Or construct manually:

```bash
HEADER="eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0"
PAYLOAD=$(echo -n '{"sub":"alice","scopes":"documents:rw pictures:rw","iat":1706000000,"exp":9999999999}' \
  | base64 -w0 | tr '+/' '-_' | tr -d '=')
TOKEN="${HEADER}.${PAYLOAD}."
```

## Storage Scopes

Scopes are per-module and grant read (`r`) or read-write (`rw`) access:

| Scope | Access |
|-------|--------|
| `documents:rw` | Read and write the `documents` module |
| `pictures:r` | Read-only access to `pictures` |
| `*:rw` | Read and write all modules |

Module names are arbitrary — any name works. The `public` module is readable without auth (GET only, files not folders).

## Public Files

Files under the `public` module are served without authentication:

```bash
# Upload (still requires auth)
curl -X PUT http://localhost:8787/storage/alice/public/shared.txt \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/plain" \
  -d "Anyone can read this"

# Read without auth
curl http://localhost:8787/storage/alice/public/shared.txt
# → Cache-Control: public, no-cache
```

Folder listings under `/public/` still require auth.

## User Management

Users are created by an administrator — there is no self-registration.

```bash
# Create user
curl -X POST http://localhost:8787/admin/users \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"secretpass"}'

# Change password
curl -X PATCH http://localhost:8787/admin/users/alice/password \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"password":"newpass"}'

# Update quota (bytes)
curl -X PATCH http://localhost:8787/admin/users/alice/quota \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"quota":10737418240}'
```

Or use the dashboard at `/admin/`.

## Offline Development

```bash
bun run db:setup:local   # create local SQLite DB (one time)
bun run dev:offline      # start server with live reload
```

Live reload is enabled via `bun --watch`. Storage goes to `data/storage/`, database to `data/remotestorage.db`.

## Running Tests

```bash
bun run test             # all unit tests (fast, mocked)
bun run test:watch       # watch mode
bun test test/e2e/storage-e2e.test.ts  # E2E against real server
```

**285 tests** across 13 files: protocol compliance, storage, auth, OAuth, admin, file manager, D1 adapter, and E2E.

## Production Deployment

```bash
# 1. Create Cloudflare resources
wrangler r2 bucket create remotestorage
wrangler d1 create remotestorage-db
wrangler kv namespace create RATE_LIMIT_KV

# 2. Update wrangler.toml with the IDs printed above
#    - d1_databases[0].database_id
#    - kv_namespaces[0].id

# 3. Run D1 migrations
wrangler d1 migrations apply remotestorage-db

# 4. Set secrets
wrangler secret put SESSION_SECRET   # random string, required
wrangler secret put ADMIN_SECRET     # protects /admin/*, recommended

# 5. Deploy
bun run deploy
```

| Secret | Purpose |
|--------|---------|
| `SESSION_SECRET` | Signs file manager session cookies — required |
| `ADMIN_SECRET` | Protects `/admin/*` endpoints — leave unset to allow open access |

## Known Limitations

- **No self-registration** — users are created via admin API or dashboard
- **Rate limiting** — requires a KV namespace binding; silently skipped without one
- **Single-tenant quota** — storage quota is tracked per user but not enforced on concurrent writes

## References

- [RemoteStorage Protocol Spec](https://remotestorage.io/protocol.html)
- [RemoteStorage.js (client library)](https://remotestorage.io/integrate/)
- [Armadietto (Node.js reference impl)](https://github.com/remotestorage/armadietto)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
