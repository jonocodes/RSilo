# Prototype: the tree in D1, backends as blob stores

PROTOTYPE — throwaway. Question: can RSilo keep its whole remoteStorage tree (paths, document ETags, Content-Type, and through them folder listings and folder ETags) in D1, and use each backend only as an opaque blob store with `put`, `get` and `deleteMany` by ID? If so, a new backend is about three HTTP calls, and spec-check still passes.

- `indexed-storage.ts`: `IndexedStorage` implements RSilo's `StorageInterface` over a D1 table plus a `BlobStore`, so routes, quota accounting and folder ETags are unchanged. A write uploads the blob under a fresh UUID, then switches the index row to it in one conditional statement. That makes `If-Match` and `If-None-Match` atomic on every backend. Replaced blobs are queued in D1 and deleted later by `collect()`.
- `blob-stores.ts`: `DirBlobStore` and `DropboxBlobStore`. Dropbox uses `files/upload`, `files/download` (the response body is passed through untouched) and `files/delete_batch`.
- `server.ts`: the offline server with `STORAGE` replaced, logging the Dropbox calls behind each request. It runs collection every 15 s; on a Worker that would be a Cron Trigger or `waitUntil`.

## Run

```sh
flox activate -d ~/src/RSilo -- ./run.sh            # blobs in a local directory
flox activate -d ~/src/RSilo -- ./run.sh dropbox    # blobs in Dropbox /rsilo-blobs
```

Dropbox mode borrows the access token of the rclone remote `rsilo-dropbox`. The script runs the pinned spec-check, reports latency and Dropbox calls per request, then runs a final collection and checks that the number of stored blobs equals the number of indexed documents. `MOCHA_TIMEOUT` loosens spec-check's per-test timeout.

## Findings (2026-10-22, offline server on Node/SQLite, real Dropbox)

| | rclone `serve s3` (`prototypes/rclone-s3`) | D1 index, deletes inline | D1 index, deletes queued |
| --- | --- | --- | --- |
| spec-check, 30 s timeout | 56/70 (70/70 with a HEAD-after-PUT workaround) | 70/70 | 70/70 |
| spec-check, 2 s timeout (as CI) | 47 timeouts | — | 60/70; 10 timeouts, all slow uploads |
| request latency median / p90 / max | spec-check test median 3.5 s | 608 ms / 12.8 s / 32 s | 38 ms / 1.3 s / 2.5 s |
| Dropbox 429s | 18 | 52 (all `delete_v2`) | 0 |
| Dropbox calls: folder GET/HEAD, doc HEAD, DELETE | not counted | 0, 0, ≥1 | 0, 0, 0 |
| Dropbox calls: PUT, doc GET | not counted | 1–2, 1 | 1, 1 |

- **It works.** Spec-check passes unchanged on both blob stores. After the final collection, stored blobs exactly match indexed documents (0 and 0, since spec-check cleans up after itself).
- **Folders cost nothing at the backend.** Listings and folder ETags come from one D1 query. Dropbox is touched only to move a document's bytes.
- **Deleting inline is the mistake.** Concurrent `delete_v2` calls hit Dropbox's write rate limit, which waits 10 s each time. Queuing replaced blobs and deleting them in batches with `delete_batch` removed every 429 and cut p90 tenfold.
- **Uploads are the remaining latency:** 1.2–5 s per Dropbox upload. The ten 2 s timeouts were all PUTs.
- **Conditions are now atomic on every backend,** which neither S3 nor R2 DELETE could offer (ADR-0005). A write that loses a race leaves an orphan blob, which is queued for deletion; the quota layer then retries the write, which shows up as two uploads for one PUT.
- **The adapter is small:** the Dropbox `BlobStore` is about 70 lines, and the directory one about 20. `IndexedStorage`, written once for all backends, is about 135.

## Not tested, and what a real version needs

- **The Workers runtime and real D1.** Every index operation is a D1 round trip from the Worker. That's 1–3 queries per request, in addition to RSilo's existing ones. They count against D1's own subrequest budget (1,000 on Free), not the 50 for external calls.
- **Listing reads the whole table.** `list()` uses `substr(key, 1, n) = prefix`, which can't use the index. D1 bills rows read, so a real version needs a range query on the primary key (`key >= prefix AND key < prefix + U+FFFF`, or a separate parent-path column).
- **D1 is the only copy of the tree.** The blobs are UUIDs, so losing D1 loses the names. Mitigations: D1 Time Travel, which I haven't checked on the Free plan; writing the key into blob metadata; or a periodic manifest blob.
- **The files aren't browsable in Dropbox.** That's inherent to the design.
- **OAuth.** This borrowed rclone's Dropbox token. A real version needs RSilo's own Dropbox app and token refresh, with the app-ownership problems listed in `docs/research/consumer-drives-on-workers-free.md`.
- **Migrating existing Instances.** R2 and S3 data would have to be imported into the index, or those backends kept as they are.
