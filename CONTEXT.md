# RSilo

RSilo is a remoteStorage-compatible personal storage server that runs on Cloudflare Workers. Each instance holds one person's data.

## Language

**Instance**:
One deployed RSilo — a single Worker with its own R2, D1, and KV — serving exactly one Account.
_Avoid_: server, deployment (ambiguous)

**Account**:
The single storage identity on an Instance, named by its username and addressed as `username@host`. All data is keyed under this identity.
_Avoid_: user, tenant

**Owner**:
The human who operates an Instance and authenticates as its Account, via Cloudflare Access.
_Avoid_: admin, user

**Storage address**:
The `username@host` (or host-only `http://host/`) that a client resolves via WebFinger to reach an Account.
_Avoid_: server URL

**App authorization**:
An OAuth client's bearer token granting access to one or more Modules; listed and revocable from the control plane.
_Avoid_: token, session (both overloaded here)

**Module**:
A top-level category of scoped data (for example `documents` or `pictures`) that a scope grants access to.
_Avoid_: folder, category
