# An RSilo instance is single-user

The intended use is one person backing up their own data, but the implementation carried multi-user machinery (user CRUD, per-user quotas, per-user sessions, an admin/account split). We decided each instance holds exactly one storage identity, configured once; there is no user creation, and wanting additional accounts means deploying additional instances. This keeps the storage model and protocol addresses simple and lets the admin user-management surface disappear.

Status: accepted

## Considered Options

- **Keep multi-user** — rejected: complexity not justified by the intended path; every feature paid for it.
- **A single-user mode flag on top of multi-user** — rejected: two code paths for no protocol difference; single-user is simply N=1 of the same model.

## Consequences

- Multiple accounts are multiple instances. Within one Cloudflare account those instances share account-wide free-tier budgets (R2, Workers requests, D1, KV), so they do not multiply the free allowance; independent quotas require a separate Cloudflare account.
- The `users` table keeps its role as the storage-identity record (referenced by OAuth tables) but holds exactly one row and no password column.
- `bun run setup` currently writes a single `wrangler.prod.toml`; running two instances from one checkout needs a separate directory or a named config.
