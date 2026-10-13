# Would `@cloudflare/workers-oauth-provider` fit RSilo?

Researched 2026-10-10 against `cloudflare/workers-oauth-provider` v1.2.3 (released 2026-10-07, MIT, ~1.9k stars, actively maintained) and `remotestorage/remotestorage.js` v2.0.0-beta.10.

**Verdict: not today.** The library no longer supports the implicit grant, and every remoteStorage app built on remotestorage.js uses it. It is still worth borrowing several of its security practices (see the end).

## What RSilo does now

- `src/routes/consent.ts`: `/account/oauth/authorize` (behind Access) accepts `response_type=token` (implicit: token in the redirect fragment) and `response_type=code`. Clients are not pre-registered. `client_id` is the app's URL, and `redirect_uri` must share its origin (remoteStorage protocol §10).
- `src/routes/oauth.ts`: `/oauth/:user/token` exchanges codes and rotates refresh tokens. It has no PKCE and no client authentication.
- `src/middleware/auth.ts`: storage requests look up the opaque bearer token in D1 `oauth_tokens` (ADR-0003). Scopes are `module:r|rw`.

## Blockers

### 1. Implicit grant removed

> The implicit grant (`response_type=token`) is not supported: OAuth 2.1 removed it, and MCP clients use the authorization code flow with PKCE.
> — [`docs/authorization-server.md`](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md#pkce-and-token-lifecycle)

The old `allowImplicitFlow` option now throws: *"Removed in 1.2: OAuth 2.1 dropped the implicit grant…"* ([`src/oauth-provider.ts`](https://github.com/cloudflare/workers-oauth-provider/blob/main/src/oauth-provider.ts), constructor).

remotestorage.js still relies on it:

- `buildOAuthURL` defaults `response_type` to `'token'` ([`src/authorize.ts`](https://github.com/remotestorage/remotestorage.js/blob/master/src/authorize.ts)).
- `RemoteStorage#authorize` for the remoteStorage backend never overrides it ([`src/remotestorage.ts`](https://github.com/remotestorage/remotestorage.js/blob/master/src/remotestorage.ts)).
- `response_type: 'code'` with S256 PKCE appears only in the Dropbox backend ([`src/dropbox.ts`](https://github.com/remotestorage/remotestorage.js/blob/master/src/dropbox.ts)).
- Discovery reads only the `rfc6749#section-4.2` (implicit) WebFinger link ([`src/discover.ts`](https://github.com/remotestorage/remotestorage.js/blob/master/src/discover.ts)).

So every remotestorage.js app connecting to RSilo asks for `response_type=token`.

### 2. Unregistered URL client IDs

The library resolves a `client_id` in one of three ways: a KV record (`client:<id>`, created by DCR or `createClient()`), or a fetched Client ID Metadata Document when `clientIdMetadataDocumentEnabled` is on (`getClient` in `src/oauth-provider.ts`).

- remotestorage.js sends the bare app origin (`options.clientId = redirectUri.match(/^(https?:\/\/[^/]+)/)[0]`). That URL serves the app, not a CIMD JSON document.
- `createClient()` always generates a random `clientId` (`generateRandomString(16)`), so RSilo can't pre-register under the origin.

### 3. KV, not D1

The library needs an `OAUTH_KV` namespace (README, "Install"). RSilo keeps tokens in D1 and lists and revokes them from the control plane. Switching would add a binding, split the data, and mean rewriting the "connected apps" listing on top of `listUserGrants`/`revokeGrant`.

## Workarounds considered

| Option | Why not |
|---|---|
| Pin to < 1.2 with `allowImplicitFlow` | Freezes RSilo on a release that will miss security fixes, which defeats the point of adopting a maintained library. |
| Hybrid: library for `code`, hand-rolled implicit path | Two token stores and two validators. More code than now, not less. |
| Wait for remotestorage.js to ship code+PKCE for remoteStorage servers | Plausible eventually, but nothing in v2.0.0-beta.10 does this. Issue #2 (client IDs) would still remain. |

## Ideas worth borrowing (no dependency needed)

All four were implemented on 2026-10-12, with migration `0005_hash_oauth_secrets.sql` and tests in `test/token-hardening.test.ts`, building on the optional PKCE from PR #30, which this change makes required. Existing tokens are dropped, and apps reconnect once.

1. **Hash tokens at rest.** The library stores tokens, codes and secrets only as hashes ([`storage-schema.md`](https://github.com/cloudflare/workers-oauth-provider/blob/main/storage-schema.md)). RSilo stores `access_token`/`refresh_token` in plaintext in D1. Storing `SHA-256(token)` and looking it up by hash is a small change, and a leaked D1 export would no longer contain working tokens.
2. **PKCE (S256-only) on RSilo's `code` path.** RSilo's code exchange checks only `redirect_uri`. A public client with no PKCE is exactly what OAuth 2.1 forbids. The implicit path is unaffected.
3. **Refresh rotation with a one-step grace period.** The library keeps the previous refresh token valid until the new one is first used, so a client that lost the response can retry. RSilo invalidates it immediately.
4. **Unbiased token generation.** `generateToken`/`generateAuthCode` use `byte % 62`, which slightly favours the first characters. Base64url-encoding random bytes avoids that bias.
