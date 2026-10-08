# Delegate human authentication to Cloudflare Access

RSilo authenticates the owner of an instance, but running its own password/session system meant password hashing, session cookies, an `ADMIN_SECRET`, and a first-user bootstrap race. We decided the human-facing surfaces (`/account/*`, including the OAuth consent dialog) are gated by Cloudflare Access, and the Worker validates the `Cf-Access-Jwt-Assertion` JWT; RSilo stores no human password and issues no browser session. The trade is a hard dependency on Cloudflare Zero Trust for the web UI: an instance is inert and unusable until Access is configured, and local development needs an identity-bypass seam.

Status: accepted

## Considered Options

- **Keep in-app password auth** — rejected: retains the entire password/session subsystem plus the bootstrap and recovery problems.
- **Keep `ADMIN_SECRET` as a break-glass second identity** — rejected: two human identities for one person; access to the Cloudflare account (reconfiguring the Access policy/IdP) is the recovery path instead.

## Consequences

- Password hashing, session tokens, `SESSION_SECRET`, and `ADMIN_SECRET` are removed.
- `OWNER_EMAIL` is the only required configuration; `ACCOUNT_USERNAME` (default `me`, see ADR-0002) and `PUBLIC_BASE_URL` (default: the request's own origin) are optional. A missing or invalid `OWNER_EMAIL` closes only the human surfaces (`/account/*`, including consent) behind the finish-setup page; storage, WebFinger and the token endpoint keep serving already-connected apps. That page reveals only the visitor's own Access email (offered as the value to set) and config names, never a configured value; the 403 page shows the signed-in email but never `OWNER_EMAIL`.
- Without `PUBLIC_BASE_URL`, advertised URLs (including the consent URL) use the request's origin. This is safe on Workers because Cloudflare's edge rejects a request whose `Host` is not one of the Worker's hostnames (403, verified 2026-10-08); `X-Forwarded-*` is never read. A hostname that Access does not cover has no `ctx.access`, so `/account` there fails closed to the finish-setup page rather than routing around the gate. The CSRF `Origin` check compares against the same resolved origin.
- The Worker reads the Owner's identity from the platform-provided `ctx.access.getIdentity()` (confirmed on a path-based self-hosted Access app over `<worker>.workers.dev/account`) and admits only `OWNER_EMAIL`, case-insensitively. It parses no JWT, holds no JWKS, and ignores the `Cf-Access-Jwt-Assertion` header and `CF_Authorization` cookie, so there is no `ACCESS_TEAM_DOMAIN` or `ACCESS_POLICY_AUD`; the email check is what makes an over-broad policy or another Access application on the account harmless.
- Local dev and tests use a dev-only identity resolver, reachable only when `RSILO_DEV_MODE=true`, `ctx.access` is absent, and the request host is local; an Access identity always wins.
- Without Access in front of `/account` the Instance shows a finish-setup page; state-changing `/account` requests must be same-origin (`Sec-Fetch-Site`, else `Origin`), since there is no RSilo session to bind a CSRF token to.
- The `auth-dialog` credential step is out of scope per remoteStorage protocol §10, so replacing the password with an Access login is spec-compliant.
