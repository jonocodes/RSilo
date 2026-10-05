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
DELETE /admin/users/:username       Delete a user
PATCH  /admin/users/:username/quota Update storage quota
PATCH  /admin/users/:username/password Change password
GET    /admin/login                 Admin login page
POST   /admin/login                 Sign in (sets session cookie)
POST   /admin/logout                Sign out
```

Optionally requires `Authorization: Bearer <ADMIN_SECRET>`. Set `ADMIN_SECRET` in env to enable. The dashboard uses a session cookie (8-hour expiry, HttpOnly, SameSite=Strict) after login.

### Account

```
GET    /account                       Login page
POST   /account/login                 Sign in with username/password
POST   /account/logout                Sign out
GET    /account/browse                Browse root storage
GET    /account/browse/*              Browse a subfolder
GET    /account/view/*                View a text file in browser
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
5. App exchanges code at `/oauth/:user/token` → gets `access_token` (1-hour expiry) + `refresh_token`
6. App uses `Authorization: Bearer <access_token>` on storage requests
7. When the access token expires, exchange the refresh token at `/oauth/:user/token` with `grant_type=refresh_token`

Both `response_type=code` (authorization code) and `response_type=token` (implicit) are supported.

### Dev tokens (testing only)

Unsigned JWTs — accepted only when `JWT_SECRET` is **not** set in the environment. Setting `JWT_SECRET` disables them entirely. Never use in production.

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

Username must match `[a-z0-9_.-]+` and password must be at least 8 characters.

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
bun run test             # all tests (fast, mocked + offline server E2E)
bun run test:watch       # watch mode
bun run typecheck        # tsc --noEmit
bun run lint             # eslint src
bun test test/e2e/storage-e2e.test.ts  # E2E against real server
```

**339 tests** across 18 files: protocol compliance (RemoteStorage, WebFinger, edge cases), storage, auth, OAuth, admin, file manager, D1 adapter, and E2E against the offline server.

## Production Deployment

```bash
# 0. Enable R2 in the dashboard first (it requires a payment method on file)

# 1. Create Cloudflare resources
wrangler r2 bucket create remotestorage
wrangler d1 create remotestorage-db
wrangler kv namespace create RATE_LIMIT_KV

# 2. Update wrangler.toml with the IDs printed above
#    - d1_databases[0].database_id
#    - kv_namespaces[0].id
#    (migrations_dir is already set to drizzle/migrations)

# 3. Run D1 migrations
wrangler d1 migrations apply remotestorage-db --remote

# 4. Set secrets
wrangler secret put SESSION_SECRET   # random string, required
wrangler secret put ADMIN_SECRET     # protects /admin/*, recommended
wrangler secret put JWT_SECRET       # disables unsigned dev tokens, recommended in production

# 5. Deploy
bun run deploy
```

| Secret | Purpose |
|--------|---------|
| `SESSION_SECRET` | Signs file manager and OAuth session cookies — required |
| `ADMIN_SECRET` | Protects `/admin/*` endpoints — leave unset to allow open access |
| `JWT_SECRET` | If set, disables unsigned dev tokens and enables signed JWT verification |

## Running on the Cloudflare Free Tier

RSilo is sized to fit inside Cloudflare's free allowances with room to spare. The one thing to understand: **R2 is the only product here that can bill you on overage.** Workers, D1, and KV simply stop working when their free limits are reached, but R2 charges per GB-month and per operation once you pass its free tier — and R2 requires a payment method on file to enable, so overage is charged automatically.

### Free allowances

| Product | Free allowance | When exceeded |
|---------|----------------|---------------|
| Workers | 100,000 requests/day, 10 ms CPU/invocation | Hard stop (errors), no charge |
| R2 storage | 10 GB-month (Standard class only) | $0.015 / GB-month |
| R2 Class A operations | 1,000,000 / month | $4.50 / million |
| R2 Class B operations | 10,000,000 / month | $0.36 / million |
| R2 egress | Unlimited | Free |
| D1 | 5 GB storage, 5M rows read/day, 100k rows written/day | Errors on the Free plan |
| KV | 100k reads/day, 1k writes/day, 1 GB | Errors on the Free plan |

### How RSilo maps to R2 operation classes

| Client action | R2 call | Class |
|---------------|---------|-------|
| Upload a file (`PUT /storage/...`) | `PutObject` | A |
| List a folder (`GET /storage/.../`) | `ListObjects` | A |
| Download a file (`GET /storage/...`) | `GetObject` | B |
| Read metadata (`HEAD /storage/...`) | `HeadObject` | B |
| Delete a file (`DELETE /storage/...`) | `DeleteObject` | free |

### Keeping the bill at $0

1. **Stay on the Workers Free plan.** Free Workers hard-stop at 100k requests/day; the Paid plan auto-bills overages with no hard switch.
2. **Keep the bucket private.** Do not enable the r2.dev public URL or attach a custom domain to the bucket. RSilo serves everything through the Worker (including the `public` module), and R2 does not bill unauthorized requests. A public bucket would also let callers bypass the Worker entirely.
3. **Use Standard storage only.** Infrequent Access has **no free tier** and bills from the first operation — even from viewing the bucket in the dashboard.
4. **Set a budget alert as an early warning.** Manage Account → Billing → Billable Usage → Create budget alert (or Notifications → Add → Budget Alert). It is **informational only** — Cloudflare offers no native hard spend cap for R2, and per-product billing notifications are only available on Professional plans or higher.
5. **For a hard guarantee, cap usage in the Worker.** Since every write goes through `PUT /storage/...`, a global storage ceiling plus a monthly Class A operation counter is the only way to make $0 a certainty. Not implemented yet.

> RemoteStorage clients never talk to R2 directly — they speak HTTP to the Worker, which reaches R2 through the binding. "Private bucket" and working RemoteStorage clients are not in conflict.

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
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
