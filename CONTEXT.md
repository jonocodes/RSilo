# RSilo

RSilo is a remoteStorage-compatible personal storage server that runs on Cloudflare Workers. Each instance holds one person's data.

## Language

**Instance**:
One deployed RSilo — a single Worker with its own D1 and Storage backend — serving exactly one Account.
_Avoid_: server, deployment (ambiguous)

**Storage backend**:
Where an Instance keeps file contents: its R2 bucket by default, or one S3-compatible bucket chosen by the `S3_*` settings (ADR-0005). Exactly one per Instance.
_Avoid_: provider, driver

**Account**:
The single storage identity on an Instance, named by its username (default `me`) and addressed as `username@host`. All data is keyed under this identity.
_Avoid_: user, tenant

**Owner**:
The human who operates an Instance and authenticates as its Account, via Cloudflare Access.
_Avoid_: admin, user

**Storage address**:
The `username@host` (or host-only `http://host/`) that a client resolves via WebFinger to reach an Account.
_Avoid_: server URL

**App authorization**:
One app's grant: all of an OAuth client's bearer tokens for the Account, together granting access to one or more Modules. Listed per client (by its origin host) and revoked as a whole from the control plane.
_Avoid_: token, session (both overloaded here)

**Module**:
A top-level category of scoped data (for example `documents` or `pictures`) that a scope grants access to.
_Avoid_: folder, category
