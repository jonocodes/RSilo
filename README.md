# RSilo

A [RemoteStorage.io](https://remotestorage.io)-compatible server for Cloudflare Workers (or local development).

## What is RemoteStorage?

RemoteStorage is an open protocol for personal cloud storage. Think of it like WebDAV or S3, but with a standardized HTTP API and OAuth-based authentication.

**Key concepts:**
- **Users** have storage organized into **modules** (like `documents`, `pictures`)
- **OAuth 2.0** is used for authentication with scope-based access
- **WebFinger** is used for service discovery
- Data is stored as files and folders, similar to a filesystem

## Quick Start

### 1. Start the server (offline mode - no account needed)

```bash
bun install
bun run db:setup:local
bun run dev:offline
```

Server runs at `http://localhost:8787`

### 2. Store a file

```bash
# Create a test token (in production, use OAuth flow)
TOKEN="eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhbGljZSIsInNjb3BlcyI6ImRvY3VtZW50czpydyBwaWN0dXJlczpydyIsImlhdCI6MTcwNjAwMDAwMDAsImV4cCI6OTk5OTk5OTk5OX0."

# Upload a file
curl -X PUT http://localhost:8787/storage/alice/documents/hello.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -d "Hello, RemoteStorage!"

# Response: 201 Created with ETag header
```

### 3. Read the file back

```bash
curl http://localhost:8787/storage/alice/documents/hello.txt \
  -H "Authorization: Bearer $TOKEN"

# Response: "Hello, RemoteStorage!"
```

### 4. List a folder

```bash
curl http://localhost:8787/storage/alice/documents/ \
  -H "Authorization: Bearer $TOKEN"

# Response: JSON-LD folder listing
# {
#   "@context": "http://remotestorage.io/spec/version-1.1",
#   "items": {
#     "hello.txt": { "ETag": "\"abc123\"" }
#   }
# }
```

### 5. Delete the file

```bash
curl -X DELETE http://localhost:8787/storage/alice/documents/hello.txt \
  -H "Authorization: Bearer $TOKEN"

# Response: 204 No Content
```

### 6. Public sharing (no auth required)

Files under `/public/` can be shared without authentication:

```bash
# Upload a public file (still requires auth for PUT)
curl -X PUT http://localhost:8787/storage/alice/public/documents/shared.txt \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -d "Anyone can read this!"

# Read it without auth (no Authorization header needed)
curl http://localhost:8787/storage/alice/public/documents/shared.txt

# Response: "Anyone can read this!"
# Response headers include: Cache-Control: public, no-cache
```

**Rules (per RemoteStorage spec):**
- GET requests to public **files** (not ending in `/`) work without auth
- GET requests to public **folders** (ending in `/`) still require auth (401)
- PUT/DELETE to public files still require auth with `public:*:rw` scope
- Public responses include `Cache-Control: public` header for caching

This is useful for sharing documents via hard-to-guess URLs, as mentioned in the [RemoteStorage spec](https://datatracker.ietf.org/doc/html/draft-dejong-remotestorage#section-14).

## API Endpoints

### Storage API

```
GET    /storage/:username/*          Get file or folder listing
PUT    /storage/:username/*          Create/update file
DELETE /storage/:username/*          Delete file
HEAD   /storage/:username/*          Get metadata without body
```

### WebFinger (Discovery)

```
GET    /.well-known/webfinger?resource=acct:alice@example.com
```

Returns JSON with storage and auth endpoint links.

### OAuth

```
GET    /oauth/:user                  OAuth server discover info
GET    /oauth/:user/authorize        Authorization form
POST   /oauth/:user/token            Token endpoint
```

### Admin

```
GET    /admin/                       Admin dashboard (HTML)
GET    /admin/stats                  Usage statistics
```

## Authentication

### Dev Tokens (for testing)

Dev tokens are simple JWTs with no signature. Create one programmatically:

```typescript
import { createTestToken } from './src/index';

const token = createTestToken('alice', 'documents:rw pictures:rw');
// Returns: eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhbGljZS4uLn0.
```

For curl, construct the token manually (base64 of `{"alg":"none","typ":"JWT"}` + `.` + base64 of `{"sub":"alice","scopes":"documents:rw pictures:rw","iat":1706000000,"exp":9999999999}`):

```bash
HEADER="eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0"
PAYLOAD=$(echo -n '{"sub":"alice","scopes":"documents:rw pictures:rw","iat":1706000000,"exp":9999999999}' | base64 -w0 | tr '+/' '-_' | tr -d '=')
TOKEN="${HEADER}.${PAYLOAD}."
```

### OAuth Flow (production)

1. Client queries WebFinger for storage info
2. Redirects user to `/oauth/:user/authorize?client_id=...&redirect_uri=...&response_type=code&scope=documents:rw`
3. User approves (sees consent form)
4. Server redirects back with authorization code
5. Client exchanges code for token at `/oauth/:user/token`
6. Client uses token in `Authorization: Bearer <token>` header

## Storage Modules

Storage is organized into modules (like filesystem directories):

| Module | Purpose | Example path |
|--------|---------|--------------|
| `documents` | Text documents, files | `/storage/alice/documents/projects/readme.md` |
| `pictures` | Images, photos | `/storage/alice/pictures/vacation/photo.jpg` |
| `music` | Audio files | `/storage/alice/music/song.mp3` |

You can use any module name - they're not predefined. Scopes are module-specific:
- `documents:rw` - read/write documents module
- `pictures:r` - read-only pictures module

## Offline Development

```bash
# Setup database (one time)
bun run db:setup:local

# Start server
bun run dev:offline
```

Uses SQLite (`data/remotestorage.db`) and local filesystem (`data/storage/`).

## Running Tests

```bash
# Unit tests (mocked storage, fast)
bun run test

# E2E tests (real server, real filesystem)
bun test test/e2e/storage-e2e.test.ts

# Watch mode
bun run test:watch
```

**161 tests** covering protocol compliance, storage, auth, OAuth, admin, and E2E.

## Production Deployment

```bash
# Create Cloudflare resources
wrangler r2 bucket create remotestorage
wrangler d1 create remotestorage-db

# Update wrangler.toml with IDs, then deploy
bun run deploy
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                     │
│                                                          │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌──────────┐  │
│  │ WebFinger│  │  OAuth  │  │ Storage │  │  Admin   │  │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  │
└───────────────────────────┼───────────────────────────────┘
                            │
           ┌────────────────┼────────────────┐
           │                │                │
      ┌────▼────┐      ┌────▼────┐     ┌─────▼─────┐
      │   R2    │      │   D1    │     │ KV (Rate) │
      └─────────┘      └─────────┘     └───────────┘
```

For offline development, R2 → local filesystem, D1 → SQLite.

## Known Limitations

1. **No user registration**: Users are created via dev tokens or OAuth flows. For admin user management, use the `/admin/` dashboard or direct API calls.

2. **Rate limiting**: Requires KV binding in Cloudflare. Optional for offline mode.

3. **Admin UI**: Has no authentication. Protect it via firewall rules or add API key middleware.

## References

- [RemoteStorage Protocol Spec](https://remotestorage.io/protocol.html)
- [RemoteStorage.js (client library)](https://remotestorage.io/integrate/)
- [Armadietto (Node.js reference impl)](https://github.com/remotestorage/armadietto)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)