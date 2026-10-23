# No Rust rewrite to use OpenDAL for storage

We asked whether RSilo should replace its own storage adapters (R2 binding, S3 per ADR-0005, local directory) with Apache OpenDAL, which speaks many backends behind one API. OpenDAL's npm package is a native NAPI addon that can't load in a Worker, so the only route is a Rust Worker (`workers-rs` compiled to wasm), which means rewriting RSilo's ~16k lines of TypeScript. A prototype (`prototypes/opendal-worker/`) showed it builds and runs, but we decided not to do it. It mostly gains backends RSilo can already reach through S3, it costs a full rewrite, and on the edge it uses more CPU time than the Workers Free plan allows, which works against "free, for non-technical people".

Status: accepted

## Considered Options

- **Rust Worker on OpenDAL.** Rejected, on the prototype's results (2026-10-22, opendal 0.59.5, worker 0.8.7):
  - The bundle fits: 1.34 MB gzipped with S3, WebDAV and Azure, against the Free plan's 3 MB, and the edge accepted it.
  - CPU doesn't fit. Small requests took 1–21 ms of CPU on R2 (Free allows 10 ms), and body bytes cross the wasm boundary, so a 12 MB GET took 364 ms. The TS Worker hands R2's stream straight to the response.
  - The backends gained are WebDAV and Azure Blob. GCS can't sign on wasm. Each backend brings its own capability gaps: WebDAV has no conditional requests and no multipart, and R2 ignores `If-Match` on DELETE while OpenDAL reports it as supported. RSilo would still need its own stat-then-act fallback per provider, as it has for B2 today.
- **Add backends to the TS `StorageInterface` one at a time.** Deferred until an Owner asks for one. WebDAV or Azure would be one more adapter beside `S3Storage`, with no rewrite and no wasm cost.

## Consequences

- Storage stays behind `StorageInterface` in TypeScript. S3-compatible providers remain the way to reach storage other than R2.
- Revisit if Owners ask for a backend that has no S3 API, or if Cloudflare raises the Free plan's CPU limit or lets wasm stream bodies without copying them.
