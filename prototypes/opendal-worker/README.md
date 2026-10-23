# Prototype: OpenDAL in a Rust Cloudflare Worker

Throwaway. Question: can a `workers-rs` Worker use OpenDAL's S3 service, and how big is the bundle?

`GET /<key>`, `PUT /<key>`, `DELETE /<key>` and `GET /<prefix>/` (list) map straight to the bucket.

## Run

```sh
flox activate
export PATH=$HOME/.cargo/bin:$PATH       # worker-build (cargo install worker-build)
weed server -dir=/tmp/proto-seaweed -s3 -s3.config=../../test/fixtures/seaweedfs-s3.json &
echo "s3.bucket.create -name rsilo-proto" | weed shell
npx wrangler@4 dev --port 8799
curl -X PUT --data hi localhost:8799/docs/a.txt
```

## Findings (2026-10-22, worker 0.8.7, opendal 0.59.5, local workerd only)

- Compiles for `wasm32-unknown-unknown` with `default-features = false, features = ["services-s3", "http-transport-reqwest"]`. reqwest goes through the runtime's `fetch` on wasm.
- You have to call `opendal::install_default()` yourself, because OpenDAL's `#[ctor]` hook doesn't run on wasm. Without it every call fails with "default HTTP transport is not installed".
- `strip = true` in the release profile breaks `wasm-bindgen` ("externref table required for catch wrappers").
- Bundle: `index_bg.wasm` is 2.6 MB raw and 1.2 MB gzipped. The free plan allows 3 MB gzipped, and this is only S3 with no app code.
- Against SeaweedFS: PUT, GET, list, DELETE, 404 on a missing key, and a 5 MB binary round trip all work. ETags come back from `write`.
- Not tested: a deploy to the Cloudflare edge (CPU-time limits, real TLS endpoints such as B2 and R2), streaming bodies (the prototype buffers whole bodies with `req.bytes()`), conditional requests, or other OpenDAL services.
