# Self-hosting: run your own server

This is for the person who owns the server. You deploy it once, protect `/account` with Cloudflare Access, then connect apps. You do not need to be technical or understand Cloudflare internals — the sections below walk you through it, and `bun run setup` does most of the work. There is nothing extra to remember: Cloudflare Access signs you in with a code sent to your email.

## Deploy it

The service runs as a single Cloudflare Worker with two provisioned resources: **R2** (file storage) and **D1** (your account record and app tokens). Rate limiting uses Cloudflare's native rate-limit bindings, which are declared in `wrangler.toml` and need no setup. If you would rather not put a payment method on file for R2, your files can live in an S3-compatible bucket instead, such as Backblaze B2's free tier (see [Use an S3 bucket instead of R2](#use-an-s3-bucket-instead-of-r2)).

Every Instance needs one setting, plain text (with R2, RSilo has no secrets):

- `OWNER_EMAIL` — your email; only you may open `/account`

Everything else has a default: your storage address is `me@<your Worker's host>`, and every URL RSilo advertises uses the address the Worker was reached at. Both deploy options below ask only for your email; the optional settings are in [Instance configuration](#instance-configuration). Afterwards you do one manual step in the Cloudflare dashboard: [Set up Cloudflare Access](#set-up-cloudflare-access). No custom domain is needed; the free `workers.dev` address works.

### Option A — Deploy to Cloudflare button (no CLI)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jonocodes/RSilo)

Clicking the button clones the repo into your account, asks you to name the Worker and its resources, **provisions R2 and D1 automatically**, runs migrations, and deploys. This is the friendliest path if you have never used Cloudflare before.

On the setup page, fill in `OWNER_EMAIL` with your email. If you skip it, add it afterwards (see [Change your sign-in email](#change-your-sign-in-email) for the click path); until then, `/account` shows a *finish setup* page that tells you exactly what to enter.

Then [set up Cloudflare Access](#set-up-cloudflare-access). Your copy of the repository does not pick up later RSilo fixes by itself; see [Updating a Deploy-button Instance](#updating-a-deploy-button-instance).

The committed `wrangler.toml` ships **placeholder** resource IDs so Cloudflare can detect and replace them with real ones in your account. Never commit your own IDs there — see [Deploying updates](#deploying-updates-to-your-own-instance). Its `OWNER_EMAIL` is empty on purpose: an empty value is never accepted, so a deploy that skipped it keeps `/account` closed behind the *finish setup* page.

### Option B — Command line

Prerequisites: a Cloudflare account with **R2 enabled** (R2 requires a payment method on file) or [an S3 bucket](#use-an-s3-bucket-instead-of-r2), plus `bun` and `wrangler`.

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

</details>

Storage access tokens are opaque values stored in D1 (see [Authentication](api.md#authentication)).

### Use an S3 bucket instead of R2

R2 needs a payment method on file, and once one is there any overage is charged automatically. To avoid that, RSilo can keep your files in any S3-compatible bucket instead. The Worker, D1 and Cloudflare Access stay as they are, and none of them need a payment method. See [ADR-0005](adr/0005-s3-compatible-storage-backend.md).

**Backblaze B2** is a good free choice: 10 GB at no cost, and no card needed to sign up (check [their pricing](https://www.backblaze.com/cloud-storage/pricing) for current terms).

1. Create a B2 account. Under **Buckets → Create a Bucket**, make a **private** bucket, e.g. `rsilo-yourname`. Note its **Endpoint**, e.g. `s3.us-west-004.backblazeb2.com`.
2. Under **Application Keys → Add a New Application Key**, allow access to that bucket only, with *Read and Write*. Note the **keyID** and the **applicationKey**. The key is shown only once.
3. Run setup with the bucket details. Pass the secret key in the environment (or leave it out and the script asks for it, with the input hidden):

   ```bash
   S3_SECRET_ACCESS_KEY=<applicationKey> bun run setup \
     --owner-email=me@example.com \
     --s3-endpoint=https://s3.us-west-004.backblazeb2.com \
     --s3-bucket=rsilo-yourname \
     --s3-access-key-id=<keyID>
   ```

   Setup then skips R2 completely: it neither checks nor creates a bucket, and it leaves the R2 binding out of `wrangler.prod.toml`. It writes the S3 settings under `[vars]` and stores the key as the Worker secret `S3_SECRET_ACCESS_KEY`, which is never written to a file. On a re-run it keeps the existing secret unless you pass a new one.

Things to know:

- **This is CLI only.** The Deploy to Cloudflare button always provisions R2. With [Workers Builds](#automatic-deploys-cloudflare-workers-builds), also add the build variable `RSILO_STORAGE=s3` so the R2 binding is left out of the build.
- **Daily transaction allowance.** B2's free tier includes 2,500 Class B and 2,500 Class C calls a day. Apps re-check the folders they sync every few seconds; while a folder is unchanged, RSilo answers that from D1 and makes no B2 call. Fetching a folder that changed costs one Class C call (per 1,000 files below it). Each file download or unchanged-file check costs one Class B call. An upload costs one Class B call per segment of its path (checking the file's current version and write condition, and that no folder above it is a file) and one Class C call (checking that it is not a folder); a delete costs one Class B call. A light personal setup stays well inside this, but an app that re-syncs very often may not. Under **Caps & Alerts** in B2, set the daily caps to $0 so you are never billed; extra calls are then refused until the next day.
- **Switching an existing Instance copies nothing.** If you move from R2 to S3 (or back), copy the bucket's contents first, for example with [rclone](https://rclone.org/), keeping the `users/` key layout. The storage usage figure on `/account` is not recomputed.
- **Other providers work too**: AWS S3, Wasabi, Storj, iDrive e2, a MinIO server, or R2's own S3 endpoint. Set `S3_REGION` if your provider needs a region that is not part of its endpoint host.
- **SeaweedFS**: run it with `-s3.allowBackslashInKey` (4.49 and later). Without it, SeaweedFS turns `\` in a key into `/`, so a file whose name contains a backslash overwrites a different path ([seaweedfs#11908](https://github.com/seaweedfs/seaweedfs/issues/11908)).

### Instance configuration

Only `OWNER_EMAIL` is **required**. Set settings under `[vars]` in your `wrangler.prod.toml` (what `bun run setup` does) or in the Cloudflare dashboard (**Workers & Pages → your Worker → Settings → Variables and Secrets → Add**, type *Text*). A missing or invalid `OWNER_EMAIL` closes only the human pages: `/account` and the consent page show a *finish setup* page, while storage, WebFinger and the OAuth token endpoint keep working, so apps already connected keep syncing. An *invalid* optional setting (for example a `PUBLIC_BASE_URL` with a path) makes every request `503` with a message naming it; delete it to go back to the default.

| Variable | Required | Purpose | Default | Dev-mode default |
|----------|----------|---------|---------|------------------|
| `OWNER_EMAIL` | **yes** | Your email address, exactly as your Cloudflare Access sign-in method reports it (the one-time-PIN address, or your Google/GitHub email — not necessarily your Cloudflare login). Only this identity (case-insensitive) may use `/account`. See [Change your sign-in email](#change-your-sign-in-email). | none | `alice@example.com` |
| `ACCOUNT_USERNAME` | no | The one Account this Instance serves (`[a-z0-9_.-]+`). It names the storage root `/storage/<ACCOUNT_USERNAME>/` and the storage address `<ACCOUNT_USERNAME>@<host>`, and is never derived from an email address. Set it only to keep an existing username (see [The Account row](#instance-configuration)). | `me` | `alice` |
| `S3_ENDPOINT` | with S3 | Origin of an S3-compatible API, e.g. `https://s3.us-west-004.backblazeb2.com`. Setting any `S3_*` value stores files in that bucket instead of R2; then `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are required too. See [Use an S3 bucket instead of R2](#use-an-s3-bucket-instead-of-r2). | unset (R2) | unset (local directory) |
| `S3_BUCKET` | with S3 | The bucket name. | none | none |
| `S3_ACCESS_KEY_ID` | with S3 | The access key ID (B2: the application key's *keyID*). | none | none |
| `S3_SECRET_ACCESS_KEY` | with S3 | The secret key. Set it as a **Secret**, never as a plain-text var: `bun run setup` does this, or use **Variables and Secrets → Add → Secret**, or `wrangler secret put S3_SECRET_ACCESS_KEY`. | none | none |
| `S3_REGION` | no | The signing region. Only needed when it is not part of the endpoint host (AWS, B2 and R2 hosts are recognised). | from the endpoint, else `us-east-1` | same |
| `PUBLIC_BASE_URL` | no | A canonical origin, e.g. a custom domain `https://rs.example.com` (no path). Every advertised URL — WebFinger, host-meta, the `/oauth/:user` discovery JSON, the consent URL and the storage root — is built from it. Unset, they are built from the origin the request arrived at, which on Cloudflare is always one of your Worker's own hostnames (Cloudflare's edge refuses any other `Host` with a `403` before the Worker runs). `X-Forwarded-Host` / `X-Forwarded-Proto` are never consulted. | the request's origin | `http://localhost:8787` (offline: `http://localhost:$PORT`) |
| `MAX_OBJECT_SIZE_BYTES` | no | The largest file an app or the file manager may store, in bytes; a larger upload gets `413`. Unlike the settings above, a value that is not a positive integer is ignored and the default applies. | `10485760` (10 MiB) | same (offline too) |

The dev-mode defaults apply only when `RSILO_DEV_MODE=true`; an invalid value is rejected even in dev mode. Dev mode keeps `alice` so local tooling and the spec-check run unchanged.

`bun run deploy` (and `bun run setup`) never blank a value you set in the dashboard: they leave empty `[vars]` entries out of the deploy and pass `--keep-vars`, so dashboard values the config does not mention survive. A non-empty value in your config wins over the dashboard, so on an Instance set up with `bun run setup`, change a setting by re-running setup (or editing `wrangler.prod.toml`), not in the dashboard. A bare `wrangler deploy` of the committed `wrangler.toml` would overwrite them with the empty placeholders, so deploy with `bun run deploy`.

**The Account row.** The first request that needs it creates the `users` row for `ACCOUNT_USERNAME` (an idempotent insert; the check is cached per Worker isolate). If that row is missing **and** the table already holds other users — you changed `ACCOUNT_USERNAME`, or migrated a multi-user deployment — RSilo will not create a second row: storage returns `503` and `/account` and the consent page show a *username mismatch* message. Set `ACCOUNT_USERNAME` to the existing account you want to keep: the `/account` page (shown only to you, the Owner) names the stored username and gives the exact click path; the public storage `503` never names it. Other rows are ignored, not deleted. Because the default is `me`, an Instance created before `ACCOUNT_USERNAME` became optional keeps its username only while the setting stays in place; if it was removed, the mismatch page tells you what to set it back to.

### Deploying updates to your own instance

The committed `wrangler.toml` holds placeholder IDs so the Deploy to Cloudflare button works for everyone. Your real, account-specific IDs live in the gitignored `wrangler.prod.toml`, written by `bun run setup`.

`bun run deploy` uses `wrangler.prod.toml` automatically when it exists, so shipping an update is just:

```bash
bun run deploy
```

If `wrangler.prod.toml` is missing, it looks your D1 database up by name and writes one for it (see [Automatic deploys](#automatic-deploys-cloudflare-workers-builds)); if that finds nothing, it deploys the committed `wrangler.toml`, the path Cloudflare's button uses, where the IDs are injected for you. To rebuild the prod config after provisioning new resources, re-run `bun run setup` (or copy `wrangler.toml` and paste in the IDs by hand).

Each deploy first bundles the Worker without uploading it (`wrangler deploy --dry-run`), so a build error stops it before the database changes. It then applies pending D1 migrations, and stops without deploying if they were not applied (for example when you answer "no" at wrangler's prompt). It refuses a config that sets `RSILO_DEV_MODE=true`, and one that lacks any of the `[[ratelimits]]` bindings in `wrangler.toml` (production answers `503` without them): a `wrangler.prod.toml` written before a release added a limiter is fixed by re-running `bun run setup`.

### Rolling back a bad release

Before it applies migrations, `bun run deploy` prints the commands that undo the release, with the D1 Time Travel bookmark of that moment. Workers Builds prints them in the build log; run them from a checkout after `wrangler login`.

- **A release without migrations:** `wrangler rollback` puts the previous Worker version back.
- **A release with migrations:** restore the database first, then roll back. The previous code may not run on the new schema.

  ```bash
  wrangler d1 time-travel restore DB --bookmark=<printed bookmark> --config wrangler.prod.toml
  wrangler rollback --config wrangler.prod.toml
  ```

  In a checkout without `wrangler.prod.toml` (a Deploy-button Instance), drop `--config`, name the database (`remotestorage-db`) instead of `DB`, and give `wrangler rollback` your Worker's name with `--name`. Without the bookmark, `--timestamp=<a time just before the deploy>` (RFC 3339 or Unix seconds) works too. Time Travel reaches back 7 days on the Workers Free plan and 30 on Paid. Restoring D1 undoes token changes made since then (apps that connected afterwards connect again) and never touches your files.

### Updating a Deploy-button Instance

The button copied this repository into your GitHub account and connected the copy to Workers Builds, so a push to its `main` deploys. RSilo fixes made here do not reach your copy by themselves. To pull them in, use **Sync fork** on GitHub if your copy has it, or from a clone of your copy:

```bash
git remote add upstream https://github.com/jonocodes/RSilo.git   # once
git pull upstream main
git push
```

The push deploys. Check once, under your Worker's **Settings → Builds**, that the deploy command is `bun run deploy` (it applies migrations and keeps your dashboard settings; a bare `wrangler deploy` does neither), and set the build command recommended below.

### Automatic deploys (Cloudflare Workers Builds)

To release on every push to `main`, connect the repository to your Worker using Cloudflare's native Git integration — Cloudflare then owns the deploy token, so nothing needs to live in GitHub.

1. Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings → Builds** → connect the Git repository.
2. Set the **production branch** to `main`, and leave preview builds off (or on) as you prefer.
3. Set the **build command** to:

   ```bash
   bun run typecheck && bun run test
   ```

   Workers Builds does not wait for the GitHub checks, so without this a push to `main` with failing tests still deploys. The tests need Node 22.13 or newer; if the build image has an older one, add the build variable `NODE_VERSION=22`.
4. Set the **deploy command** to:

   ```bash
   bun run deploy
   ```

5. No build variables are needed. On the build, `bun run deploy` finds your D1 database by name (`remotestorage-db`), materialises `wrangler.prod.toml` for it, checks the bundle, applies D1 migrations, and deploys, so a recreated database is picked up automatically. If you gave `bun run setup` other names with `RSILO_BUCKET` / `RSILO_DB`, add the same two as **Build variables**. A `D1_DATABASE_ID` build variable from older instructions is ignored; you can delete it.
6. Keep `OWNER_EMAIL` (and `ACCOUNT_USERNAME` / `PUBLIC_BASE_URL`, if you set them) in the Worker's **Variables and Secrets** (type *Text*); builds keep them. If your files are in an [S3 bucket](#use-an-s3-bucket-instead-of-r2), keep the `S3_*` settings there too (`S3_SECRET_ACCESS_KEY` as a *Secret*) and add the build variable `RSILO_STORAGE=s3`.

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

Your dashboard shows **Signed in as \<email\>** and a **Change your sign-in email** section with these steps. The email lives in two places, and both must change:

1. **The Worker's `OWNER_EMAIL`.** If you set up with `bun run setup`, re-run `bun run setup --owner-email=new@example.com`. Don't edit it in the dashboard: `wrangler.prod.toml` holds the old email, and your next `bun run deploy` would put it back. Otherwise (Deploy button, or settings kept in the dashboard): **Workers & Pages → \<worker name\> → Settings → Variables and Secrets → OWNER_EMAIL → Edit → Deploy**.
2. **The Access application's Allow policy:** **Zero Trust → Access → Applications → RSilo app → Policies**, and include the new email. Otherwise Access will not let the new email through at all.

If you update only the policy, you will see the *Not allowed* page, which shows the email you signed in with. If you unset `OWNER_EMAIL`, `/account` shows the *finish setup* page again (apps keep syncing) and, once you sign in through Access, offers your signed-in email to copy.

## Change your storage quota

Your `/account` dashboard shows how much you have stored against your quota (10 GiB by default). To change it, enter a new value in GB under the usage bar and press **Save**. The quota is a limit you set for yourself, for example to stay inside R2's free tier. Setting it below what is already stored keeps your files but blocks new writes (apps get `507 Insufficient Storage`) until you free up space or raise it.

## Backups

Your Instance holds the only copy of what your apps store, and a delete is permanent, whether you made it in the file manager or an app synced a mistake. Keep a copy somewhere else.

**Files in R2.** Create an R2 API token (**R2 → Manage API tokens → Create API token**, permission *Object Read only*, for your bucket) and add it as an [rclone](https://rclone.org/) remote:

```ini
# ~/.config/rclone/rclone.conf
[r2]
type = s3
provider = Cloudflare
access_key_id = <Access Key ID>
secret_access_key = <Secret Access Key>
endpoint = https://<account id>.r2.cloudflarestorage.com
```

Then copy the bucket on a schedule (cron, launchd or Task Scheduler):

```bash
rclone sync r2:remotestorage ./rsilo-backup --backup-dir "./rsilo-deleted/$(date +%F)"
```

`sync` makes `./rsilo-backup` match the bucket; `--backup-dir` moves files that were deleted or changed since the last run into a dated folder instead of losing them. To restore, copy files back with `rclone copy` (the usage figure on `/account` is not recomputed, and apps may take up to an hour to notice the restored files; see [Known limitations](../README.md#known-limitations)).

**Files in an S3 bucket.** The same works with an rclone remote for your provider. Backblaze B2 also keeps every version of a file by default (the bucket's lifecycle setting *Keep all versions*), so a deleted or overwritten file can be brought back from the B2 web UI. Old versions count toward the 10 GB free tier.

**The database.** D1 holds your app tokens, your quota, the usage counter and a cache of folder ETags, never files. Cloudflare's D1 Time Travel keeps restorable history automatically: 7 days on the Workers Free plan, 30 on Paid (see [Rolling back a bad release](#rolling-back-a-bad-release)). Were it lost, apps would connect again and your files would be untouched.

**The offline server.** Copy `data/storage/`, and back up the database with SQLite's `.backup` rather than `cp`, which can catch it mid-write:

```bash
sqlite3 data/remotestorage.db ".backup 'rsilo-backup.db'"
```

## Upgrading an existing deployment

Older RSilo versions had their own usernames and passwords, an admin console and admin secret, and could hold several users. To move such a deployment to Cloudflare Access:

1. Set the settings in the Worker's **Variables and Secrets** (or under `[vars]` in `wrangler.prod.toml`, or by re-running `bun run setup --owner-email=… --account-username=…`). `OWNER_EMAIL` is your email; `ACCOUNT_USERNAME` must be the **existing** username whose data you want to keep (unless it is already `me`). `PUBLIC_BASE_URL` is optional; an existing value keeps working.
2. [Set up Cloudflare Access](#set-up-cloudflare-access).
3. Deploy with `bun run deploy`. It applies migration `0003`, which drops the stored passwords.

Apps that cached the old consent address are redirected to the new one. Any other users on the deployment become unreachable — their data and tokens are left in place, not deleted. For a second person, deploy a second Instance. Old admin secrets and password settings are no longer read; you can delete them from the Worker's settings.

### Connected apps reconnect once (migration `0005`)

Migration `0005` makes RSilo store tokens only as hashes. D1 can't hash the existing tokens in place, so the migration deletes them, and every connected app is signed out once. Each app shows it is disconnected (or gets a `401`) and asks you to connect again. Approve it as usual and it carries on syncing, with your data untouched. Your `/account` dashboard lists no apps until each one reconnects.

## Connect a RemoteStorage app

Apps do **not** need any setup on your side — there is no client registration step. The first time an app asks for access it is registered automatically and appears on your `/account` dashboard.

1. In the app, enter your storage address, shown on your dashboard: `me@<your-worker>.<subdomain>.workers.dev` (or `<ACCOUNT_USERNAME>@…` if you set one) or, if the app supports it, just the server URL `https://<your-worker>.<subdomain>.workers.dev`.
2. The app discovers your endpoints via WebFinger and sends you to the consent page, `/account/oauth/authorize`. It is part of `/account`, so Cloudflare Access signs you in first if you are not already.
3. The page shows the app (by its origin host), the modules it asks for and whether it wants read-only or read-write access, and **where it will send you back to**. Allow or deny.
4. The app gets a token and starts syncing into that module.

Apps built on remoteStorage.js get a token that lasts 30 days from its last use, so an app you keep using never sends you back here (see [Token lifetimes](api.md#token-lifetimes)).

Your `/account` dashboard lists each app that still holds an unexpired token once, by its origin host, with the modules it can access and when it was first granted and last issued a token. **Revoke** removes all of that app's tokens at once; it loses access immediately.

Because apps are not registered in advance, an app is identified by its `client_id`, which must be an `https` URL (plain `http` only on `localhost`, `*.localhost`, `127.0.0.1` or `[::1]`), and it may only be sent back to a `redirect_uri` on that same origin. Any other request gets a `400` error page and no redirect. If your Access session expires while the consent page is open, the approval is lost to the Access sign-in; reload the page (all its parameters are in the URL) and allow again.

## Share a file publicly

Files written under `public/<module>/` are readable by anyone — no token needed (reads without your token are limited to 300 a minute per IP). Folder listings still need a token with read access to the module (`*:r` for `public/` itself), as for private folders. An app writes there with the same `<module>` scope as its private data; for a by-hand example, see [Public files](api.md#public-files).

## One Account per Instance

An Instance serves only `ACCOUNT_USERNAME`: WebFinger resolves no other user, the `/oauth/<username>/…` endpoints return `404` for any other username (consent is always for the Account), and every `/storage/<username>/…` request for another username is refused (`401` without a token, `403` with one, including anonymous `public/` reads). If you migrate a deployment that had several users, every other user's data and tokens become unreachable; their rows, R2 objects and tokens are left in place, not deleted. For a second account, deploy a second Instance.

## Security logs

RSilo writes one JSON line to the Worker's log for each security event. Successful storage requests are not logged. Every line has `event`, `ip` (from `CF-Connecting-IP`), `method` and `path`, plus:

| `event` | When | Extra fields |
| --- | --- | --- |
| `storage.auth_denied` | Storage refused a request: `401` (`missing_token`, `invalid_token`) or `403` (`insufficient_scope`, `wrong_account`; `unknown_account` for a username other than the Account) | `status`, `reason`, `required_scope` |
| `rate_limit.exceeded` | A `429` | `limiter` |
| `oauth.consent_approved`, `oauth.consent_denied` | You allowed or denied an app (an implicit-flow token is issued on approval) | `client_id`, `scope`, `response_type` |
| `oauth.token_issued` | An app exchanged a code for tokens | `grant_type`, `client_id`, `scope` |
| `oauth.token_refreshed` | An app rotated its refresh token | `client_id`, `scope` |
| `oauth.invalid_grant` | The token endpoint refused a code or refresh token | `grant_type`, `reason` (`invalid_code`, `redirect_uri_mismatch`, `pkce_mismatch`, `invalid_refresh_token`), `client_id` when known |
| `account.app_revoked` | You revoked an app on `/account` | `client_id` |
| `account.owner_rejected` | A signed-in identity other than `OWNER_EMAIL` reached `/account` | `email` |

Tokens, codes, `code_verifier`s, `Authorization` headers and document contents are never logged. Paths are, so the names of files in refused requests appear in the log.

To read them, open your Worker in the Cloudflare dashboard → **Observability** → **Logs** (`wrangler.toml` enables Workers Logs) and filter on `event`, or stream them live from a checkout with `wrangler tail <worker name> --format json`. Workers Logs keeps a few days of history; see Cloudflare's Workers Logs limits for your plan.

## Running on the Cloudflare free tier

RSilo is built for a *small personal backup*, not a business service — and it fits comfortably inside Cloudflare's free tier.

**The one thing to watch: R2 is the only part that can ever cost money.** (If you [use an S3 bucket instead](#use-an-s3-bucket-instead-of-r2), R2 is not used at all and that provider's free tier applies instead.) Workers and D1 simply stop working once their free limits are reached. R2 instead bills overage once you pass its free allowance — and because Cloudflare requires a payment method to enable R2, that overage is charged automatically.

As of **October 2026**, R2's free tier covers roughly **10 GB of storage**, **1 million writes/listings**, and **10 million reads** per month, with free egress. Cloudflare changes these numbers and prices over time, so treat them as a rough guide and check the current values on the [R2 pricing page](https://developers.cloudflare.com/r2/pricing/). For a personal notes/todos/photos backup this allowance is far more than you will use.

Roughly, uploads and folder listings count as "writes" (Class A), downloads and metadata as "reads" (Class B), and deletes are free. Only a folder that changed is listed: an app re-checking an unchanged folder is answered from D1, with no R2 operation.

### Staying free

1. **Stay on the Workers Free plan.** Free Workers hard-stop at their daily request limit; the Paid plan auto-bills overages with no hard switch.
2. **Keep the bucket private.** Do not enable the r2.dev public URL or attach a custom domain to the bucket. RSilo serves everything through the Worker (including the `public` module), and R2 does not bill unauthorized requests. A public bucket would also let callers bypass the Worker entirely.
3. **Use Standard storage only.** Infrequent Access has no free tier and bills from the first operation — even from viewing the bucket in the dashboard.
4. **Set a budget alert as an early warning.** In the Cloudflare dashboard go to **Manage Account → Billing → Billable Usage → Create budget alert** (or **Notifications → Add → Budget Alert**) and set a low threshold. You'll get an email if spend starts to rise. It is only a warning — Cloudflare has no built-in hard spending cap for R2, and per-product billing notifications require a Professional plan or higher.
5. **For a hard guarantee, cap usage in the Worker.** Since every write goes through `PUT /storage/...`, a global storage ceiling plus a monthly Class A operation counter is the only way to make $0 a certainty. Not implemented yet. For visibility, Cloudflare's built-in R2 metrics already break operations down by Class A/B per bucket — see the bucket's **Metrics** tab or query the `r2OperationsAdaptiveGroups` GraphQL dataset — which is enough for the intended single-user setup.

> RemoteStorage clients never talk to R2 directly — they speak HTTP to the Worker, which reaches R2 through the binding. "Private bucket" and working RemoteStorage clients are not in conflict.
