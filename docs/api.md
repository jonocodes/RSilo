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
| `GET` | `/account/oauth/authorize` | Cloudflare Access | OAuth consent page |
| `POST` | `/account/oauth/authorize` | Cloudflare Access | Approve or deny an app |
| `GET` | `/oauth/{user}` |  | OAuth discovery document |
| `GET` | `/oauth/{user}/authorize` |  | Legacy consent URL (redirect) |
| `POST` | `/oauth/{user}/authorize` |  | Legacy consent URL (no longer accepts submissions) |
| `POST` | `/oauth/{user}/token` |  | Exchange code or refresh token |

### Account

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/account` | Cloudflare Access | Dashboard |
| `POST` | `/account/apps/revoke` | Cloudflare Access | Revoke an app |
| `GET` | `/account/browse` | Cloudflare Access | Browse the storage root |
| `GET` | `/account/browse/{path}` | Cloudflare Access | Browse a folder |
| `GET` | `/account/client.js` | Cloudflare Access | Account UI script |
| `POST` | `/account/delete/{path}` | Cloudflare Access | Delete a file |
| `GET` | `/account/download/{path}` | Cloudflare Access | Download a file |
| `POST` | `/account/quota` | Cloudflare Access | Set the storage quota |
| `POST` | `/account/save/{path}` | Cloudflare Access | Save edits to a text file |
| `POST` | `/account/setup-access` |  | Set up Cloudflare Access from the finish-setup page |
| `GET` | `/account/tokens` |  | Redirect to the dashboard |
| `POST` | `/account/upload/{path}` | Cloudflare Access | Upload files to a folder |
| `GET` | `/account/view/{path}` | Cloudflare Access | View a text file |
| `GET` | `/admin` |  | Redirect to /account |
| `GET` | `/admin/{path}` |  | Redirect to /account |

### Debug

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/debug/echo` |  | Echo a request; parse a storage path scope |
| `POST` | `/debug/echo` |  | Echo a request body |
| `GET` | `/debug/env` |  | Redacted runtime, bindings and config |
| `GET` | `/debug/health/deep` |  | Live round-trip check of each binding |
| `GET` | `/debug/oauth` |  | OAuth clients, tokens and pending codes |
| `GET` | `/debug/storage` |  | Actual storage vs DB counter |
| `GET` | `/debug/token` |  | Introspect a storage token |
| `POST` | `/debug/token` |  | Introspect a token (body) |

### Meta

| Method | Path | Auth | Summary |
| --- | --- | --- | --- |
| `GET` | `/` |  | Landing page |
| `GET` | `/health` |  | Liveness check |

<!-- END GENERATED API REFERENCE -->

## Notes

**Storage.** Requires `Authorization: Bearer <token>` with appropriate scope. Paths ending in `/` are folders. Downloads stream from R2 or S3. Upload request bodies are read with a hard size bound and then buffered so RSilo can reserve the exact size delta before writing; the default limit is 10 MiB. PUT, account upload/save, and delete operations update the Account's usage through the same quota-aware path. Reservations are atomic and are rolled back if object storage fails. Each write is conditioned on the version it was accounted against, so usage stays exact when writes race (except on S3, see [Known limitations](../README.md#known-limitations)). A write over the quota gets `507`, a body over the size limit `413`, a failed `If-Match` / `If-None-Match: *` `412`, a `PUT` where a document and a folder would share a name `409`, and, on the offline server only, a path too long for its filesystem `414`. `HEAD` and a matching `If-None-Match` are answered from metadata without fetching the body.

**WebFinger / OAuth.** Endpoints are listed above; the flow is documented under [Authentication](#authentication) below.

**Account.** The Owner's web UI. Cloudflare Access signs the Owner in; on every request the Worker reads the identity Access attaches to the request (`ctx.access`) and admits only `OWNER_EMAIL` (case-insensitive). While `OWNER_EMAIL` is missing or invalid, or Access is not in front of `/account`, it shows a finish-setup page (503); storage, discovery and the token endpoint do not wait for either. Any other signed-in email gets a 403 page. Every non-GET/HEAD request must carry `Sec-Fetch-Site: same-origin`, or, when that header is absent, an `Origin` equal to the public origin (`PUBLIC_BASE_URL`, or the request's own origin when unset); otherwise it is refused with 403. Sign-out is Cloudflare's `/cdn-cgi/access/logout`. `/admin` and `/admin/*` redirect to `/account`.

**Debug (observability).** Read-only endpoints for agent-driven local debugging. They answer only in dev mode (`RSILO_DEV_MODE=true`) on `localhost`/`127.0.0.1`/`[::1]` without Cloudflare Access; everywhere else every `/debug/*` path is a 404. Secret values are never returned. `/debug/storage` recomputes the Account's usage by listing objects, which is an R2 **Class A** operation — call it on demand, not on a timer. `drift_bytes = actual_bytes - db_used_storage_bytes`; a positive value means the denormalised counter under-reports (quota is being under-enforced). `/debug/echo` redacts `Authorization`, `Cookie` and `X-RS-Token`; to introspect a storage token pass it as `?token=` (or the `X-RS-Token` header).

```bash
# Who is this token, and what can it do?
TOKEN="$(bun run dev-token alice 'documents:rw')"
curl "http://localhost:8787/debug/token?token=$TOKEN&scope=documents:rw&scope=pictures:r"

# Does the DB usage counter match what is actually in storage?
curl http://localhost:8787/debug/storage

# Are R2 and D1 actually reachable?
curl http://localhost:8787/debug/health/deep

# What scope would a request to this URL need?
curl "http://localhost:8787/debug/echo?path=/storage/alice/documents/note.txt&method=PUT"
```

## Authentication

### OAuth flow (production)

1. App queries WebFinger to discover auth and storage endpoints (see [Discovery](#discovery))
2. App redirects user to the advertised consent URL, `/account/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&scope=documents:rw&state=...&code_challenge=...&code_challenge_method=S256`
3. The Owner reviews the requested scopes and approves (their identity comes from Cloudflare Access; see [Set up Cloudflare Access](self-hosting.md#set-up-cloudflare-access)). Approve and deny are `/account` form posts, so they get the same-origin check.
4. Server redirects back with `?code=...`
5. App exchanges code and `code_verifier` at `/oauth/:user/token` → `access_token` (1-hour expiry) + `refresh_token`
6. App uses `Authorization: Bearer <access_token>` on storage requests
7. When the access token expires, exchange the refresh token at `/oauth/:user/token` with `grant_type=refresh_token`

Both `response_type=code` (authorization code) and `response_type=token` (implicit) are supported. remoteStorage.js uses implicit, which returns the access token in the redirect fragment and has no refresh token. The code flow requires [PKCE](https://datatracker.ietf.org/doc/html/rfc7636) with `code_challenge_method=S256`, as OAuth 2.1 does for public clients. Without it the consent page answers `400`, and the token endpoint refuses a missing or wrong `code_verifier` with `invalid_grant`. A code is single-use: any attempt to redeem it spends it, even a failed one.

A `scope` is space-separated `<module>:r` or `<module>:rw` items (see [Storage scopes](#storage-scopes)). Anything else, including a bare `*`, sends the app back to its `redirect_uri` with `error=invalid_scope`; nothing is granted.

The consent page is always for the Account, so its URL has no username; tokens are always issued for the Account, and `/oauth/:user/token` returns `404` when `:user` is not `ACCOUNT_USERNAME`. The token endpoint stays outside `/account` and is not behind Access, since apps call it directly.

PKCE is `S256` only. The `plain` method, or a challenge with no method, is a `400` on the consent page. The implicit flow ignores PKCE parameters. `/oauth/:user` advertises `code_challenge_methods_supported: ["S256"]`.

Per protocol §10, `client_id` must be a URL and `redirect_uri` a URL on the same origin. Both must be `https`, except on a loopback host (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`), where plain `http` is allowed for local development: anywhere else an `http` redirect would carry the code or token across the network in the clear. Otherwise the consent page (on `GET` and on approve or deny) answers `400` with a plain-text error and never redirects.

The consent page used to be `/oauth/:user/authorize`. Apps (remoteStorage.js) cache discovery results, so that URL still answers `GET` with a `302` to `/account/oauth/authorize`, passing the query string through unchanged. `POST` there returns `405`, and any `:user` other than the Account returns `404`.

### Token lifetimes

| Token | Lifetime | Renewal |
|-------|----------|---------|
| Authorization code | 10 minutes, single use | none |
| Access token (code flow) | 1 hour | the refresh token |
| Refresh token (code flow only) | 30 days | each use rotates it, returning a new access token and a new 30-day refresh token |
| Access token (implicit flow) | 30 days from last use | pushed forward on use, at most once a day |
| Dev token (`bun run dev-token`) | 30 days from last use | like an implicit-flow token |

Only the newest refresh token works: a superseded or expired one gets `invalid_grant`. Expired tokens and codes are deleted whenever new tokens are issued, and revoking an app deletes all of its tokens at once.

The implicit flow, which remoteStorage.js apps use, issues no refresh token. Its access token instead stays valid until 30 days pass without the app using it, so an app in regular use never sends the Owner back to the consent page. Revoke it from the dashboard to cut it off sooner.

### Discovery

WebFinger (`/.well-known/webfinger`, `/webfinger/jrd`, `/webfinger/xrd`) accepts exactly these resources, all resolving to the Account:

- `acct:<ACCOUNT_USERNAME>@<host>` — username and host compared case-insensitively
- the host-only form `http://<host>` or `https://<host>`, with or without a trailing slash

`<host>` must equal the public host — the `PUBLIC_BASE_URL` host when set, otherwise the host the request arrived at — including any non-default port (`acct:alice@localhost:8787` in dev); `acct:` resources may also omit the port (`acct:alice@localhost`). Any other resource returns `404` on every discovery route, as does `/oauth/:user` for any user but the Account. All advertised URLs come from that public origin (one resolver, `getInstanceConfig` in `src/config.ts`), never from `X-Forwarded-Host` / `X-Forwarded-Proto`. Without `PUBLIC_BASE_URL` the request's origin is trusted because Cloudflare's edge rejects a request whose `Host` is not one of the Worker's own hostnames (`403`) before the Worker runs; the offline Node server, which has no such edge, pins its origin to `http://localhost:$PORT`.

```bash
curl 'http://localhost:8787/.well-known/webfinger?resource=acct:alice@localhost:8787'
curl 'http://localhost:8787/.well-known/webfinger?resource=http://localhost:8787/'
```

Access tokens are **opaque bearer tokens**: 256-bit random base64url strings, each recorded as a row in the D1 `oauth_tokens` table. Rows hold only the base64url SHA-256 hash of each access token, refresh token and authorization code, so a copy of the database contains nothing an app could present. A token is valid exactly while its unexpired row exists, so revoking an app (deleting its row) takes effect on the very next request. Self-contained signed tokens are never accepted, in production or in local-development mode ([ADR-0003](adr/0003-opaque-bearer-tokens-only.md)).

### Dev tokens (testing only)

`bun run dev-token` inserts an opaque token row (30-day expiry, stored as its hash) into a local database and prints the token. It creates the user and a `dev-token:<username>` client if they do not exist yet.

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
| `*:rw` | Read and write all of storage |

A module scope covers `/<module>/…` and `/public/<module>/…`. Everything else (root-level documents, the root folder, `public/` itself and documents directly in it) needs `*:r` or `*:rw`. A module name is any valid item name (no `/`, not `.` or `..`), matched case-sensitively; `public` is reserved. The protocol asks for lower-case alphanumeric names but remoteStorage.js accepts any, so RSilo does too. `rw` includes `r`; any other level (`read`, `w`, a bare `*`) is invalid. Files under `public/<module>/` are readable without auth (files only; folder listings require auth).

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

### Item names

Names follow protocol §4. A name may contain any character except `/` and NUL, and must not be empty, `.` or `..`. That includes spaces, `?`, `#`, `%`, newlines and leading dots. Clients send each name percent-encoded, and RSilo decodes each path segment on its own (`src/protocol/item-path.ts`). It stores the name itself and lists it unencoded, so `PUT /storage/alice/documents/a%20b%3F` is listed as `"a b?"`. An encoded `/` inside a name (`%2F`) is a `400`. Routing uses the raw request path for this reason (Hono `getPath`). The file manager under `/account` uses the same names.

### Byte ranges

`GET` on a document honours a single `Range: bytes=…` (RFC 9110 §14): `206` with `Content-Range`, or `416` when the range starts past the end. Responses carry `Accept-Ranges: bytes`, and WebFinger advertises `"http://tools.ietf.org/html/rfc7233": "GET"`. Multiple ranges and invalid values get the whole document (`200`). R2 and S3 fetch only the requested bytes.
