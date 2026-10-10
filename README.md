# RSilo

> **Canonical repository:** [jonocodes/RSilo on GitHub](https://github.com/jonocodes/RSilo). The Codeberg mirror is deprecated.

A [RemoteStorage.io](https://remotestorage.io)-compatible personal storage server that runs on Cloudflare Workers, with a built-in web file manager and OAuth server.

**Why this exists:** to give anyone — especially people who aren't technical — their own free, self-hosted place to back up and sync app data. One person, a small amount of data, no monthly bill, no vendor lock-in. Each deployment (an *Instance*) serves exactly one *Account*; more accounts means more Instances ([ADR-0002](docs/adr/0002-instances-are-single-user.md)).

## What is RemoteStorage?

RemoteStorage is an open protocol for syncing app data across devices. A server advertises where data lives, apps ask for permission to a module (like `documents` or `pictures`), then read/write files over plain HTTP.

- **WebFinger** advertises your storage and auth endpoints
- **OAuth 2.0** scopes grant apps access to specific modules
- **HTTP REST** reads and writes files under `/storage/:username/:module/:path`

## Where to start

| If you want to… | Go to |
|-----------------|-------|
| Run your own server and connect your apps | [For admins](#for-admins-run-your-own-server) |
| Work on the code, extend it, or read the API | [For developers](#for-developers) |

---

# For admins: run your own server

This is for the person who owns the server. You deploy it once, protect `/account` with Cloudflare Access, then connect apps. You do not need to be technical or understand Cloudflare internals — the sections below walk you through it, and `bun run setup` does most of the work. There is nothing extra to remember: Cloudflare Access signs you in with a code sent to your email.

## What you get

- **Your account area** at `/account` — a dashboard with your storage address, quota usage and setting, and the apps you have granted access (revocable), plus a file manager to browse, upload, download, view, edit, and delete files
- **API reference** at `/api` — a generated page listing every endpoint the server exposes
- **OAuth + WebFinger** so RemoteStorage apps can connect
- **Public sharing** through the `public` module
- Everything fits inside Cloudflare's **free tier** (see [Running on the Cloudflare free tier](#running-on-the-cloudflare-free-tier))

## Deploy it

The service runs as a single Cloudflare Worker with two provisioned resources: **R2** (file storage) and **D1** (your account record and app tokens). Rate limiting uses Cloudflare's native rate-limit bindings, which are declared in `wrangler.toml` and need no setup.

Every Instance needs one setting, plain text (RSilo has no secrets):

- `OWNER_EMAIL` — your email; only you may open `/account`

Everything else has a default: your storage address is `me@<your Worker's host>`, and every URL RSilo advertises uses the address the Worker was reached at. Both deploy options below ask only for your email; the optional settings are in [Instance configuration](#instance-configuration). Afterwards you do one manual step in the Cloudflare dashboard: [Set up Cloudflare Access](#set-up-cloudflare-access). No custom domain is needed; the free `workers.dev` address works.

### Option A — Deploy to Cloudflare button (no CLI)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jonocodes/RSilo)

Clicking the button clones the repo into your account, asks you to name the Worker and its resources, **provisions R2 and D1 automatically**, runs migrations, and deploys. This is the friendliest path if you have never used Cloudflare before.

On the setup page, fill in `OWNER_EMAIL` with your email. If you skip it, add it afterwards (see [Change your sign-in email](#change-your-sign-in-email) for the click path); until then, `/account` shows a *finish setup* page that tells you exactly what to enter.

Then [set up Cloudflare Access](#set-up-cloudflare-access).

The committed `wrangler.toml` ships **placeholder** resource IDs so Cloudflare can detect and replace them with real ones in your account. Never commit your own IDs there — see [Deploying updates](#deploying-updates-to-your-own-instance). Its `OWNER_EMAIL` is empty on purpose: an empty value is never accepted, so a deploy that skipped it keeps `/account` closed behind the *finish setup* page.

### Option B — Command line

Prerequisites: a Cloudflare account with **R2 enabled** (R2 requires a payment method on file), plus `bun` and `wrangler`.

The bundled setup script creates the resources, writes a gitignored `wrangler.prod.toml` with their real IDs and your settings, runs migrations, and deploys:

```bash
bun install
wrangler login
bun run setup
```

It asks for one thing, your email. It deploys once, reads your `workers.dev` address from the deploy output, and prints your storage address (`me@<your-worker>.<subdomain>.workers.dev`), the numbered Access steps with your hostname filled in, and how to change your email later.

Re-running `bun run setup` is safe: it offers your saved email as the default (press Enter to keep it) and keeps any other saved settings. To run it without prompts, pass the email as a flag or environment variable. `--account-username` and `--public-base-url` are optional overrides (for example a custom domain); they are never prompted for:

```bash
bun run setup --owner-email=me@example.com
OWNER_EMAIL=me@example.com bun run setup
# optional overrides
bun run setup --owner-email=me@example.com --account-username=jono --public-base-url=https://rs.example.com
```

Then [set up Cloudflare Access](#set-up-cloudflare-access).

<details>
<summary>Manual CLI steps</summary>

```bash
bun install
wrangler login          # or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID

# Create the resources
wrangler r2 bucket create remotestorage
wrangler d1 create remotestorage-db
# copy wrangler.toml to wrangler.prod.toml (gitignored), put the printed
# database_id there, and fill in OWNER_EMAIL under [vars]

# Migrate and deploy (bun run deploy auto-detects wrangler.prod.toml)
bun run deploy
```

Alternatively, let wrangler provision the resources: delete the `database_id` line from `wrangler.prod.toml` and run `bun run deploy`. Wrangler creates the resources on first deploy; because `wrangler.toml`/`.prod.toml` are TOML, it will not write the new IDs back, so copy it from `wrangler d1 list` if you need them later.

</details>

Storage access tokens are opaque values stored in D1 (see [Authentication](#authentication)).

`MAX_OBJECT_SIZE_BYTES` optionally sets the maximum stored-object size. It defaults to 10 MiB and must be a positive integer.

### Instance configuration

Only `OWNER_EMAIL` is **required**. Set settings under `[vars]` in your `wrangler.prod.toml` (what `bun run setup` does) or in the Cloudflare dashboard (**Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, type *Text*). A missing or invalid `OWNER_EMAIL` closes only the human pages: `/account` and the consent page show a *finish setup* page, while storage, WebFinger and the OAuth token endpoint keep working, so apps already connected keep syncing. An *invalid* optional setting (for example a `PUBLIC_BASE_URL` with a path) makes every request `503` with a message naming it; delete it to go back to the default.

| Variable | Required | Purpose | Default | Dev-mode default |
|----------|----------|---------|---------|------------------|
| `OWNER_EMAIL` | **yes** | Your email address, exactly as your Cloudflare Access sign-in method reports it (the one-time-PIN address, or your Google/GitHub email — not necessarily your Cloudflare login). Only this identity (case-insensitive) may use `/account`. See [Change your sign-in email](#change-your-sign-in-email). | none | `alice@example.com` |
| `ACCOUNT_USERNAME` | no | The one Account this Instance serves (`[a-z0-9_.-]+`). It names the storage root `/storage/<ACCOUNT_USERNAME>/` and the storage address `<ACCOUNT_USERNAME>@<host>`, and is never derived from an email address. Set it only to keep an existing username (see [The Account row](#instance-configuration)). | `me` | `alice` |
| `PUBLIC_BASE_URL` | no | A canonical origin, e.g. a custom domain `https://rs.example.com` (no path). Every advertised URL — WebFinger, host-meta, the `/oauth/:user` discovery JSON, the consent URL and the storage root — is built from it. Unset, they are built from the origin the request arrived at, which on Cloudflare is always one of your Worker's own hostnames (Cloudflare's edge refuses any other `Host` with a `403` before the Worker runs). `X-Forwarded-Host` / `X-Forwarded-Proto` are never consulted. | the request's origin | `http://localhost:8787` (offline: `http://localhost:$PORT`) |

The dev-mode defaults apply only when `RSILO_DEV_MODE=true`; an invalid value is rejected even in dev mode. Dev mode keeps `alice` so local tooling and the spec-check run unchanged.

`bun run deploy` (and `bun run setup`) never blank a value you set in the dashboard: they leave empty `[vars]` entries out of the deploy and pass `--keep-vars`, so dashboard values the config does not mention survive. A non-empty value in your config wins over the dashboard. A bare `wrangler deploy` of the committed `wrangler.toml` would overwrite them with the empty placeholders, so deploy with `bun run deploy`.

**The Account row.** The first request that needs it creates the `users` row for `ACCOUNT_USERNAME` (an idempotent insert; the check is cached per Worker isolate). If that row is missing **and** the table already holds other users — you changed `ACCOUNT_USERNAME`, or migrated a multi-user deployment — RSilo will not create a second row: storage returns `503` and `/account` and the consent page show a *username mismatch* message. Set `ACCOUNT_USERNAME` to the existing account you want to keep: the `/account` page (shown only to you, the Owner) names the stored username and gives the exact click path; the public storage `503` never names it. Other rows are ignored, not deleted. Because the default is `me`, an Instance created before `ACCOUNT_USERNAME` became optional keeps its username only while the setting stays in place; if it was removed, the mismatch page tells you what to set it back to.

### Deploying updates to your own instance

The committed `wrangler.toml` holds placeholder IDs so the Deploy to Cloudflare button works for everyone. Your real, account-specific IDs live in the gitignored `wrangler.prod.toml`, written by `bun run setup`.

`bun run deploy` uses `wrangler.prod.toml` automatically when it exists, so shipping an update is just:

```bash
bun run deploy
```

If `wrangler.prod.toml` is missing, it falls back to the committed `wrangler.toml` — the path Cloudflare's button uses, where the IDs are injected for you. To rebuild the prod config after provisioning new resources, re-run `bun run setup` (or copy `wrangler.toml` and paste in the IDs by hand).

### Automatic deploys (Cloudflare Workers Builds)

To release on every push to `main`, connect the repository to your Worker using Cloudflare's native Git integration — Cloudflare then owns the deploy token, so nothing needs to live in GitHub.

1. Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings → Builds** → connect the Git repository.
2. Set the **production branch** to `main`, and leave preview builds off (or on) as you prefer.
3. Set the **deploy command** to:

   ```bash
   bun run deploy
   ```

4. No build variables are needed. On the build, `bun run deploy` finds your D1 database by name (`remotestorage-db`), materialises `wrangler.prod.toml` for it, applies D1 migrations, and deploys, so a recreated database is picked up automatically. If you gave `bun run setup` other names with `RSILO_BUCKET` / `RSILO_DB`, add the same two as **Build variables**. A `D1_DATABASE_ID` build variable from older instructions is ignored; you can delete it.
5. Keep `OWNER_EMAIL` (and `ACCOUNT_USERNAME` / `PUBLIC_BASE_URL`, if you set them) in the Worker's **Variables and Secrets** (type *Text*); builds keep them.

`bun run deploy` uses the same entry point in both places, so local and CI deploys stay identical.

## Set up Cloudflare Access

RSilo has no password of its own. **Cloudflare Access** signs you in to your account area (`/account`), for example with a one-time code sent to your email, and RSilo then checks that the signed-in email is your `OWNER_EMAIL`. Access is part of Cloudflare **Zero Trust**, whose free plan covers a single person and needs no payment method. You do this once, after either deploy option; `bun run setup` prints these steps with your address filled in.

1. Open the Zero Trust dashboard, [one.dash.cloudflare.com](https://one.dash.cloudflare.com/). If it is your first time, pick a team name and the **Free** plan.
2. Go to **Access → Applications → Add an application**, choose **Self-hosted**, and name it **RSilo**.
3. Add a public hostname: the **domain** is your Worker's address without `https://`, e.g. `rsilo.<your-subdomain>.workers.dev`, and the **path** is `account`. No custom domain is needed.
4. Add a policy: action **Allow**, include **Emails**, and enter exactly your email (the same as `OWNER_EMAIL`).
5. Under login methods, keep **One-time PIN** (or choose another identity provider, such as Google or GitHub).
6. Save the application.
7. Open `https://rsilo.<your-subdomain>.workers.dev/account`. Access asks for your email, sends you a code, and you land on your dashboard.

**Optional: sign in less often.** An Access session lasts 24 hours by default, after which you get a new code. To stretch it to the maximum of one month, set it in both places (the global session covers the sign-in that renews the app's session):

- **Access → Applications → RSilo → Edit → Session Duration:** 1 month.
- **Settings → Authentication → Global session timeout:** 1 month.

The trade-off is that anyone using your unlocked browser can open `/account` for up to a month; **Sign out** ends the session at any time. The new length applies from your next sign-in.

> **Do not** turn on the Worker-level Access toggle (the "protect this Worker" / `workers.dev` Access switch in the Worker's settings). It locks the *whole* Worker, including `/storage` and WebFinger, so your apps could no longer reach your data. Only `/account` should be behind Access; apps use their own tokens for everything else.

Nothing needs to be set in RSilo after creating the Access application.

**What the pages you might see mean:**

- ***Finish setup* (503).** Shown on `/account` (and the consent page) when they are not ready yet. It has up to three parts:
  - **Set your sign-in email (OWNER_EMAIL)** — `OWNER_EMAIL` is missing or not an email address. If you are already signed in through Access, the page says *"You're signed in through Cloudflare Access as …"* and shows that email ready to copy: set `OWNER_EMAIL` to exactly that. It gives the click path (**Workers & Pages → \<worker name\> → Settings → Variables and Secrets → Add → Type: Text, Variable name: OWNER_EMAIL, Value: your email → Deploy**; for an invalid value, edit the existing one instead). It never repeats an invalid value back. Apps already connected keep syncing meanwhile.
  - **Turn on Cloudflare Access** — Access is not in front of `/account` yet: repeat the steps above, and check the domain and the `account` path. Until then nobody can open `/account` or approve an app, so a fresh deploy is safe. When both parts apply, the email part comes first.
  - **Invalid settings** — an optional setting such as `ACCOUNT_USERNAME` or `PUBLIC_BASE_URL` is set to an invalid value (named, not repeated); fix or delete it.
- ***Not allowed* (403).** You signed in through Access, but with an email other than `OWNER_EMAIL`; the page shows the email it saw (never the configured one) and the two places to update if you changed your sign-in email (see [Change your sign-in email](#change-your-sign-in-email)). Getting back in depends only on your Cloudflare account; there is no RSilo password to recover.
- ***Username mismatch* (503).** `ACCOUNT_USERNAME` (default `me`) does not match the account already stored. The page names the stored username and the click path to set `ACCOUNT_USERNAME` to it; see [The Account row](#instance-configuration).

**Sign out** (in the `/account` header) goes to `/cdn-cgi/access/logout`. It ends your RSilo Access session, not your login at your email or identity provider.

Every state-changing `/account` request must come from the page itself (`Sec-Fetch-Site: same-origin`, or an `Origin` equal to the public origin — `PUBLIC_BASE_URL`, or the request's own origin when unset); cross-site posts get `403`.

## Change your sign-in email

Your dashboard shows **Signed in as \<email\>** and a **Change your sign-in email** section with these steps. The email lives in two places, and both must change, in the Cloudflare dashboard:

1. **The Worker's `OWNER_EMAIL`:** **Workers & Pages → \<worker name\> → Settings → Variables and Secrets → OWNER_EMAIL → Edit → Deploy** (or re-run `bun run setup --owner-email=new@example.com`).
2. **The Access application's Allow policy:** **Zero Trust → Access → Applications → RSilo app → Policies**, and include the new email. Otherwise Access will not let the new email through at all.

If you update only the policy, you will see the *Not allowed* page, which shows the email you signed in with. If you unset `OWNER_EMAIL`, `/account` shows the *finish setup* page again (apps keep syncing) and, once you sign in through Access, offers your signed-in email to copy.

## Change your storage quota

Your `/account` dashboard shows how much you have stored against your quota (10 GiB by default). To change it, enter a new value in GB under the usage bar and press **Save**. The quota is a limit you set for yourself, for example to stay inside R2's free tier. Setting it below what is already stored keeps your files but blocks new writes until you free up space or raise it.

## Upgrading an existing deployment

Older RSilo versions had their own usernames and passwords, an admin console and admin secret, and could hold several users. To move such a deployment to Cloudflare Access:

1. Set the settings in the Worker's **Variables and Secrets** (or under `[vars]` in `wrangler.prod.toml`, or by re-running `bun run setup --owner-email=… --account-username=…`). `OWNER_EMAIL` is your email; `ACCOUNT_USERNAME` must be the **existing** username whose data you want to keep (unless it is already `me`). `PUBLIC_BASE_URL` is optional; an existing value keeps working.
2. [Set up Cloudflare Access](#set-up-cloudflare-access).
3. Deploy with `bun run deploy`. It applies migration `0003`, which drops the stored passwords.

Apps you already connected keep working: their tokens are unchanged, and apps that cached the old consent address are redirected to the new one. Any other users on the deployment become unreachable — their data and tokens are left in place, not deleted. For a second person, deploy a second Instance. Old admin secrets and password settings are no longer read; you can delete them from the Worker's settings.

## Connect a RemoteStorage app

Apps do **not** need any setup on your side — there is no client registration step. The first time an app asks for access it is registered automatically and appears on your `/account` dashboard.

1. In the app, enter your storage address, shown on your dashboard: `me@<your-worker>.<subdomain>.workers.dev` (or `<ACCOUNT_USERNAME>@…` if you set one) or, if the app supports it, just the server URL `https://<your-worker>.<subdomain>.workers.dev`.
2. The app discovers your endpoints via WebFinger and sends you to the consent page, `/account/oauth/authorize`. It is part of `/account`, so Cloudflare Access signs you in first if you are not already.
3. The page shows the app (by its origin host), the modules it asks for and whether it wants read-only or read-write access, and **where it will send you back to**. Allow or deny.
4. The app gets a token and starts syncing into that module.

Your `/account` dashboard lists each app once, by its origin host, with the modules it can access and when it was first granted and last issued a token. **Revoke** removes all of that app's tokens at once; it loses access immediately.

Because apps are not registered in advance, an app is identified by its `client_id`, which must be an `http(s)` URL, and it may only be sent back to a `redirect_uri` on that same origin. Any other request gets a `400` error page and no redirect. If your Access session expires while the consent page is open, the approval is lost to the Access sign-in; reload the page (all its parameters are in the URL) and allow again.

## Share a file publicly

Files written under `public/<module>/` are readable by anyone — no token needed. Folder listings still require auth. The write uses the same `<module>` scope as the private data:

```bash
bun run dev-token alice 'documents:rw'
# then PUT to /storage/alice/public/documents/hello.txt and GET it without auth
```

## One Account per Instance

An Instance serves only `ACCOUNT_USERNAME`: WebFinger resolves no other user, the `/oauth/<username>/…` endpoints return `404` for any other username (consent is always for the Account), and every `/storage/<username>/…` request for another username is refused (`401` without a token, `403` with one, including anonymous `public/` reads). If you migrate a deployment that had several users, every other user's data and tokens become unreachable; their rows, R2 objects and tokens are left in place, not deleted. For a second account, deploy a second Instance.

## Running on the Cloudflare free tier

RSilo is built for a *small personal backup*, not a business service — and it fits comfortably inside Cloudflare's free tier.

**The one thing to watch: R2 is the only part that can ever cost money.** Workers and D1 simply stop working once their free limits are reached. R2 instead bills overage once you pass its free allowance — and because Cloudflare requires a payment method to enable R2, that overage is charged automatically.

As of **October 2026**, R2's free tier covers roughly **10 GB of storage**, **1 million writes/listings**, and **10 million reads** per month, with free egress. Cloudflare changes these numbers and prices over time, so treat them as a rough guide and check the current values on the [R2 pricing page](https://developers.cloudflare.com/r2/pricing/). For a personal notes/todos/photos backup this allowance is far more than you will use.

Roughly, uploads and folder listings count as "writes" (Class A), downloads and metadata as "reads" (Class B), and deletes are free.

### Staying free

1. **Stay on the Workers Free plan.** Free Workers hard-stop at their daily request limit; the Paid plan auto-bills overages with no hard switch.
2. **Keep the bucket private.** Do not enable the r2.dev public URL or attach a custom domain to the bucket. RSilo serves everything through the Worker (including the `public` module), and R2 does not bill unauthorized requests. A public bucket would also let callers bypass the Worker entirely.
3. **Use Standard storage only.** Infrequent Access has no free tier and bills from the first operation — even from viewing the bucket in the dashboard.
4. **Set a budget alert as an early warning.** In the Cloudflare dashboard go to **Manage Account → Billing → Billable Usage → Create budget alert** (or **Notifications → Add → Budget Alert**) and set a low threshold. You'll get an email if spend starts to rise. It is only a warning — Cloudflare has no built-in hard spending cap for R2, and per-product billing notifications require a Professional plan or higher.
5. **For a hard guarantee, cap usage in the Worker.** Since every write goes through `PUT /storage/...`, a global storage ceiling plus a monthly Class A operation counter is the only way to make $0 a certainty. Not implemented yet. For visibility, Cloudflare's built-in R2 metrics already break operations down by Class A/B per bucket — see the bucket's **Metrics** tab or query the `r2OperationsAdaptiveGroups` GraphQL dataset — which is enough for the intended single-user setup.

> RemoteStorage clients never talk to R2 directly — they speak HTTP to the Worker, which reaches R2 through the binding. "Private bucket" and working RemoteStorage clients are not in conflict.

---

# For developers

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                      │
│                                                           │
│  ┌──────────┐ ┌───────┐ ┌─────────┐ ┌───────┐ ┌───────┐ │
│  │WebFinger │ │ OAuth │ │ Storage │ │Account│ │ Debug │ │
│  └──────────┘ └───────┘ └─────────┘ └───────┘ └───────┘ │
└──────────────────────────────────────────────────────────┘
         │                    │                │
    ┌────▼────┐          ┌────▼────┐    ┌──────▼──────┐
    │   R2    │          │   D1    │    │ Rate limits │
    └─────────┘          └─────────┘    └─────────────┘
```

For offline development: R2 → local filesystem, D1 → SQLite (via a D1-compatible adapter), rate limiting → skipped.

The routes talk to storage through a small `StorageInterface`. In production `getStorage()` wraps the raw R2 binding in `R2Storage`; offline it returns the `LocalStorage` instance directly. See `src/services/r2.ts`.

## Local development (offline)

No Cloudflare account needed:

```bash
bun install
bun run db:setup:local   # creates data/remotestorage.db + data/storage/
bun run dev:offline      # http://localhost:8787 with live reload
```

`bun run dev:offline` explicitly enables local-development mode: the Instance serves the Account `alice` at `http://localhost:8787`, owned by `alice@example.com` (set `ACCOUNT_USERNAME` / `OWNER_EMAIL` / `PUBLIC_BASE_URL` to override; the default origin follows `PORT`). Its storage address is `alice@localhost:8787`. With no Cloudflare Access in front of it, requests to `localhost`, `127.0.0.1` or `[::1]` are signed in as a **dev identity** — `RSILO_DEV_EMAIL`, defaulting to `OWNER_EMAIL` (set it to another address to preview the "not allowed" page). The dev identity is unreachable unless `RSILO_DEV_MODE=true`, the host is local and no Access identity is present, so it cannot leak into production. The same guard exposes the debug endpoints at `/debug/*` (see [docs/api.md](docs/api.md)); in production they are a 404. `bun run dev` runs `wrangler dev`; copy `.dev.vars.example` to `.dev.vars` to configure it and explicit local-development mode.

## API reference

The server exposes one OpenAPI surface:

```
GET    /api              Scalar UI (documentation only — no request console)
GET    /openapi.json     The OpenAPI 3.1 spec
```

A static, always-current list of every endpoint lives in **[docs/api.md](docs/api.md)**. The spec is derived from `app.routes` and a metadata registry, so it cannot drift: `bun run docs:api` regenerates the static list, `bun run docs:api:check` verifies it without writing, and a test (run in CI) fails if it is stale.

## Authentication

### OAuth flow (production)

1. App queries WebFinger to discover auth and storage endpoints (see [Discovery](#discovery))
2. App redirects user to the advertised consent URL, `/account/oauth/authorize?client_id=...&redirect_uri=...&response_type=code&scope=documents:rw&state=...`
3. The Owner reviews the requested scopes and approves (their identity comes from Cloudflare Access; see [Set up Cloudflare Access](#set-up-cloudflare-access)). Approve and deny are `/account` form posts, so they get the same-origin check.
4. Server redirects back with `?code=...`
5. App exchanges code at `/oauth/:user/token` → `access_token` (1-hour expiry) + `refresh_token`
6. App uses `Authorization: Bearer <access_token>` on storage requests
7. When the access token expires, exchange the refresh token at `/oauth/:user/token` with `grant_type=refresh_token`

Both `response_type=code` (authorization code) and `response_type=token` (implicit) are supported. The consent page is always for the Account, so its URL has no username; tokens are always issued for the Account, and `/oauth/:user/token` returns `404` when `:user` is not `ACCOUNT_USERNAME`. The token endpoint stays outside `/account` and is not behind Access, since apps call it directly.

Per protocol §10, `client_id` must be an `http(s)` URL and `redirect_uri` an `http(s)` URL on the same origin; otherwise the consent page (on `GET` and on approve or deny) answers `400` with a plain-text error and never redirects.

The consent page used to be `/oauth/:user/authorize`. Apps (remoteStorage.js) cache discovery results, so that URL still answers `GET` with a `302` to `/account/oauth/authorize`, passing the query string through unchanged. `POST` there returns `405`, and any `:user` other than the Account returns `404`.

### Discovery

WebFinger (`/.well-known/webfinger`, `/webfinger/jrd`, `/webfinger/xrd`) accepts exactly these resources, all resolving to the Account:

- `acct:<ACCOUNT_USERNAME>@<host>` — username and host compared case-insensitively
- the host-only form `http://<host>` or `https://<host>`, with or without a trailing slash

`<host>` must equal the public host — the `PUBLIC_BASE_URL` host when set, otherwise the host the request arrived at — including any non-default port (`acct:alice@localhost:8787` in dev); `acct:` resources may also omit the port (`acct:alice@localhost`). Any other resource returns `404` on every discovery route, as does `/oauth/:user` for any user but the Account. All advertised URLs come from that public origin (one resolver, `getInstanceConfig` in `src/config.ts`), never from `X-Forwarded-Host` / `X-Forwarded-Proto`. Without `PUBLIC_BASE_URL` the request's origin is trusted because Cloudflare's edge rejects a request whose `Host` is not one of the Worker's own hostnames (`403`) before the Worker runs; the offline Node server, which has no such edge, pins its origin to `http://localhost:$PORT`.

```bash
curl 'http://localhost:8787/.well-known/webfinger?resource=acct:alice@localhost:8787'
curl 'http://localhost:8787/.well-known/webfinger?resource=http://localhost:8787/'
```

Access tokens are **opaque bearer tokens**: random strings stored as rows in the D1 `oauth_tokens` table. A token is valid exactly while its unexpired row exists, so revoking an app (deleting its row) takes effect on the very next request. Self-contained signed tokens are never accepted, in production or in local-development mode ([ADR-0003](docs/adr/0003-opaque-bearer-tokens-only.md)).

### Dev tokens (testing only)

`bun run dev-token` inserts an opaque token row (30-day expiry) into a local database and prints the token. It creates the user and a `dev-token:<username>` client if they do not exist yet.

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
| `*:rw` | Read and write all modules |

Module names are arbitrary — any name works. Files under `public/<module>/` are readable without auth (files only; folder listings require auth).

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
src/
  index.ts            Worker entry (Hono app)
  server-offline.ts   Offline dev server (Node + local filesystem/SQLite)
  routes/             storage, webfinger, oauth (discovery, token, legacy consent redirect), account,
                      consent (/account/oauth/authorize), debug, mount (shared route table)
  config.ts           per-Instance config (OWNER_EMAIL required; ACCOUNT_USERNAME, PUBLIC_BASE_URL defaults) and dev defaults
  services/           auth, identity (Owner resolver: Cloudflare Access or dev identity; CSRF check),
                      account (Account row lifecycle), discovery (advertised URLs, WebFinger
                      matching), r2 (+ getStorage adapter), local-storage, db/
  middleware/         auth, cors, instance (config + Account gates), owner (/account gate + CSRF)
  ui/                 account client script, setup and not-allowed pages
  protocol/           constants (ETag normalisation, path validation)
  scripts/            setup (+ setup-config: pure, unit-tested helpers), deploy, dev-token, setup-local-db
drizzle/migrations/   D1 migrations
test/                 unit, compliance and E2E suites
```

## Testing

```bash
bun run test             # all tests (fast, mocked + offline server E2E)
bun run test:watch       # watch mode
bun run typecheck        # source tsc --noEmit
bun run typecheck:test   # test-suite tsc --noEmit
bun run lint             # eslint src and test
bun run test -- test/e2e/storage-e2e.test.ts  # one E2E suite
```

**627 tests** across 31 files: protocol compliance (RemoteStorage, WebFinger, edge cases), single-Account discovery and the Account row lifecycle, optional-config defaults and the setup pages, storage, auth, rate limiting, OAuth and the consent page, Cloudflare Access identity and CSRF, the account dashboard, debug/observability, wrangler config, the setup script (against a fake wrangler), file manager, quota accounting, D1/R2 adapters, migration/schema checks, and E2E against the offline server.

## Known limitations

- **Rate limiting is per Cloudflare location** — the native rate-limit bindings count per data centre, not globally, so a distributed attacker gets more attempts. Storage counts only failed authentication (20 per 60s per IP), so syncs with a valid token are never throttled. Production fails closed with `503` when a limiter binding is missing; local-development mode skips limiting. KV is deliberately not used: its free tier allows only 1,000 writes a day, which per-request counters exhaust in minutes (#7)
- **Buffered uploads** — upload bodies are bounded by `MAX_OBJECT_SIZE_BYTES` but buffered before storage so quota deltas can be reserved accurately; downloads stream

## References

- [RemoteStorage Protocol Spec](https://remotestorage.io/protocol.html)
- [RemoteStorage.js (client library)](https://remotestorage.io/integrate/)
- [Armadietto (Node.js reference impl)](https://github.com/remotestorage/armadietto)
- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
