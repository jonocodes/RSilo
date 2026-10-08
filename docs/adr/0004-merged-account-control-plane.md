# The human control plane is one merged `/account` surface

`/admin` (users, quotas, app authorizations) and `/account` (files, tokens) were separate because they had separate credentials. With a single-user instance behind Cloudflare Access there is no credential boundary left, so the two collapse into a single control plane under `/account`: the app-authorization view folds into the dashboard, user management and quotas disappear, and `/admin` remains only as a redirect. One Cloudflare Access application (one AUD) then guards one path prefix.

Status: accepted

## Consequences

- Debug/observability endpoints moved from `/admin/debug` to `/debug` and are dev-only: they answer only under the dev identity guard (dev mode, local host, no Access) and are a 404 in production. Exposing them in production (for example via an Access service token) waits for a concrete need.
- User management is gone. The self-imposed storage quota survives as a dashboard setting.
- The OAuth consent dialog moves under the guarded prefix (advertised via WebFinger) so `/oauth/*/token` stays reachable by apps that cannot perform an Access login.
- The remoteStorage spec's recommendation that the consent/revocation UI live on a different origin than storage (§14) remains unmet; accepted debt for a personal instance.
