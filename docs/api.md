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
| `GET` | `/oauth/{user}/authorize` |  | Consent form |
| `POST` | `/oauth/{user}/authorize` |  | Approve or deny consent |
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

**Storage.** Requires `Authorization: Bearer <token>` with appropriate scope. Paths ending in `/` are folders. Downloads stream from object storage. Upload request bodies are read with a hard size bound and then buffered so RSilo can reserve the exact size delta before writing; the default limit is 10 MiB. PUT, account upload/save, and delete operations update per-user usage through the same quota-aware path. Reservations are atomic and are rolled back if object storage fails.

**WebFinger / OAuth.** Endpoints are listed above; the flow is documented under [Authentication](../README.md#authentication) in the README.

**Account.** The Owner's web UI. Cloudflare Access signs the Owner in; on every request the Worker reads the identity Access attaches to the request (`ctx.access`) and admits only `OWNER_EMAIL` (case-insensitive). Without Access in front of `/account` it shows a finish-setup page (503); any other signed-in email gets a 403 page. Every non-GET/HEAD request must carry `Sec-Fetch-Site: same-origin`, or, when that header is absent, an `Origin` equal to `PUBLIC_BASE_URL`; otherwise it is refused with 403. Sign-out is Cloudflare's `/cdn-cgi/access/logout`. `/admin` and `/admin/*` redirect to `/account`.

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
