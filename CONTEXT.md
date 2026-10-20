# RSilo

RSilo is a remoteStorage-compatible personal storage server that runs on Cloudflare Workers. Each instance holds one person's data.

## Language

**Instance**:
One deployed RSilo — a single Worker with its own D1 and Storage backend — serving exactly one Account.
_Avoid_: server, deployment (ambiguous)

**Storage backend**:
Where an Instance keeps file contents: its R2 bucket by default, or one S3-compatible bucket chosen by the `S3_*` settings (ADR-0005). Exactly one per Instance. The offline server uses a local directory (`LocalStorage`) instead.
_Avoid_: provider, driver

**Account**:
The single storage identity on an Instance, named by its username (default `me`) and addressed as `username@host`. All data is keyed under this identity. In code it is the `users` row, `username`, `user_id` or a token's `sub`.
_Avoid_: user, tenant

**Owner**:
The human who operates an Instance and authenticates as its Account, via Cloudflare Access.
_Avoid_: admin, user

**Storage address**:
The `username@host` (or host-only `http://host/`) that a client resolves via WebFinger to reach an Account.
_Avoid_: server URL

**App authorization**:
One app's grant: all of an OAuth client's bearer tokens for the Account, together granting access to one or more Modules. Listed per client (by its origin host) and revoked as a whole from the control plane. Called a `grant` in `routes/account.ts`.
_Avoid_: token, session (both overloaded here)

**Module**:
A top-level category of scoped data (for example `documents` or `pictures`) that a scope grants access to.
_Avoid_: folder, category

**Scope**:
One `<module>:r` or `<module>:rw` item of an App authorization; module `*` covers all of storage. A Module scope also covers that Module's Public folder.
_Avoid_: permission

**Public folder**:
`public/<module>/` under the Account's storage: its documents are readable without a token; listing it still needs a Scope.
_Avoid_: shared folder

**Quota**:
The storage limit the Owner sets for the Account on `/account`; writes past it get `507`.
_Avoid_: plan, allowance

**Dev mode**:
`RSILO_DEV_MODE=true`, for local servers and tests only: fixed dev defaults, a **dev identity** standing in for the Owner on a local host without Access, and `/debug/*`. Deploys refuse it.
_Avoid_: debug mode (it is more than /debug)
