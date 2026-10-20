# Archive

Git tags preserving earlier states or approaches, so we can return to them or understand why we moved on. One pointer per tag.

| Tag | Points at | Description |
| --- | --- | --- |
| `archive/multiuser` | `main` @ `8bd9779` (pre-pivot) | RSilo with in-app username/password auth, multi-user support, a separate admin console (`ADMIN_SECRET`), and signed-JWT access tokens. Superseded by the Cloudflare Access + single-user redesign — see `docs/adr/0001`–`0004`. |

## Removed documents

- `PLAN.md`, the original build plan and log, was removed on 2026-10-17. It described the design ADR-0001–0004 replaced (signed JWTs, an admin console, multiple users) and had gone stale. The pre-pivot copy is `git show archive/multiuser:PLAN.md`; the last one is `git show "$(git log -1 --format=%H --diff-filter=D -- PLAN.md)^:PLAN.md"`.
