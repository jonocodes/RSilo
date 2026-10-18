# No WinterTC or runtime-portability work for now

We asked whether RSilo should target WinterTC (Ecma TC55, the shared web APIs that server runtimes implement) so it could run off Cloudflare. We decided to do nothing for now. The request-handling code already uses only web APIs (Hono's `Request → Response` handler, streams, `fetch` and WebCrypto through `aws4fetch`). What ties an Instance to Cloudflare is D1, R2, the rate-limit bindings, Cloudflare Access (`ctx.access`, ADR-0001) and the edge's `Host` check, and WinterTC covers none of them. Running elsewhere is therefore a product decision, not a standards one, and it cuts against "free and no ops for non-technical people": self-hosting moves sign-in, TLS, uptime and backups onto the Owner.

Status: accepted

## Considered Options

- **Lint guard keeping core code free of Node APIs** (`node:*`, `fs`, `process`, `Buffer` outside `src/scripts/`, `server-offline.ts` and the SQLite/local-storage shims). Deferred. `wrangler.toml` enables `nodejs_compat`, and the offline server and tests run on Bun/Node, so Node APIs creeping into the core would break nothing RSilo runs today. The guard only pays once a non-Node runtime is an actual target; add it then.
- **A self-hostable entry point** (Node/Bun with real SQLite, local or S3 storage, in-memory rate limiting, and an OIDC sign-in replacing Access). Deferred. It serves a different audience that existing remoteStorage servers already serve, and it adds a second deploy target to keep correct.

## Consequences

- The existing seams are the escape hatch if this is revisited: `StorageInterface` (R2, S3 per ADR-0005, local directory), the real-SQLite D1 shim, and `src/server-offline.ts`, which already runs the full route set off Cloudflare.
- Revisit if Cloudflare's free tier or Access terms change in a way that hurts the mission, or if Owners ask to self-host. Owner sign-in would be the hard part; see issue #27.
