# Development

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
    │ R2 / S3 │          │   D1    │    │ Rate limits │
    └─────────┘          └─────────┘    └─────────────┘
```

For offline development: R2 → local filesystem, D1 → real SQLite through a D1-shaped shim (`src/services/db/sqlite.ts`) that applies the same `drizzle/migrations` as production and tracks them in `d1_migrations`, rate limiting → skipped.

The routes talk to storage through a small `StorageInterface`. `getStorage()` returns an `S3Storage` (`src/services/s3.ts`, SigV4 via `aws4fetch`) when the `S3_*` settings are present. Otherwise, in production it wraps the raw R2 binding in `R2Storage`, and offline it returns the `LocalStorage` instance directly. See `src/services/r2.ts`. The offline server uses S3 too when `S3_*` are set in its environment, e.g. pointing at a local SeaweedFS or MinIO.

## Local development (offline)

No Cloudflare account needed:

```bash
bun install
bun run db:setup:local   # creates data/remotestorage.db + data/storage/
bun run dev:offline      # http://localhost:8787 with live reload
```

`bun run dev:offline` explicitly enables local-development mode: the Instance serves the Account `alice` at `http://localhost:8787`, owned by `alice@example.com` (set `ACCOUNT_USERNAME` / `OWNER_EMAIL` / `PUBLIC_BASE_URL` to override; the default origin follows `PORT`). Its storage address is `alice@localhost:8787`. With no Cloudflare Access in front of it, requests to `localhost`, `127.0.0.1` or `[::1]` are signed in as a **dev identity** — `RSILO_DEV_EMAIL`, defaulting to `OWNER_EMAIL` (set it to another address to preview the "not allowed" page). The dev identity is unreachable unless `RSILO_DEV_MODE=true`, the host is local and no Access identity is present, so it cannot leak into production. "Local" is read from the request's `Host` header, which any client can set, so the offline server listens on `127.0.0.1` only: whoever can reach its port is the Owner, so don't forward or proxy it. Setting `LISTEN_HOST` to anything but a loopback address (as the Docker image below does) switches the dev identity off altogether. The same guard exposes the debug endpoints at `/debug/*` (see [docs/api.md](api.md)); in production they are a 404.

The offline database is built from the same `drizzle/migrations` as a real D1 database; applied migrations are recorded in `d1_migrations`, so opening it again applies only what is new. A database created by an older RSilo is upgraded the first time it is opened: a pre-hash database drops its tokens and clients once at migration `0005` (apps reconnect once), while the Account row and your files are untouched. Delete `data/remotestorage.db` any time to start over.

Offline documents are stored under `data/storage/` with percent-encoded file names and their metadata in `data/storage/.meta/`. A name whose encoding is over 255 bytes is stored under a shortened name ending in `~<sha256>`, with the full name in `data/storage/.meta/.names/`, so names as long as R2 or S3 accept work offline too; a path too long for the filesystem as a whole gets `414`. The percent-encoded layout is new, so delete `data/storage/` (or re-upload your files) after upgrading from an older RSilo.

### Docker image

`ghcr.io/jonocodes/rsilo` packages the offline server for test suites and quick local use, e.g. rclone's remoteStorage backend tests. `:main` follows `main`, `:sha-<commit>` pins a build, and each release is tagged `:<version>` (`:latest` is the newest release). It is public (no login needed to pull) and based on `oven/bun:*-alpine` (pinned by digest; Dependabot opens weekly PRs when it changes), built for `linux/amd64` and `linux/arm64` (each built and smoke-tested on a native runner); `docker buildx imagetools inspect ghcr.io/jonocodes/rsilo:main` lists its platforms. It is not for production, which runs on Cloudflare.

```bash
docker run -d --name rsilo -p 127.0.0.1:8787:8787 -v rsilo-data:/data ghcr.io/jonocodes/rsilo:main
docker exec rsilo bun src/scripts/dev-token.ts alice '*:rw'   # prints a bearer token
curl -H "Authorization: Bearer <token>" http://127.0.0.1:8787/storage/alice/
```

The image listens on `0.0.0.0` inside the container (`LISTEN_HOST`), so the dev identity is off: `/account` and `/debug` have no identity source, and storage works with dev-token bearer tokens. Publish the port on `127.0.0.1` anyway. Data lives in the `/data` volume. Set `PUBLIC_BASE_URL` when the published port differs from 8787, so WebFinger and OAuth links point at the right place. `S3_*` settings work as for the offline server, as long as the endpoint is reachable from inside the container.

## Local development (wrangler dev)

To run the Worker itself in workerd, with a local D1 and R2 simulation:

```bash
cp .dev.vars.example .dev.vars   # dev mode and the dev defaults
bun run db:migrate               # applies drizzle/migrations to the local D1 (once, and after new migrations)
bun run dev                      # wrangler dev on http://localhost:8787
```

## API reference

The server exposes one OpenAPI surface:

```
GET    /api              Scalar UI (documentation only — no request console)
GET    /openapi.json     The OpenAPI 3.1 spec
```

A static, always-current list of every endpoint lives in **[docs/api.md](api.md)**. The spec is derived from `app.routes` and a metadata registry, so the list of routes cannot drift (summaries and status codes in the registry are maintained by hand): `bun run docs:api` regenerates the static list, `bun run docs:api:check` verifies it without writing, and a test (run in CI) fails if it is stale.

## Screenshots

The README's screenshots live in `docs/images/`. After a UI change, regenerate them:

```bash
bun run docs:screenshots
```

It starts a throwaway offline server on port 8797 with a temporary database, seeds sample files, connects three apps through the real consent page, captures the dashboard and the file manager, then deletes the temporary data. It drives Chromium through `playwright-core`, which uses a browser installed with `bunx playwright install chromium`. Where that browser will not launch (NixOS, for example), point `CHROME_PATH` at another Chromium build:

```bash
CHROME_PATH=$(ls -d /nix/store/*-playwright-chromium/*/chrome | head -1) bun run docs:screenshots
```

## Project layout

```
src/
  index.ts            Worker entry (Hono app)
  server-offline.ts   Offline dev server (Bun + local directory/SQLite)
  config.ts           per-Instance config (OWNER_EMAIL required; ACCOUNT_USERNAME, PUBLIC_BASE_URL, S3_* settings) and dev defaults
  types.ts            Worker bindings (AppEnv) and the StorageInterface every backend implements
  routes/             storage, webfinger, oauth (discovery, token, legacy consent redirect), account,
                      consent (/account/oauth/authorize), debug, docs (/api, /openapi.json),
                      mount (shared route table and error handler)
  middleware/         auth (storage authorization), cors, instance (config + Account gates),
                      owner (/account gate + CSRF)
  services/           auth (scopes), identity (Owner resolver: Cloudflare Access or dev identity),
                      account (Account row lifecycle), discovery (advertised URLs, WebFinger matching),
                      tokens (codes, tokens, refresh rotation), pkce, rate-limit, security-log,
                      r2 (+ getStorage), s3, local-storage, quota-storage (quota-aware writes),
                      object-size, storage-errors, db/ (schema types, SQLite D1 shim)
  openapi/            route registry, OpenAPI spec and the docs/api.md renderer
  ui/                 account client script, setup and not-allowed pages
  protocol/           constants (ETag normalisation), item-path (item names), range (byte ranges)
  scripts/            setup (+ setup-config: pure, unit-tested helpers; cloudflare-access: the Access app), deploy, release
                      (bundle check + migrations, shared by both), wrangler-config,
                      dev-token, setup-local-db, render-api-docs, screenshots
drizzle/migrations/   D1 migrations
test/                 unit, contract, compliance and E2E suites; helpers/ holds the storage, D1 and Cloudflare API fakes
```

## Testing

```bash
bun run test             # all tests (fast: real SQLite + offline server E2E)
bun run test:watch       # watch mode
bun run typecheck        # source tsc --noEmit
bun run typecheck:test   # test-suite tsc --noEmit
bun run lint             # type-aware eslint, src and test
bun run lint:prune       # drop fixed violations from eslint-suppressions.json
bun run test -- test/e2e/storage-e2e.test.ts  # one E2E suite
```

Lint is type-aware (typescript-eslint `recommendedTypeChecked`, `no-explicit-any` included). Violations that predate it, nearly all `any` in tests, are baselined in `eslint-suppressions.json`; new ones fail. Once you fix a baselined one, lint fails until you run `bun run lint:prune`.

The suite covers protocol compliance (RemoteStorage, WebFinger, edge cases), single-Account discovery and the Account row lifecycle, optional-config defaults and the setup pages, storage, auth, rate limiting, security event logging, OAuth and the consent page, token hashing, PKCE and refresh rotation, Cloudflare Access identity and CSRF, the account dashboard, debug/observability, wrangler config, the setup script (against a fake wrangler) and its Cloudflare Access setup (against a fake Cloudflare API), file manager, quota accounting, the R2 and S3 storage adapters (S3 against an in-memory fake), the SQLite D1 shim and migration/schema checks, and E2E against the offline server.

Every test that touches the database runs the real SQL that production runs: the schema lives only in `drizzle/migrations`, and the SQLite D1 shim applies it to each test database.

`test/s3-live.test.ts` runs the S3 adapter against a real S3 server, which checks request signing. It is skipped unless `RSILO_S3_LIVE_ENDPOINT` is set; the file header shows how to run it against a local SeaweedFS. CI runs it, and the remoteStorage spec-check, against a SeaweedFS container (`.github/workflows/spec-check.yml`).

`test/cloudflare-access-live.test.ts` runs the Cloudflare Access part of `bun run setup` against the real Cloudflare API: it creates, re-checks, updates and deletes one Access app for a throwaway `workers.dev` host. It is skipped unless `RSILO_ACCESS_LIVE_TOKEN` is set (the file header shows how to run it); CI does not run it.

## Releasing

1. On a branch, set `version` in `package.json` and add its entry at the top of [CHANGELOG.md](../CHANGELOG.md); merge it to `main`.
2. Tag the merge commit and push the tag:

   ```bash
   git tag -a v0.3.0 -m "RSilo 0.3.0" && git push origin v0.3.0
   ```

   The docker workflow checks that the tag matches `package.json` and publishes `ghcr.io/jonocodes/rsilo:<version>` and `:latest`.
3. Create the GitHub release from the tag, with the changelog entry as its notes: `gh release create v0.3.0 --notes-file <entry>`.

Deploy-button Instances follow `main`, not tags, so `main` must stay deployable between releases.

### Fresh-user check

The tests can't tell whether someone non-technical can actually set RSilo up. Before announcing a release that changes deploying, Cloudflare Access or `/account`, watch one such person try it. They need a **new** Cloudflare account and a GitHub account; give them only the README link, and don't help. Ask them to:

1. Get their own RSilo running, using the free option.
2. Sign in to `/account`.
3. Connect a remoteStorage app (say [Savr](https://savr.link)) and save something in it.
4. Open the app on a second device and see the same data.
5. Find what they saved in the file manager.
6. Revoke the app.

Note every place they stall or need a hint, and file each one as a `needs-triage` issue. The Cloudflare Access step is the one most likely to go wrong ([#61](https://github.com/jonocodes/RSilo/issues/61)).
