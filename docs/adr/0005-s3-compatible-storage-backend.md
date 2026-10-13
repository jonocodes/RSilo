# Files may live in an S3-compatible bucket instead of R2

R2 is the only part of an Instance that can cost money, and enabling it needs a payment method on file, after which overage is billed automatically. That is the main obstacle to "free, for non-technical people". We decided an Instance keeps its file contents either in its R2 binding (the default) or in one S3-compatible bucket, chosen by the `S3_*` settings. The Worker, D1, rate limiting and Cloudflare Access are unchanged. The trade is RSilo's first secret, `S3_SECRET_ACCESS_KEY`, and a second storage path to keep correct.

Status: accepted

## Considered Options

- **Stay R2-only.** Rejected: it keeps the payment-method requirement and its automatic overage billing for every Owner.
- **Move the whole Instance to another host** (Supabase, Vercel, Netlify, Deno Deploy, GCP Cloud Run). Rejected for now. Their free storage is around 1 to 5 GB, some pause idle projects or lock storage for 30 days after an overage, and none offers path-scoped human auth like Cloudflare Access (ADR-0001), so owner sign-in would have to be rebuilt.
- **Keep the key in D1 or derive it at runtime.** Rejected: a Worker secret is encrypted at rest, never shown back in the dashboard, and is the platform's mechanism for exactly this.

## Consequences

- `getStorage()` builds an `S3Storage` when any `S3_*` var is set and otherwise uses the R2 binding (or, offline, `LocalStorage`). `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are required together; `S3_REGION` is optional because the signer reads it from AWS, B2 and R2 hosts and otherwise uses `us-east-1`. A partial or invalid set is an Instance configuration problem: every request gets `503` naming the vars, never their values, as for any other invalid setting.
- Requests are path-style (`<endpoint>/<bucket>/<key>`) and SigV4-signed with `aws4fetch`, which needs only `fetch` and WebCrypto, so the same adapter runs in the Worker, the offline server and the tests. Folder listings use `ListObjectsV2`, following continuation tokens.
- `S3_SECRET_ACCESS_KEY` is a Worker secret, never a `[vars]` entry, a setup flag or a file. `bun run setup` takes it from the environment or a hidden prompt and runs `wrangler secret put`. The committed `wrangler.toml` still declares no secret.
- The Deploy to Cloudflare button stays R2-only, because it provisions whatever bindings `wrangler.toml` declares. S3 storage is set up with `bun run setup --s3-…`, which leaves the R2 binding out of `wrangler.prod.toml`. Workers Builds does the same when the build variable `RSILO_STORAGE=s3` is set.
- Switching an existing Instance between R2 and S3 copies no files, and the quota counter in D1 is not recomputed. Moving data is a manual copy (for example with `rclone`) done before the switch.
- S3 listings carry no `Content-Type`, so folder listings report `application/octet-stream` for documents. This matches the R2 path today, which does not request HTTP metadata when listing.
- Each provider's free tier has its own limits. Backblaze B2's free tier is 10 GB with no card, but only 2,500 Class B and 2,500 Class C transactions a day. A folder `GET` costs one Class C list, and a document `GET`/`HEAD` or the `HEAD` before each `PUT` costs one Class B call. An app that polls folders often can therefore reach the daily allowance; whether B2 then refuses or bills the extra calls depends on the account's Caps & Alerts settings, so the README tells Owners to check them.
