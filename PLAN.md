# Project: RSilo - Cloudflare-native RemoteStorage server

## Goal

Build a new **RemoteStorage-compatible server** for Cloudflare Workers.

Target stack:

* **Cloudflare Worker**: HTTP API
* **R2**: document/blob storage
* **D1**: users, OAuth clients, tokens, metadata
* **Durable Objects**: optional locking / concurrency control
* **Wrangler dev**: local development and tests

Reference implementations/specs to inspect:

* Armadietto: Node.js RemoteStorage server. It has newer S3-compatible/modular work, JWT permissions, streaming transfer, ETag fixes, and Express-based architecture. ([GitHub][1])
* `remotestorage-server`: core HTTP behavior for RemoteStorage servers. ([GitHub][2])
* RemoteStorage protocol spec. ([remoteStorage][3])
* Other servers listed by RemoteStorage: `rs-serve`, Python, Ruby, PHP, Rust/Mysteryshack. ([remoteStorage][4])

---

# Build strategy: TDD-first

## Yes, use TDD

The LLM should work in this loop:

1. Read protocol/spec/reference implementation.
2. Write failing tests for one behavior.
3. Implement the smallest Worker code to pass.
4. Refactor.
5. Repeat.

Do **not** start by building OAuth UI, passkeys, admin pages, or full production auth.

Start with protocol behavior.

---

# Phase 0 — Research checklist

The LLM should inspect:

* [x] `remotestorage/armadietto` - reviewed storage_common.js, S3_store_router.js, webfinger.js, stores/core.js
* [x] Armadietto tests - reviewed storage_common.spec.js for protocol behavior
* [x] Armadietto storage abstraction - S3_store_router.js uses R2-like interface (PutObjectCommand, GetObjectCommand, etc.)
* [x] Armadietto OAuth/auth logic - storage_common.js has JWT auth middleware with scope checking
* [x] Armadietto ETag handling - normalizeETag.js handles quoting/lowercasing
* [x] Armadietto folder listing behavior - S3_store_router.js listFolder() computes MD5 digests for folder ETags
* [x] RemoteStorage protocol docs - draft-dejong-remotestorage-22, WebFinger JRD format, folder listing JSON-LD

---

# Phase 1 — Project scaffold

## Checklist

* [x] Create Worker TypeScript project
* [x] Add Vitest
* [x] Add Miniflare / Workers test environment
* [x] Configure Wrangler
* [x] Add R2 binding
* [x] Add D1 binding
* [x] Add test database migrations
* [x] Add lint/typecheck/test scripts

Current structure:

```text
src/
  index.ts          # Hono app, creates server with env
  routes/
    storage.ts       # GET/PUT/DELETE /storage/:username/*
    webfinger.ts     # /.well-known/webfinger, /webfinger/jrd
  services/
    auth.ts          # createTestToken, verifyToken, hasScope, scopeFromPath
    r2.ts            # R2Storage class, buildKey
  protocol/
    constants.ts     # PROTOCOL_VERSION, normalizeETag, isValidPath, createEmptyFolder
  middleware/
    auth.ts          # authMiddleware, requireScope
    cors.ts          # CORS headers middleware
  types.ts           # AppEnv, TokenPayload interface
test/
  storage.test.ts    # PUT/GET/DELETE/OPTIONS tests
wrangler.toml
tsconfig.json
vitest.config.ts
package.json
```

---

# Phase 2 — Minimal storage API

Started. Basic PUT/GET/DELETE working.

Rules:

* Paths ending in `/` are folders.
* Paths not ending in `/` are documents.
* Folder listing must be RemoteStorage-compatible.
* All storage paths must be scoped by user.

Example R2 key:

```text
users/{userId}/storage/{path}
```

Tests (Phase 2):

* [x] PUT then GET returns same body
* [x] GET missing file returns 404
* [x] PUT without auth returns 401
* [x] OPTIONS returns CORS headers
* [x] GET returns ETag header
* [x] DELETE removes file
* [x] HEAD returns headers without body
* [x] folder listing includes direct children
* [x] folder listing does not leak nested grandchildren unless expected
* [x] path traversal attempts fail

---

# Phase 3 — Auth MVP

Started. Dev auth with bearer tokens working.

## Dev auth

* [x] Accept `Authorization: Bearer dev-token`
* [x] Map token to fixed user (via JWT sub claim)
* [x] Reject missing token
* [x] Reject invalid token

Tests:

* [x] unauthenticated request returns 401
* [x] invalid token returns 401
* [x] valid token works
* [x] user A cannot read user B data

---

# Phase 4 — Metadata and ETags

Partially implemented via R2Storage service.

Object metadata:

* [x] owner user ID (via path scoping)
* [x] path (via R2 key)
* [x] content type (via httpMetadata)
* [x] size (via object.size)
* [x] ETag (via object.etag)
* [x] last modified (via customMetadata)

Tests:

* [x] GET returns ETag
* [x] PUT changes ETag
* [x] `If-Match` succeeds with correct ETag
* [x] `If-Match` fails with stale ETag
* [x] `If-None-Match: *` prevents overwrite
* [x] content type preserved
* [x] last modified updated

---

# Phase 5 — Discovery

Started. WebFinger endpoint implemented.

Implement:

* [x] WebFinger endpoint (/.well-known/webfinger)
* [x] RemoteStorage profile/discovery response
* [x] storage API base URL
* [x] auth endpoint URL
* [ ] supported scopes (partial - returns OAuth URL)

Tests:

* [x] WebFinger works for known user
* [x] unknown user returns correct error (400)
* [x] discovery advertises correct storage URL
* [x] discovery advertises correct auth URL
* [x] CORS headers are present

---

# Phase 6 — OAuth / scopes

Implemented dev token system and scope checking.

Checklist:

* [x] OAuth authorize endpoint (stub - returns 501)
* [x] token issuance (dev tokens via createTestToken)
* [x] scopes parser
* [x] read-only scopes
* [x] read-write scopes
* [x] module/category isolation
* [x] wildcard scope support

Tests:

* [x] read token can GET but not PUT
* [x] write token can PUT
* [x] token for `documents` cannot access `pictures`
* [x] invalid scope fails (returns 403)
* [x] expired token fails
* [x] malformed token returns 401

---

# Phase 7 — Compatibility testing

Completed with 88 compliance tests across three files:
- `test/compliance/remoteStorage.test.ts` - 38 tests covering protocol sections 2-8
- `test/compliance/webfinger.test.ts` - 24 tests for WebFinger, ETag, Content-Type, folder listing
- `test/compliance/edgeCases.test.ts` - 26 tests for auth edge cases, path validation, HTTP methods

---

# Phase 8 — Production hardening

Completed. OAuth routes implemented, D1 schema created.

## Checklist

- [x] D1 schema for users, OAuth clients, tokens
- [x] OAuth discover endpoint (`/oauth/:user`)
- [x] OAuth authorize endpoint (HTML form-based consent)
- [x] OAuth token endpoint (authorization_code, refresh_token grants)
- [x] Admin UI dashboard (`/admin/` HTML page)
- [x] Storage quotas per user (atomic enforcement and rollback)
- [x] Rate limiting (storage and authentication endpoints)
- [x] Admin API key/session protection

---

# Phase 9 — Security & correctness fixes

Issues found in code review, grouped by priority.

## Critical (auth bypass / data exposure)

- [x] **JWT signing**: production JWTs use HS256 with `JWT_SECRET`; unsigned test tokens require explicit local-development mode
- [x] **Admin auth**: `/admin/*` uses API-key or admin-session authentication and fails closed when unconfigured
- [x] **Public OAuth clients**: RemoteStorage clients are dynamically registered public clients, so no unused `clientSecret` is accepted or implied
- [x] **OAuth client ID mismatch**: token insertion uses the client ID persisted with the authorization code

## High (reliability / data integrity)

- [x] **Authorization codes in D1**: codes are persisted, consumed, and expired through the database
- [x] **Delete quota accounting**: successful deletes decrement `used_storage_bytes`, with rollback on object-storage failure
- [x] **Atomic quota enforcement**: writes reserve their exact size delta atomically before object storage and roll back failed writes

## Medium (spec compliance / correctness)

- [x] **Folder ETags**: folder descriptions use SHA-256-derived ETags
- [x] **`If-Match` on missing files**: PUT and DELETE return 412 when the target does not exist
- [x] **CORS origin handling**: supplied origins are reflected; origin-less requests use `*`, without credentialed CORS

---

## Current Test Status

**364 tests passing** across 21 test files. The suite covers core storage behavior, RemoteStorage/WebFinger compliance, authentication and OAuth, admin/account flows, quota accounting, D1/R2 adapters, schema checks, security regressions, and offline-server E2E behavior.

Source and test TypeScript are checked separately with `bun run typecheck` and `bun run typecheck:test`; ESLint covers both `src` and `test`.

## Recent Fixes

1. **Removed buggy `validatePath` middleware** - it validated the full URL path instead of the storage path, causing all routes to fail
2. **Fixed 304/204 response handling** - changed `c.text('', status)` to `new Response(null, { status })` for proper empty body responses
3. **Added path traversal protection** - validates path doesn't contain `..` segments to prevent escaping user storage namespace
4. **Fixed URL path matching** - Hono's router normalizes `..` in paths, so path validation must use the original URL to detect traversal attempts
5. **Updated test for path traversal** - accepts 400, 403, or 404 for invalid path attempts (protocol doesn't mandate specific status for security-related rejections)
6. **Removed redundant tests** - consolidated overlapping tests across compatibility.test.ts, oauth.test.ts, and webfinger.test.ts (removed 7 duplicate tests)

## Phase 8 Completed

Implemented OAuth 2.0 flows and Admin UI:

1. **OAuth Authorization Code Flow**
   - `GET /oauth/:user/authorize` - Shows HTML consent form with client info and requested scopes
   - `POST /oauth/:user/authorize` - Handles approve/deny, generates auth codes or tokens
   - `POST /oauth/:user/token` - Exchanges auth codes for tokens, handles refresh_token grants

2. **Admin UI Dashboard** (`/admin/`)
   - HTML dashboard showing stats (users, storage, tokens)
   - User list with inline quota editing
   - API reference section

3. **OAuth Token Generation**
   - Secure random auth codes and access tokens using `crypto.getRandomValues`
   - Refresh token rotation on each use
   - 10-minute expiration for auth codes, 1-hour access tokens, 30-day refresh tokens

## Phase 7 Completed

Added more compatibility tests:
- HEAD request returns headers without body
- Content-Type preservation for stored files
- Multiple files in folder listing
- DELETE non-existent returns 404
- PUT then GET returns identical content

---

[1]: https://github.com/remotestorage/armadietto?utm_source=chatgpt.com "GitHub - remotestorage/armadietto: RS server based on node.js"
[2]: https://github.com/remotestorage/remotestorage-server?utm_source=chatgpt.com "GitHub - remotestorage/remotestorage-server: Core HTTP behavior of a ..."
[3]: https://remotestorage.io/protocol.html?utm_source=chatgpt.com "The remoteStorage Protocol"
[4]: https://remotestorage.io/servers.html?utm_source=chatgpt.com "Servers - remoteStorage"
[5]: https://community.remotestorage.io/t/armadietto-refactor-with-s3-support-and-many-other-improvements/846?utm_source=chatgpt.com "Armadietto refactor, with S3 support and many ... - remoteStorage Forums"
[6]: https://remotestorage.io/contribute.html?utm_source=chatgpt.com "What can I do for remoteStorage? | remoteStorage"

