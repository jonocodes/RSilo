# Changelog

Notable changes to RSilo, newest first. Versions follow [semantic versioning](https://semver.org/); before 1.0 a minor version may change configuration or require a migration, and its entry says so.

## Unreleased

- `bun run setup` sets up Cloudflare Access itself ([#61](https://github.com/jonocodes/RSilo/issues/61)). Given a Cloudflare API token that may edit Access (setup links to the token form, pre-filled), it creates or fixes the self-hosted Access application for `<host>/account`: an Allow policy for `OWNER_EMAIL` and the One-time PIN login method. Re-runs never create a second application, and `bun run setup --owner-email=…` now changes the sign-in email in one step. Without a token, setup prints the dashboard steps as before.
- Deploy-button Instances can set up Cloudflare Access too: while Access is missing, the finish-setup page on `/account` takes a pasted Cloudflare API token and creates the Access application for the Worker's own address and `OWNER_EMAIL`. The token is never stored. The manual steps stay below it.

## 0.3.0 — 2026-11-05

The first tagged release. Everything before it was untagged development on `main`; a deployment from that time upgrades with `bun run deploy` (see [Upgrading an existing deployment](docs/self-hosting.md#upgrading-an-existing-deployment)).

### What it does

- A [remoteStorage](https://remotestorage.io/protocol.html) server on one Cloudflare Worker: WebFinger, OAuth (authorization code with PKCE S256, and the implicit flow remoteStorage.js uses), and storage with ETags, conditional requests, ranges and public sharing.
- One Account per Instance ([ADR-0002](docs/adr/0002-instances-are-single-user.md)), with `OWNER_EMAIL` the only required setting.
- `/account`: a dashboard (storage address, quota, connected apps you can revoke), a file manager and the consent page, all behind Cloudflare Access ([ADR-0001](docs/adr/0001-delegate-human-auth-to-cloudflare-access.md)).
- Files in R2, or in any S3-compatible bucket such as Backblaze B2's free tier ([ADR-0005](docs/adr/0005-s3-compatible-storage-backend.md)).
- Deploy with the Deploy to Cloudflare button, `bun run setup`, or Workers Builds. `bun run deploy` applies D1 migrations safely and prints rollback commands.
- Opaque bearer tokens stored only as hashes ([ADR-0003](docs/adr/0003-opaque-bearer-tokens-only.md)), native rate limits on failed auth, unauthenticated public reads and the token endpoint, and security logs.
- An offline server (SQLite and a local directory) for development and test suites, published as the multi-arch image `ghcr.io/jonocodes/rsilo`.
- A generated API reference at `/api` and in [docs/api.md](docs/api.md).

### Release tooling

- Pushing a tag `v<version>` publishes the Docker image as `:<version>` and `:latest`; the tag must match `package.json`.
- `hono` ≥ 4.12.18 and `@hono/node-server` ≥ 2.0.5, clearing the advisories `bun audit --prod` reported (none affected RSilo's use of them).
