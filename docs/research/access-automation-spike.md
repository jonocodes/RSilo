# Can `bun run setup` create the Cloudflare Access app itself?

> **Status:** a snapshot from 2026-11-06, the spike for [#61](https://github.com/jonocodes/RSilo/issues/61). It was built from these findings: `src/services/cloudflare-access.ts`.

Checked 2026-11-06 against wrangler 4.147.0, Cloudflare's API docs, and read-only calls to the Access API of the production account. Anything not settled that way is marked **unverified**.

**Verdict:** yes, with a separate API token. Wrangler's login cannot manage Access. The token is pre-filled from one link, so the Owner's seven error-prone dashboard steps become three mechanical ones (open the link, create the token, paste it). Nothing in those three can produce a wrong hostname, path or email. The one thing setup cannot do is a first-time Zero Trust sign-up; it detects that and sends the Owner to that single page.

## Credentials

- `wrangler login`'s OAuth scopes (the list in `wrangler-dist/cli.js`, and `wrangler whoami --json` → `tokenPermissions`) have no Access scope. `wrangler login --scopes` only accepts scopes from that list. So setup needs an API token.
- The token needs **Access: Apps and Policies → Edit** (the apps and their policies) and **Access: Organizations, Identity Providers, and Groups → Edit** (to read the organization, and to add the One-time PIN login method if it is missing).
- Cloudflare's dashboard opens a pre-filled token form from a URL ([token templates](https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/)): `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=[{"key":"access","type":"edit"},{"key":"access_acct","type":"edit"}]&accountId=<id>&zoneId=all&name=RSilo%20Access` (JSON URL-encoded). **Unverified:** that `accountId=<a real id>` (rather than `*`) preselects that account. The docs only show `*`.
- `wrangler whoami --json` lists the accounts, so setup knows the account id without asking when there is one.

## The app's shape

From `GET /accounts/:id/access/apps` on the production Instance's hand-made app:

- `type: "self_hosted"`, `domain: "<host>.workers.dev/account"`, `self_hosted_domains: [same]`, `destinations: [{ type: "public", uri: same }]`. The API takes a `workers.dev` hostname plus path, the same as the dashboard does (ADR-0001).
- `allowed_idps: [<one-time PIN idp id>]` with `auto_redirect_to_identity: true`.
- `policies[]` with `decision`, `include: [{ email: { email } }]`, `reusable`, `precedence`. App-scoped policies come back `reusable: false`; reusable ones (`/access/policies`) are shared between apps and carry `app_count`.
- Inline policy objects are accepted in the `POST /access/apps` body (API reference: "Reusable and inline policies are mutually exclusive"). **Unverified until `test/cloudflare-access-live.test.ts` runs:** the exact create and update bodies setup sends. The guard on this machine blocked creating a throwaway app during the spike.

## One-time PIN

- It is an identity provider of `type: "onetimepin"` (`GET /access/identity_providers`). It existed on the production account.
- `allowed_idps` defaults to all of the account's IdPs. **Unverified:** whether a brand-new Zero Trust organization has the PIN IdP already. Setup creates it when missing, so it does not matter.

## First-time Zero Trust

- `POST /accounts/:id/access/organizations` exists (`name`, `auth_domain`), but choosing the plan (Free) is a dashboard step. **Unverified:** whether the API alone gives a working free organization, and what `GET /access/organizations` returns on an account that never set up Zero Trust. Setup treats a client error (4xx) other than 401/403/429 as "not set up yet", quotes Cloudflare's answer, and links the sign-up page; a 5xx stays an error and falls back to the manual steps.

## Left for later

- A standalone command for Deploy-button Instances (`bunx rsilo-access …`), as #61 suggests.
- Other sign-in methods (#27): setup only sets `allowed_idps` when it creates the app, and leaves an existing app's login methods alone.
