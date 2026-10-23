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

On NixOS, a gitignored flox env in this directory provides the tools: `flox install rustup seaweedfs nodejs_22 gcc pkg-config openssl`, with `openssl.outputs = ["out", "dev"]` so `cargo install worker-build` finds its headers, and `~/.cargo/bin` added to PATH in the `on-activate` hook.

### Edge (R2)

`./r2.sh setup` creates the `opendal-proto` R2 bucket, deploys `opendal-worker-proto-r2` (`wrangler deploy --env r2`) and sets the endpoint and S3 credentials as Worker secrets. They're derived from the Cloudflare API token in `~/.config/secrets`. Then run `./smoke.sh https://opendal-worker-proto-r2.<subdomain>.workers.dev`. `./r2.sh teardown` deletes the Worker and the bucket.

## Findings (2026-10-22, worker 0.8.7, opendal 0.59.5)

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

**Edge** (2026-10-22, R2 through its S3 API, `opendal-worker-proto-r2` on Workers Free)
- The edge accepted the 3.1 MB / 1.34 MB gzipped upload (S3 + WebDAV + Azure features). Cloudflare reports a 5 ms startup time.
- 17/18 smoke checks. R2 ignores `If-Match` on DeleteObject: a stale ETag still deletes (`204`), even when sent to R2 directly without the Worker. OpenDAL can't tell, since it reports `delete_with_if_match` for every S3 endpoint, so RSilo would have to know which provider is behind the endpoint and stat before deleting, as `S3Storage` already does (ADR-0005).
- CPU time per request, from `wrangler tail` (the Free plan limit is 10 ms):

  | request | CPU | wall |
  | ------- | --- | ---- |
  | small GET/PUT, conditional or not | 1–18 ms | 150–650 ms |
  | folder listing | 21 ms | 295 ms |
  | 12 MB PUT (multipart) | 151 ms | 1.6 s |
  | 12 MB GET | 364 ms | 1.4 s |

  Six of the 21 requests went over 10 ms; none were refused. Across the same run Workers analytics gives p50 13.5 ms, p90 54 ms. For a rough comparison, the TS `rsilo` Worker's previous week (16 requests, a different mix) gives p50 8.5 ms, p90 19 ms, p99 22 ms. Every body byte crosses the wasm boundary, so CPU grows with size (roughly 12–30 ms per MB), where the TS Worker passes R2's stream straight through. Extrapolating from that one size, anything much over a few hundred KB goes past the Free limit.

**Not tested:** B2 and Azure against live servers, cold starts (none were visible in the run), and the cost of the extra `stat` on each GET.
