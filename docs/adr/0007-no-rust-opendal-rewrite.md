# No Rust rewrite to use OpenDAL for storage

We asked whether RSilo should replace its own storage adapters (R2 binding, S3 per ADR-0005, local directory) with Apache OpenDAL, which speaks many backends behind one API. OpenDAL's npm package is a native NAPI addon that can't load in a Worker, so the only route is a Rust Worker (`workers-rs` compiled to wasm), which means rewriting RSilo's ~16k lines of TypeScript. A prototype (`prototypes/opendal-worker/`) showed it builds and runs, but we decided not to do it. It mostly gains backends RSilo can already reach through S3, it costs a full rewrite, and on the edge it uses more CPU time than the Workers Free plan allows, which works against "free, for non-technical people".

Status: accepted

## Considered Options

- **Rust Worker on OpenDAL.** Rejected, on the prototype's results (2026-10-22, opendal 0.59.5, worker 0.8.7):
  - The bundle fits: 1.34 MB gzipped with S3, WebDAV and Azure, against the Free plan's 3 MB, and the edge accepted it.
  - CPU doesn't fit. Small requests took 1–21 ms of CPU on R2 (Free allows 10 ms), and a 12 MB GET took 364 ms, roughly 30 ms per MB. CPU time counts only work inside the isolate, not waiting on the network. The TS Worker hands R2's `ReadableStream` straight to the `Response`, and the runtime pipes it natively, so its cost doesn't depend on size. In the Rust Worker every chunk is copied from JS into wasm linear memory and back out, with a future woken per chunk. Wasm causes the copy, because a module can't read JS buffers in place. OpenDAL makes it unavoidable, because its API yields Rust `Bytes` and never exposes the underlying `fetch` stream. Rust itself isn't the cause: a `workers-rs` Worker that calls `fetch` and returns the response untouched copies nothing. The prototype's extra `.to_vec()` adds one avoidable copy, but removing it leaves the cost proportional to size.
  - The backends gained are WebDAV and Azure Blob. GCS can't sign on wasm. Each backend brings its own capability gaps: WebDAV has no conditional requests and no multipart, and R2 ignores `If-Match` on DELETE while OpenDAL reports it as supported. RSilo would still need its own stat-then-act fallback per provider, as it has for B2 today.
- **OpenDAL for control, presigned URLs for bodies.** Rejected. OpenDAL presigns for S3 and Azure (not WebDAV), and the Worker could `fetch` the presigned URL and pass the JS stream through without copying. But that leaves bodies working only on backends RSilo mostly reaches already, which still doesn't justify a rewrite.
- **Workers Paid.** Not pursued. Its 30 s CPU limit would absorb the copying, but $5 a month per Owner goes against the mission.
- **Add backends to the TS `StorageInterface` one at a time.** Deferred until an Owner asks for one. WebDAV or Azure would be one more adapter beside `S3Storage`, with no rewrite and no wasm cost.

## Consequences

- Storage stays behind `StorageInterface` in TypeScript. S3-compatible providers remain the way to reach storage other than R2.
- Revisit if Owners ask for a backend that has no S3 API, or if Cloudflare raises the Free plan's CPU limit or lets wasm stream bodies without copying them.
