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
| Dropbox, as is | 56 passing, 14 failing (`MOCHA_TIMEOUT=30000`); 47 timeouts at the default 2 s | fails: 5 s test timeout |
| Dropbox, `HEAD` after `PUT` | 70 passing, 0 failing (`MOCHA_TIMEOUT=30000`) | fails: 5 s test timeout |

- `ListObjectsV2` returns ETags without quotes, while `PUT` and `HEAD` quote them (AWS quotes both). RSilo strips quotes wherever it compares or emits ETags (`stripQuotes`), so remoteStorage clients see no difference; only the live test's exact match fails.
- **rclone bug: the `PUT` ETag is always the body's MD5**, whatever `--etag-hash` says, while `HEAD`, `GET` and listings use the configured hash (`DropboxHash` on Dropbox, under both `auto` and `DropboxHash`). On a local directory the two agree because both are MD5. On Dropbox every ETag a client gets from a `PUT` is one the server never returns again, so all 14 failures were `If-Match` / `If-None-Match` and changed-ETag checks. Having `S3Storage.put` `HEAD` the object afterwards (one extra request; tried as an uncommitted patch) fixed all 14. The proper fix is in rclone.
- **Slow.** With the 2 s timeout CI uses, 47 tests timed out. The median spec-check test took 3.5 s and the slowest 7.6 s, because each remoteStorage request becomes several Dropbox API calls.
- **Rate limited.** Dropbox answered `too_many_requests` 18 times in one run, and rclone waited 10 s each time. The error text is "Too many requests or write operations", so a sync client that writes in bursts will stall.
- Correctness through rclone holds once the ETag bug is worked around. Speed and rate limits are the real costs, and rclone still needs an always-on process (see `docs/research/consumer-drives-on-workers-free.md`).
