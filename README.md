# RSilo

> **Canonical repository:** [jonocodes/RSilo on GitHub](https://github.com/jonocodes/RSilo). The Codeberg mirror is deprecated.

A [RemoteStorage.io](https://remotestorage.io)-compatible personal storage server that runs on Cloudflare Workers, with a built-in web file manager and OAuth server.

**Why this exists:** to give anyone — especially people who aren't technical — their own free, self-hosted place to back up and sync app data. One person, a small amount of data, no monthly bill, no vendor lock-in. Multi-user is supported, but a personal single-user setup is the intended path.

## What is RemoteStorage?

RemoteStorage is an open protocol for syncing app data across devices. A server advertises where data lives, apps ask for permission to a module (like `documents` or `pictures`), then read/write files over plain HTTP.

- **WebFinger** advertises your storage and auth endpoints
- **OAuth 2.0** scopes grant apps access to specific modules
- **HTTP REST** reads and writes files under `/storage/:username/:module/:path`

## Where to start

| If you want to… | Go to |
|-----------------|-------|
| Run your own server and connect your apps | [For admins](#for-admins-run-your-own-server) |
| Work on the code, extend it, or read the API | [For developers](#for-developers) |

---

# For admins: run your own server

This is for the person who owns the server. You deploy it once, create your account, then connect apps. You do not need to be technical or understand Cloudflare internals — the sections below walk you through it, and `bun run setup` does most of the work.

## What you get

- **Web file manager** at `/account` — browse, upload, download, delete, and view files
- **Admin dashboard** at `/admin` — create users, set storage quotas, and review/revoke app access
- **OAuth + WebFinger** so RemoteStorage apps can connect
- **Public sharing** through the `public` module
- Everything fits inside Cloudflare's **free tier** (see [Running on the Cloudflare free tier](#running-on-the-cloudflare-free-tier))

## Deploy it

The service runs as a single Cloudflare Worker with three bindings: **R2** (file storage), **D1** (users and tokens) and **KV** (rate limiting).

### Option A — Deploy to Cloudflare button (no CLI)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jonocodes/RSilo)

Clicking the button clones the repo into your account, asks you to name the Worker and its resources, **provisions R2/D1/KV automatically**, runs migrations, deploys, and lets you set the secrets on the setup page. This is the friendliest path if you have never used Cloudflare before.

### Option B — Command line

Prerequisites: a Cloudflare account with **R2 enabled** (R2 requires a payment method on file), plus `bun` and `wrangler`.

The easiest way is the bundled setup script, which logs in, creates the resources, patches `wrangler.toml`, runs migrations, generates secrets, and deploys:

```bash
bun install
wrangler login
bun run setup
```

It prints your server URL and the generated admin secret at the end. Prefer to drive it yourself? See the manual steps below.

<details>
<summary>Manual CLI steps</summary>

```bash
bun install
wrangler login          # or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID

# Create the resources
wrangler r2 bucket create remotestorage
wrangler d1 create remotestorage-db
wrangler kv namespace create RATE_LIMIT_KV
# put the printed IDs into wrangler.toml (database_id, kv id)

# Migrate and deploy
wrangler d1 migrations apply remotestorage-db --remote
bun run deploy

# Secrets
wrangler secret put SESSION_SECRET   # bun run secret
wrangler secret put ADMIN_SECRET     # bun run secret
wrangler secret put JWT_SECRET       # bun run secret
```

Alternatively, delete the `database_id`, `bucket_name` and KV `id` lines from `wrangler.toml` and run `wrangler deploy` — wrangler will provision the resources and write their IDs back — then `bun run db:migrate:remote`.

</details>

| Secret | Purpose |
|--------|---------|
| `SESSION_SECRET` | Signs file manager and OAuth session cookies — required |
| `ADMIN_SECRET` | Protects `/admin/*` endpoints — leave unset to allow open access |
| `JWT_SECRET` | If set, disables unsigned dev tokens and enables signed JWT verification |

Generate any of them with `bun run secret`.

## Create your account and sign in

1. Open `https://<your-worker>.workers.dev/admin/` and sign in with `ADMIN_SECRET`.
2. Create yourself a user (username `[a-z0-9_.-]+`, password ≥ 8 characters).
3. Go to `/account` and sign in with that username and password.

## Change a password

There is no self-service form yet, so passwords are changed with the admin API. On a single-user instance you are the admin, so this is how you change your own:

```bash
curl -X PATCH https://<your-worker>.workers.dev/admin/users/alice/password \
  -H "Authorization: Bearer <ADMIN_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"password":"newpass123"}'   # at least 8 characters
```

Existing app tokens (authorizations) keep working after a password change — revoke any you no longer want from `/admin` (Authorized apps) or `/account/tokens`.

## Connect a RemoteStorage app

Apps do **not** need any setup on your side — there is no client registration step. The first time an app asks for access it is registered automatically and appears in the admin dashboard.

1. In the app, enter your server address (e.g. `https://<your-worker>.workers.dev`).
2. The app discovers your endpoints via WebFinger and sends you to the OAuth consent page.
3. Sign in, check the app name and **where it redirects to**, and approve the requested module permissions.
4. The app gets a token and starts syncing into that module.

You can review and revoke an app's access from `/admin` (Authorized apps) or `/account/tokens`.

## Share a file publicly

Files written under `public/<module>/` are readable by anyone — no token needed. Folder listings still require auth. The write uses the same `<module>` scope as the private data:

```bash
bun run dev-token alice 'documents:rw'
# then PUT to /storage/alice/public/documents/hello.txt and GET it without auth
```

## Managing multiple users (optional)

Single-user is the common case. If you want more, create users from the dashboard or the admin API — see [For developers → User management](#admin). Each user gets their own namespace under `/storage/:username/`.

## Running on the Cloudflare free tier

RSilo is built for a *small personal backup*, not a business service — and it fits comfortably inside Cloudflare's free tier.

**The one thing to watch: R2 is the only part that can ever cost money.** Workers, D1, and KV simply stop working once their free limits are reached. R2 instead bills overage once you pass its free allowance — and because Cloudflare requires a payment method to enable R2, that overage is charged automatically.

As of **October 2026**, R2's free tier covers roughly **10 GB of storage**, **1 million writes/listings**, and **10 million reads** per month, with free egress. Cloudflare changes these numbers and prices over time, so treat them as a rough guide and check the current values on the [R2 pricing page](https://developers.cloudflare.com/r2/pricing/). For a personal notes/todos/photos backup this allowance is far more than you will use.

Roughly, uploads and folder listings count as "writes" (Class A), downloads and metadata as "reads" (Class B), and deletes are free.

### Staying free

1. **Stay on the Workers Free plan.** Free Workers hard-stop at their daily request limit; the Paid plan auto-bills overages with no hard switch.
2. **Keep the bucket private.** Do not enable the r2.dev public URL or attach a custom domain to the bucket. RSilo serves everything through the Worker (including the `public` module), and R2 does not bill unauthorized requests. A public bucket would also let callers bypass the Worker entirely.
3. **Use Standard storage only.** Infrequent Access has no free tier and bills from the first operation — even from viewing the bucket in the dashboard.
4. **Set a budget alert as an early warning.** In the Cloudflare dashboard go to **Manage Account → Billing → Billable Usage → Create budget alert** (or **Notifications → Add → Budget Alert**) and set a low threshold. You'll get an email if spend starts to rise. It is only a warning — Cloudflare has no built-in hard spending cap for R2, and per-product billing notifications require a Professional plan or higher.
5. **For a hard guarantee, cap usage in the Worker.** Since every write goes through `PUT /storage/...`, a global storage ceiling plus a monthly Class A operation counter is the only way to make $0 a certainty. Not implemented yet.

> RemoteStorage clients never talk to R2 directly — they speak HTTP to the Worker, which reaches R2 through the binding. "Private bucket" and working RemoteStorage clients are not in conflict.

---

# For developers

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

For offline development: R2 → local filesystem, D1 → SQLite (via a D1-compatible adapter), KV → absent.

The routes talk to storage through a small `StorageInterface`. In production `getStorage()` wraps the raw R2 binding in `R2Storage`; offline it returns the `LocalStorage` instance directly. See `src/services/r2.ts`.

## Local development (offline)

No Cloudflare account needed:

```bash
bun install
bun run db:setup:local   # creates data/remotestorage.db + data/storage/
bun run dev:offline      # http://localhost:8787 with live reload
```

`ADMIN_SECRET` defaults to `admin` offline; set it in `.dev.vars` or the environment to change it. `bun run dev` runs `wrangler dev` instead, which emulates R2/D1/KV locally.

## API reference

### Storage

```
GET    /storage/:username/*        Get file or folder listing
PUT    /storage/:username/*        Create or update a file
DELETE /storage/:username/*        Delete a file
HEAD   /storage/:username/*        Get metadata only
```

Requires `Authorization: Bearer <token>` with appropriate scope. Paths ending in `/` are folders.

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

Optionally requires `Authorization: Bearer <ADMIN_SECRET>`. The dashboard uses a session cookie (8-hour expiry, HttpOnly, SameSite=Strict) after login.

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
5. App exchanges code at `/oauth/:user/token` → `access_token` (1-hour expiry) + `refresh_token`
6. App uses `Authorization: Bearer <access_token>` on storage requests
7. When the access token expires, exchange the refresh token at `/oauth/:user/token` with `grant_type=refresh_token`

Both `response_type=code` (authorization code) and `response_type=token` (implicit) are supported.

### Dev tokens (testing only)

Unsigned JWTs, accepted only when `JWT_SECRET` is **not** set. Setting `JWT_SECRET` disables them entirely — never rely on them in production. Generate one with:

```bash
TOKEN="$(bun run dev-token alice 'documents:rw pictures:rw')"
```

`createTestToken(username, scopes)` is also exported from `src/index.ts` if you need it in code.

## Storage scopes

Scopes are per-module and grant read (`r`) or read-write (`rw`) access:

| Scope | Access |
|-------|--------|
| `documents:rw` | Read and write the `documents` module |
| `pictures:r` | Read-only access to `pictures` |
| `*:rw` | Read and write all modules |

Module names are arbitrary — any name works. Files under `public/<module>/` are readable without auth (files only; folder listings require auth).

### Public files

```bash
TOKEN="$(bun run dev-token alice 'documents:rw')"

# Upload (still requires auth, using the module's scope)
curl -X PUT http://localhost:8787/storage/alice/public/documents/shared.txt \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/plain" \
  -d "Anyone can read this"

# Read without auth
curl http://localhost:8787/storage/alice/public/documents/shared.txt
# → Cache-Control: no-cache
```

### User management (admin API)

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
  -d '{"password":"newpass123"}'

# Update quota (bytes)
curl -X PATCH http://localhost:8787/admin/users/alice/quota \
  -H "Authorization: Bearer $ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"quota":10737418240}'
```

## Project layout

```
src/
  index.ts            Worker entry (Hono app)
  server-offline.ts   Offline dev server (Node + local filesystem/SQLite)
  routes/             storage, webfinger, oauth, admin, account
  services/           auth, r2 (+ getStorage adapter), local-storage, db/
  middleware/         auth, cors
  protocol/           constants (ETag normalisation, path validation)
  scripts/            setup-local-db, dev-token
drizzle/migrations/   D1 migrations
test/                 unit, compliance and E2E suites
```

## Testing

```bash
bun run test             # all tests (fast, mocked + offline server E2E)
bun run test:watch       # watch mode
bun run typecheck        # tsc --noEmit
bun run lint             # eslint src
bun test test/e2e/storage-e2e.test.ts  # E2E against real server
```

**342 tests** across 19 files: protocol compliance (RemoteStorage, WebFinger, edge cases), storage, auth, OAuth, admin, file manager, D1 adapter, migration/schema checks, and E2E against the offline server.

## Known limitations

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
