# Spike: RSilo storage through `rclone serve s3`

Throwaway. Question: if RSilo's existing S3 backend (ADR-0005) points at `rclone serve s3`, does every rclone remote (Google Drive, Dropbox, OneDrive, WebDAV, SFTP…) become correct remoteStorage storage, with no new RSilo code? This tests semantics only. `rclone serve` is a long-running process, so it is not free/no-ops hosting; that question is in `docs/research/consumer-drives-on-workers-free.md`.

## Run

```sh
flox activate -d ~/src/RSilo -- ./spike.sh                       # local directory
flox activate -d ~/src/RSilo -- ./spike.sh mydrive:rsilo-spike   # any rclone remote:path
```

The script starts `rclone serve s3 --etag-hash auto` on the remote, runs `test/s3-live.test.ts` against it, then starts the offline server with `S3_*` pointing at it and runs the pinned remoteStorage spec-check, as CI does. `RCLONE_FLAGS` passes extra flags to `rclone serve s3`. Logs are in `/tmp/rclone-spike/`.

## Findings (2026-10-22, rclone 1.75.2)

| remote | spec-check | live S3Storage test |
| ------ | ---------- | ------------------- |
| local directory | 70 passing, 0 failing (6 pending are `describe.skip` upstream, as in CI) | 1 failure: listing ETags unquoted |

- `ListObjectsV2` returns ETags without quotes, while `PUT` and `HEAD` quote them (AWS quotes both). RSilo strips quotes wherever it compares or emits ETags (`stripQuotes`), so remoteStorage clients see no difference; only the live test's exact match fails.
- Not yet run against a consumer drive: no Drive, Dropbox or OneDrive remote is configured on this machine.
