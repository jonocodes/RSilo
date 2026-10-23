# Prototype: OpenDAL in a Rust Cloudflare Worker

Throwaway. Question: can a `workers-rs` Worker use OpenDAL as RSilo's storage, which backends work, and how big is the bundle?

`GET /<key>`, `PUT /<key>`, `DELETE /<key>` map to the backend, and `GET /<prefix>/` lists it. Bodies stream both ways, and `If-Match` / `If-None-Match` pass through. The backend is chosen by `STORAGE_SCHEME` plus `STORAGE_<KEY>` vars and secrets (see `src/lib.rs`), and each backend is a cargo feature (`services-s3` is the default; `services-webdav` and `services-azblob` are optional).

## Run

Tools: rustup (stable with the `wasm32-unknown-unknown` target, see `rust-toolchain.toml`), `cargo install worker-build`, Node 22, and SeaweedFS (`weed`).

```sh
weed server -ip=127.0.0.1 -ip.bind=127.0.0.1 -dir=/tmp/proto-seaweed -s3 -webdav \
  -s3.config=../../test/fixtures/seaweedfs-s3.json &
echo "s3.bucket.create -name rsilo-proto" | weed shell
npx wrangler@4 dev --port 8799                # S3; add `--env webdav` for WebDAV
./smoke.sh                                    # 18 checks
```

## Findings (2026-10-22, worker 0.8.7, opendal 0.59.5, local workerd only)

**Build**
- Use `default-features = false` plus `http-transport-reqwest`. On wasm, reqwest goes through the runtime's `fetch`.
- You have to call `opendal::install_default()` yourself, because OpenDAL's `#[ctor]` hook doesn't run on wasm. Without it every call fails with "default HTTP transport is not installed".
- `strip = true` breaks `wasm-bindgen` ("externref table required for catch wrappers").

**Bundle size** (`index_bg.wasm`; the free plan allows 3 MB gzipped for the whole Worker)

| backends            | raw     | gzip    |
| ------------------- | ------- | ------- |
| s3                  | 2.63 MB | 1.21 MB |
| webdav              | 1.35 MB | 0.42 MB |
| azblob              | 1.70 MB | 0.54 MB |
| s3 + webdav + azblob | 3.14 MB | 1.36 MB |

Most of the cost is shared, and S3 is the heavy one (AWS signing, XML, ini config). That leaves about 1.6 MB gzipped for RSilo itself.

**Backends**
- **S3** (SeaweedFS): 18/18 smoke checks. Conditional GET/PUT/DELETE are enforced by the server and give 304 and 412 correctly. A 12 MB PUT streams as multipart in 5 MiB parts.
- **WebDAV** (SeaweedFS): CRUD, listing, encoded keys and a 12 MB round trip work. Conditional requests come back `501`, because OpenDAL reports no condition support for WebDAV. RSilo would need its own stat-then-act fallback there, as it already does for B2 (ADR-0005). WebDAV can't do multipart, so a PUT buffers the whole body, which matters under the Worker's 128 MB memory limit.
- **Azure Blob**: builds; not run.
- **GCS**: doesn't work on wasm. `reqsign-core` compiles out its JWT module on `wasm32`, so `reqsign-google` can't sign service-account tokens.
- Each backend has its own capabilities. Code has to check `op.info().capability()` (for example `write_can_multi`) instead of assuming S3 behaviour.

**Streaming**
- An error after the response headers are sent can only truncate the body, so the client sees an empty `200`. The Worker pulls the first chunk before responding so that early errors still get a proper status.
- SeaweedFS WebDAV gives a chunked file one ETag in PROPFIND (stat) and another on GET, so pinning a read with `If-Match: <stat etag>` 412s every large file. Expect quirks like this per backend.

**Not tested:** deploying to the Cloudflare edge (CPU-time limits, real TLS endpoints such as B2, R2 and Azure), Azure against a live server, and the cost of the extra `stat` on each GET.
