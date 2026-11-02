# Archive

Git tags preserving earlier states or approaches, so we can return to them or understand why we moved on. One pointer per tag.

| Tag | Points at | Description |
| --- | --- | --- |
| `archive/multiuser` | `main` @ `8bd9779` (pre-pivot) | RSilo with in-app username/password auth, multi-user support, a separate admin console (`ADMIN_SECRET`), and signed-JWT access tokens. Superseded by the Cloudflare Access + single-user redesign — see `docs/adr/0001`–`0004`. |
| `archive/storage-backends-research` | `find-handoff-doc` @ `beb3abf` | Research on reaching many storage backends: the OpenDAL Rust Worker (ADR-0007), consumer drives on Workers Free (`docs/research/consumer-drives-on-workers-free.md`), a `rclone serve s3` spike, and a prototype keeping the tree in D1 with backends as blob stores (`prototypes/` at the tag). ADR-0007 and the research doc are on `main`. Not pursued; findings in #44. |

## Removed documents

- `PLAN.md`, the original build plan and log, was removed on 2026-10-17. It described the design ADR-0001–0004 replaced (signed JWTs, an admin console, multiple users) and had gone stale. The pre-pivot copy is `git show archive/multiuser:PLAN.md`; the last one is `git show "$(git log -1 --format=%H --diff-filter=D -- PLAN.md)^:PLAN.md"`.
