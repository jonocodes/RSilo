# RSilo

> **Canonical repository:** [jonocodes/RSilo on GitHub](https://github.com/jonocodes/RSilo). The Codeberg mirror is deprecated.

A [RemoteStorage.io](https://remotestorage.io)-compatible personal storage server that runs on Cloudflare Workers, with a built-in web file manager and OAuth server.

**Why this exists:** to give anyone — especially people who aren't technical — their own free, self-hosted place to back up and sync app data. One person, a small amount of data, no monthly bill, no vendor lock-in. Each deployment (an *Instance*) serves exactly one *Account*; more accounts means more Instances ([ADR-0002](docs/adr/0002-instances-are-single-user.md)).

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

This is for the person who owns the server. You deploy it once, protect `/account` with Cloudflare Access, then connect apps. You do not need to be technical or understand Cloudflare internals — the sections below walk you through it, and `bun run setup` does most of the work. There is no RSilo password: Cloudflare Access signs you in.

## What you get

- **Your account area** at `/account` — a dashboard with your storage address, quota usage and setting, and the apps you have granted access (revocable), plus a file manager to browse, upload, download, view, edit, and delete files
- **API reference** at `/api` — a generated page listing every endpoint the server exposes
- **OAuth + WebFinger** so RemoteStorage apps can connect
- **Public sharing** through the `public` module
- Everything fits inside Cloudflare's **free tier** (see [Running on the Cloudflare free tier](#running-on-the-cloudflare-free-tier))

## Deploy it

The service runs as a single Cloudflare Worker with two provisioned resources: **R2** (file storage) and **D1** (users and tokens). Rate limiting uses Cloudflare's native rate-limit bindings, which are declared in `wrangler.toml` and need no setup.

### Option A — Deploy to Cloudflare button (no CLI)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jonocodes/RSilo)

Clicking the button clones the repo into your account, asks you to name the Worker and its resources, **provisions R2 and D1 automatically**, runs migrations, and deploys. This is the friendliest path if you have never used Cloudflare before.

The committed `wrangler.toml` ships **placeholder** resource IDs so Cloudflare can detect and replace them with real ones in your account. Never commit your own IDs there — see [Deploying updates](#deploying-updates-to-your-own-instance).

### Option B — Command line

Prerequisites: a Cloudflare account with **R2 enabled** (R2 requires a payment method on file), plus `bun` and `wrangler`.

The easiest way is the bundled setup script, which logs in, creates the resources, writes a gitignored `wrangler.prod.toml` with their real IDs, runs migrations, and deploys:

```bash
bun install
wrangler login
bun run setup
```

It prints your server URL at the end. Prefer to drive it yourself? See the manual steps below.

<details>
<summary>Manual CLI steps</summary>

```bash
bun install
wrangler login          # or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID

# Create the resources
wrangler r2 bucket create remotestorage
wrangler d1 create remotestorage-db
# copy wrangler.toml to wrangler.prod.toml (gitignored) and put the
# printed database_id there

# Migrate and deploy (bun run deploy auto-detects wrangler.prod.toml)
bun run deploy
```

Then set `ACCOUNT_USERNAME`, `OWNER_EMAIL` and `PUBLIC_BASE_URL` as described in [Instance configuration](#instance-configuration).

Alternatively, let wrangler provision the resources: delete the `database_id` line from `wrangler.prod.toml` and run `bun run deploy`. Wrangler creates the resources on first deploy; because `wrangler.toml`/`.prod.toml` are TOML, it will not write the new IDs back, so copy it from `wrangler d1 list` if you need them later.

</details>

RSilo needs no secrets. Cloudflare Access signs you in to `/account`, and storage access tokens are opaque values stored in D1 (see [Authentication](#authentication)).

`MAX_OBJECT_SIZE_BYTES` optionally sets the maximum stored-object size. It defaults to 10 MiB and must be a positive integer.

### Instance configuration

Three plain (non-secret) variables identify the Instance. All are **required in production**; set them in the Cloudflare dashboard (**Workers & Pages → your Worker → Settings → Variables and Secrets**, type *Text*) or under `[vars]` in your `wrangler.prod.toml`. Without them every discovery, OAuth and storage request returns `503` with a message naming what is missing, and `/account` shows a *finish setup* page listing them.

| Variable | Purpose | Dev-mode default |
|----------|---------|------------------|
| `ACCOUNT_USERNAME` | The one Account this Instance serves (`[a-z0-9_.-]+`). It names the storage root `/storage/<ACCOUNT_USERNAME>/` and is never derived from an email address. | `alice` |
| `OWNER_EMAIL` | Your email address, exactly as your Cloudflare Access sign-in method reports it (the one-time-PIN address, or your Google/GitHub email — not necessarily your Cloudflare login). Only this identity (case-insensitive) may use `/account`. | `alice@example.com` |
| `PUBLIC_BASE_URL` | The origin apps reach the Instance at, e.g. `https://rsilo.<subdomain>.workers.dev` (no path). Every advertised URL — WebFinger, host-meta, the `/oauth/:user` discovery JSON, the consent URL and the storage root — is built from it, never from the request's `Host` or `X-Forwarded-Proto`. | `http://localhost:8787` (offline: `http://localhost:$PORT`) |

The dev-mode defaults apply only when `RSILO_DEV_MODE=true`; an invalid value (for example a `PUBLIC_BASE_URL` with a path) is rejected even in dev mode.

**The Account row.** The first request that needs it creates the `users` row for `ACCOUNT_USERNAME` (an idempotent insert; the check is cached per Worker isolate). If that row is missing **and** the table already holds other users — you changed `ACCOUNT_USERNAME`, or migrated a multi-user deployment — RSilo will not create a second row: storage returns `503` and `/account` and the consent page show a *username mismatch* message. Set `ACCOUNT_USERNAME` to the existing account you want to keep. Other rows are ignored, not deleted.

### Deploying updates to your own instance

The committed `wrangler.toml` holds placeholder IDs so the Deploy to Cloudflare button works for everyone. Your real, account-specific IDs live in the gitignored `wrangler.prod.toml`, written by `bun run setup`.

`bun run deploy` uses `wrangler.prod.toml` automatically when it exists, so shipping an update is just:

```bash
bun run deploy
```

If `wrangler.prod.toml` is missing, it falls back to the committed `wrangler.toml` — the path Cloudflare's button uses, where the IDs are injected for you. To rebuild the prod config after provisioning new resources, re-run `bun run setup` (or copy `wrangler.toml` and paste in the IDs by hand).

### Automatic deploys (Cloudflare Workers Builds)

To release on every push to `main`, connect the repository to your Worker using Cloudflare's native Git integration — Cloudflare then owns the deploy token, so nothing needs to live in GitHub.

1. Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings → Builds** → connect the Git repository.
2. Set the **production branch** to `main`, and leave preview builds off (or on) as you prefer.
3. Set the **deploy command** to:

   ```bash
   bun run deploy
   ```

4. Under **Build variables**, add `D1_DATABASE_ID` (the value from your `wrangler.prod.toml`), marked as a secret. This is the only thing not in git; `bun run deploy` materialises `wrangler.prod.toml` from it, applies D1 migrations, and deploys.

`bun run deploy` uses the same entry point in both places, so local and CI deploys stay identical.

## Protect `/account` with Cloudflare Access and sign in

RSilo stores no passwords. Cloudflare Access (part of Zero Trust, free for a single person, no payment method needed) signs you in, and RSilo checks that the signed-in email is `OWNER_EMAIL`.

1. Set `ACCOUNT_USERNAME`, `OWNER_EMAIL` and `PUBLIC_BASE_URL` (see [Instance configuration](#instance-configuration)).
2. In the Cloudflare dashboard open **Zero Trust** and pick the free plan if asked.
3. **Access → Applications → Add an application → Self-hosted.** Set the domain to `<worker>.<subdomain>.workers.dev` and the path to `account`. No custom domain is needed.
4. Add an **Allow** policy that includes exactly your email (the same as `OWNER_EMAIL`), and choose an identity method — a one-time PIN sent to your email works.
5. Open `https://<worker>.<subdomain>.workers.dev/account`, sign in through Access, and you land on your dashboard.

Do **not** use the Worker-level "protect this Worker" toggle: it gates the whole Worker, including `/storage` and WebFinger, so apps could no longer reach your data.

Until Access is in place, `/account` shows a *finish setup* page with these steps. If you sign in with an email other than `OWNER_EMAIL` you get a "not allowed" page; if you changed the email you sign in with, update `OWNER_EMAIL` (and the Access policy) in the Cloudflare dashboard. Recovery depends only on your Cloudflare account.

**Sign out** (in the `/account` header) goes to `/cdn-cgi/access/logout`. It ends your RSilo Access session, not your login at your email or identity provider.

Every state-changing `/account` request must come from the page itself (`Sec-Fetch-Site: same-origin`, or an `Origin` equal to `PUBLIC_BASE_URL`); cross-site posts get `403`.

## Connect a RemoteStorage app

Apps do **not** need any setup on your side — there is no client registration step. The first time an app asks for access it is registered automatically and appears on your `/account` dashboard.

1. In the app, enter your storage address: either `<ACCOUNT_USERNAME>@<your-worker>.workers.dev` or, if the app supports it, just the server URL `https://<your-worker>.workers.dev`.
2. The app discovers your endpoints via WebFinger and sends you to the consent page, `/account/oauth/authorize`. It is part of `/account`, so Cloudflare Access signs you in first if you are not already.
3. The page shows the app (by its origin host), the modules it asks for and whether it wants read-only or read-write access, and **where it will send you back to**. Allow or deny.
4. The app gets a token and starts syncing into that module.

Your `/account` dashboard lists each app once, by its origin host, with the modules it can access and when it was first granted and last issued a token. **Revoke** removes all of that app's tokens at once; it loses access immediately.

Because apps are not registered in advance, an app is identified by its `client_id`, which must be an `http(s)` URL, and it may only be sent back to a `redirect_uri` on that same origin. Any other request gets a `400` error page and no redirect. If your Access session expires while the consent page is open, the approval is lost to the Access sign-in; reload the page (all its parameters are in the URL) and allow again.

## Share a file publicly

Files written under `public/<module>/` are readable by anyone — no token needed. Folder listings still require auth. The write uses the same `<module>` scope as the private data:

```bash
bun run dev-token alice 'documents:rw'
# then PUT to /storage/alice/public/documents/hello.txt and GET it without auth
```

## One Account per Instance

An Instance serves only `ACCOUNT_USERNAME`: WebFinger resolves no other user, the `/oauth/<username>/…` endpoints return `404` for any other username (consent is always for the Account), and every `/storage/<username>/…` request for another username is refused (`401` without a token, `403` with one, including anonymous `public/` reads). If you migrate a deployment that had several users, every other user's data and tokens become unreachable; their rows, R2 objects and tokens are left in place, not deleted. For a second account, deploy a second Instance.

## Running on the Cloudflare free tier

RSilo is built for a *small personal backup*, not a business service — and it fits comfortably inside Cloudflare's free tier.

**The one thing to watch: R2 is the only part that can ever cost money.** Workers and D1 simply stop working once their free limits are reached. R2 instead bills overage once you pass its free allowance — and because Cloudflare requires a payment method to enable R2, that overage is charged automatically.

As of **October 2026**, R2's free tier covers roughly **10 GB of storage**, **1 million writes/listings**, and **10 million reads** per month, with free egress. Cloudflare changes these numbers and prices over time, so treat them as a rough guide and check the current values on the [R2 pricing page](https://developers.cloudflare.com/r2/pricing/). For a personal notes/todos/photos backup this allowance is far more than you will use.

Roughly, uploads and folder listings count as "writes" (Class A), downloads and metadata as "reads" (Class B), and deletes are free.

### Staying free

1. **Stay on the Workers Free plan.** Free Workers hard-stop at their daily request limit; the Paid plan auto-bills overages with no hard switch.
2. **Keep the bucket private.** Do not enable the r2.dev public URL or attach a custom domain to the bucket. RSilo serves everything through the Worker (including the `public` module), and R2 does not bill unauthorized requests. A public bucket would also let callers bypass the Worker entirely.
3. **Use Standard storage only.** Infrequent Access has no free tier and bills from the first operation — even from viewing the bucket in the dashboard.
4. **Set a budget alert as an early warning.** In the Cloudflare dashboard go to **Manage Account → Billing → Billable Usage → Create budget alert** (or **Notifications → Add → Budget Alert**) and set a low threshold. You'll get an email if spend starts to rise. It is only a warning — Cloudflare has no built-in hard spending cap for R2, and per-product billing notifications require a Professional plan or higher.
5. **For a hard guarantee, cap usage in the Worker.** Since every write goes through `PUT /storage/...`, a global storage ceiling plus a monthly Class A operation counter is the only way to make $0 a certainty. Not implemented yet. For visibility, Cloudflare's built-in R2 metrics already break operations down by Class A/B per bucket — see the bucket's **Metrics** tab or query the `r2OperationsAdaptiveGroups` GraphQL dataset — which is enough for the intended single-user setup.

> RemoteStorage clients never talk to R2 directly — they speak HTTP to the Worker, which reaches R2 through the binding. "Private bucket" and working RemoteStorage clients are not in conflict.

---

# For developers

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                      │
│                                                           │
│  ┌──────────┐ ┌───────┐ ┌─────────┐ ┌───────┐ ┌───────┐ │
│  │WebFinger │ │ OAuth │ │ Storage │ │Account│ │ Debug │ │
│  └──────────┘ └───────┘ └─────────┘ └───────┘ └───────┘ │
└──────────────────────────────────────────────────────────┘
         │                    │                │
    ┌────▼────┐          ┌────▼────┐    ┌──────▼──────┐
    │   R2    │          │   D1    │    │ Rate limits │
    └─────────┘          └─────────┘    └─────────────┘
```

For offline development: R2 → local filesystem, D1 → SQLite (via a D1-compatible adapter), rate limiting → skipped.

The routes talk to storage through a small `StorageInterface`. In production `getStorage()` wraps the raw R2 binding in `R2Storage`; offline it returns the `LocalStorage` instance directly. See `src/services/r2.ts`.

## Local development (offline)

No Cloudflare account needed:

```bash
bun install
bun run db:setup:local   # creates data/remotestorage.db + data/storage/
bun run dev:offline      # http://localhost:8787 with live reload
```

`bun run dev:offline` explicitly enables local-development mode: the Instance serves the Account `alice` at `http://localhost:8787`, owned by `alice@example.com` (set `ACCOUNT_USERNAME` / `OWNER_EMAIL` / `PUBLIC_BASE_URL` to override; the default origin follows `PORT`). Its storage address is `alice@localhost:8787`. With no Cloudflare Access in front of it, requests to `localhost`, `127.0.0.1` or `[::1]` are signed in as a **dev identity** — `RSILO_DEV_EMAIL`, defaulting to `OWNER_EMAIL` (set it to another address to preview the "not allowed" page). The dev identity is unreachable unless `RSILO_DEV_MODE=true`, the host is local and no Access identity is present, so it cannot leak into production. The same guard exposes the debug endpoints at `/debug/*` (see [docs/api.md](docs/api.md)); in production they are a 404. `bun run dev` runs `wrangler dev`; copy `.dev.vars.example` to `.dev.vars` to configure it and explicit local-development mode.

## API reference

The server exposes one OpenAPI surface:

```
GET    /api              Scalar UI (documentation only — no request console)
GET    /openapi.json     The OpenAPI 3.1 spec
```

A static, always-current list of every endpoint lives in **[docs/api.md](docs/api.md)**. The spec is derived from `app.routes` and a metadata registry, so it cannot drift: `bun run docs:api` regenerates the static list, `bun run docs:api:check` verifies it without writing, and a test (run in CI) fails if it is stale.

## Authentication

### OAuth flow (production)

1. App queries WebFinger to discover auth and storage endpoints (see [Discovery](#discovery))
2. App redirects user to the advertised consent URL, `/account/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&scope=documents:rw&state=...`
3. The Owner reviews the requested scopes and approves (their identity comes from Cloudflare Access; see [Protect `/account`](#protect-account-with-cloudflare-access-and-sign-in)). Approve and deny are `/account` form posts, so they get the same-origin check.
4. Server redirects back with `?code=...`
5. App exchanges code at `/oauth/:user/token` → `access_token` (1-hour expiry) + `refresh_token`
6. App uses `Authorization: Bearer <access_token>` on storage requests
7. When the access token expires, exchange the refresh token at `/oauth/:user/token` with `grant_type=refresh_token`

Both `response_type=code` (authorization code) and `response_type=token` (implicit) are supported. The consent page is always for the Account, so its URL has no username; tokens are always issued for the Account, and `/oauth/:user/token` returns `404` when `:user` is not `ACCOUNT_USERNAME`. The token endpoint stays outside `/account` and is not behind Access, since apps call it directly.

Per protocol §10, `client_id` must be an `http(s)` URL and `redirect_uri` an `http(s)` URL on the same origin; otherwise the consent page (on `GET` and on approve or deny) answers `400` with a plain-text error and never redirects.

The consent page used to be `/oauth/:user/authorize`. Apps (remoteStorage.js) cache discovery results, so that URL still answers `GET` with a `302` to `/account/oauth/authorize`, passing the query string through unchanged. `POST` there returns `405`, and any `:user` other than the Account returns `404`.

### Discovery

WebFinger (`/.well-known/webfinger`, `/webfinger/jrd`, `/webfinger/xrd`) accepts exactly these resources, all resolving to the Account:

- `acct:<ACCOUNT_USERNAME>@<host>` — username and host compared case-insensitively
- the host-only form `http://<host>` or `https://<host>`, with or without a trailing slash

`<host>` must equal the `PUBLIC_BASE_URL` host, including any non-default port (`acct:alice@localhost:8787` in dev); `acct:` resources may also omit the port (`acct:alice@localhost`). Any other resource returns `404` on every discovery route, as does `/oauth/:user` for any user but the Account. All advertised URLs come from `PUBLIC_BASE_URL`, never the request's `Host` header.

```bash
curl 'http://localhost:8787/.well-known/webfinger?resource=acct:alice@localhost:8787'
curl 'http://localhost:8787/.well-known/webfinger?resource=http://localhost:8787/'
```

Access tokens are **opaque bearer tokens**: random strings stored as rows in the D1 `oauth_tokens` table. A token is valid exactly while its unexpired row exists, so revoking an app (deleting its row) takes effect on the very next request. JWTs — signed or unsigned — are never accepted, in production or in local-development mode ([ADR-0003](docs/adr/0003-opaque-bearer-tokens-only.md)).

### Dev tokens (testing only)

`bun run dev-token` inserts an opaque token row (30-day expiry) into a local database and prints the token. It creates the user and a `dev-token:<username>` client if they do not exist yet.

```bash
# Offline DB used by `bun run dev:offline` (DB_PATH, default data/remotestorage.db)
TOKEN="$(bun run dev-token alice 'documents:rw pictures:rw')"

# Local D1 used by `bun run dev` (run `bun run db:migrate` once first)
TOKEN="$(bun run dev-token --d1 alice 'documents:rw pictures:rw')"
```

Revoke a dev token like any other app: from the `/account` dashboard (its client is `dev-token:<username>`) or by deleting its row.

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
src/
  index.ts            Worker entry (Hono app)
  server-offline.ts   Offline dev server (Node + local filesystem/SQLite)
  routes/             storage, webfinger, oauth (discovery, token, legacy consent redirect), account,
                      consent (/account/oauth/authorize), debug, mount (shared route table)
  config.ts           per-Instance config (ACCOUNT_USERNAME, OWNER_EMAIL, PUBLIC_BASE_URL) and dev defaults
  services/           auth, identity (Owner resolver: Cloudflare Access or dev identity; CSRF check),
                      account (Account row lifecycle), discovery (advertised URLs, WebFinger
                      matching), r2 (+ getStorage adapter), local-storage, db/
  middleware/         auth, cors, instance (config + Account gates), owner (/account gate + CSRF)
  ui/                 account client script, setup and not-allowed pages
  protocol/           constants (ETag normalisation, path validation)
  scripts/            setup, deploy, dev-token, setup-local-db
drizzle/migrations/   D1 migrations
test/                 unit, compliance and E2E suites
```

## Testing

```bash
bun run test             # all tests (fast, mocked + offline server E2E)
bun run test:watch       # watch mode
bun run typecheck        # source tsc --noEmit
bun run typecheck:test   # test-suite tsc --noEmit
bun run lint             # eslint src and test
bun run test -- test/e2e/storage-e2e.test.ts  # one E2E suite
```

**573 tests** across 28 files: protocol compliance (RemoteStorage, WebFinger, edge cases), single-Account discovery and the Account row lifecycle, storage, auth, rate limiting, OAuth and the consent page, Cloudflare Access identity and CSRF, the account dashboard, debug/observability, wrangler config, file manager, quota accounting, D1/R2 adapters, migration/schema checks, and E2E against the offline server.

## Known limitations

- **Rate limiting is per Cloudflare location** — the native rate-limit bindings count per data centre, not globally, so a distributed attacker gets more attempts. Storage counts only failed authentication (20 per 60s per IP), so syncs with a valid token are never throttled. Production fails closed with `503` when a limiter binding is missing; local-development mode skips limiting. KV is deliberately not used: its free tier allows only 1,000 writes a day, which per-request counters exhaust in minutes (#7)
- **Buffered uploads** — upload bodies are bounded by `MAX_OBJECT_SIZE_BYTES` but buffered before storage so quota deltas can be reserved accurately; downloads stream

## References

- [RemoteStorage Protocol Spec](https://remotestorage.io/protocol.html)
- [RemoteStorage.js (client library)](https://remotestorage.io/integrate/)
- [Armadietto (Node.js reference impl)](https://github.com/remotestorage/armadietto)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
