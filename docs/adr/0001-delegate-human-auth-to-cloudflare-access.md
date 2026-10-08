# Delegate human authentication to Cloudflare Access

RSilo authenticates the owner of an instance, but running its own password/session system meant password hashing, session cookies, an `ADMIN_SECRET`, and a first-user bootstrap race. We decided the human-facing surfaces (`/account/*`, including the OAuth consent dialog) are gated by Cloudflare Access, and the Worker validates the `Cf-Access-Jwt-Assertion` JWT; RSilo stores no human password and issues no browser session. The trade is a hard dependency on Cloudflare Zero Trust for the web UI: an instance is inert and unusable until Access is configured, and local development needs an identity-bypass seam.

Status: accepted

## Considered Options

- **Keep in-app password auth** — rejected: retains the entire password/session subsystem plus the bootstrap and recovery problems.
- **Keep `ADMIN_SECRET` as a break-glass second identity** — rejected: two human identities for one person; access to the Cloudflare account (reconfiguring the Access policy/IdP) is the recovery path instead.

## Consequences

- Password hashing, session tokens, `SESSION_SECRET`, and `ADMIN_SECRET` are removed.
- `ACCESS_TEAM_DOMAIN` and `ACCESS_POLICY_AUD` become configuration; the Worker validates a single Access application's JWT.
- Local dev and tests require a dev-only identity resolver, guarded by `RSILO_DEV_MODE` and impossible to enable in production.
- The `auth-dialog` credential step is out of scope per remoteStorage protocol §10, so replacing the password with an Access login is spec-compliant.
