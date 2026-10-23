# Handoff: OpenDAL Rust Worker prototype

Branch `proto/opendal-worker` (pushed). Findings and run steps are in `README.md`, which you should read first.

## Why this exists

We asked whether RSilo should replace its S3-only storage with Apache OpenDAL. OpenDAL's npm package is a native NAPI addon that can't load in a Worker, so the only route is a Rust Worker (`workers-rs`, compiled to wasm). This prototype checks whether that works before anyone considers rewriting RSilo (about 16k lines of TS) in Rust. Nothing has been decided, and there's no ADR yet.

## State

- `src/lib.rs`: a minimal Worker. The backend comes from `STORAGE_SCHEME` plus `STORAGE_*` vars, GET and PUT bodies stream, and conditional requests pass through.
- `smoke.sh`: 18 checks. All pass on SeaweedFS S3. On SeaweedFS WebDAV, the 9 basic checks pass and the 9 conditional ones return 501 (expected).
- Bundle: 1.21 MB gzipped with S3 only, 1.36 MB with S3 + WebDAV + Azure. The free plan allows 3 MB.
- GCS can't work on wasm (`reqsign-core` compiles out `jwt` on wasm32).
- Everything is committed. Nothing has been deployed to Cloudflare.

## Setting up a new machine

1. Rust via rustup with the `wasm32-unknown-unknown` target. `rust-toolchain.toml` pins it, and rustup installs it on first `cargo` use. On the previous machine Homebrew's rust had no wasm target, so rustup came from a flox env (`flox install rustup seaweedfs nodejs_22`). `.flox` is gitignored by the repo, so recreate it if you want it.
2. `cargo install worker-build` (0.8.7 was used). It downloads a matching `wasm-bindgen` itself.
3. Node 22 for `npx wrangler@4`.
4. SeaweedFS (`weed`) for local S3 and WebDAV. Start it with `-ip=127.0.0.1 -ip.bind=127.0.0.1`, otherwise WebDAV binds only to the LAN IP.
5. Follow the Run section in `README.md`, then `./smoke.sh`. Expect 0 failures on S3.

## Next steps

1. **Edge deploy, the main open question.** The user has created a Cloudflare API key in "my secrets dir" (path not yet confirmed; ask). The Worker needs a bucket the internet can reach. Options:
   - **R2 through its S3 API.** Access key ID = the API token's ID; secret = SHA-256 of the token value. Requires the token to have R2 read/write.
   - **Backblaze B2**, which is closer to the free-tier use case. B2 doesn't support conditional PUT (ADR-0005), so expect 501 or 412 differences on those checks.

   Deploy with `npx wrangler@4 deploy`, setting `STORAGE_SECRET_ACCESS_KEY` with `wrangler secret put`, never in `[vars]`. Replace the SeaweedFS `[vars]` in `wrangler.toml`. Run `./smoke.sh https://<worker>.workers.dev`. Record CPU time per request (`wrangler tail`, or the dashboard), cold start, and whether the edge accepts the bundle. Confirm with the user before deploying, because it publishes to their account.
2. Try Azure Blob against a live server (Azurite) if a multi-backend story matters.
3. Write up the decision. If the edge test passes, draft an ADR in `docs/adr/` (next number 0007) on whether a Rust rewrite is worth it. My recommendation so far: the prototype works, but it only gains backends RSilo can mostly reach through S3 already, and it costs a full rewrite plus per-backend capability gaps. Lean towards no unless Owners ask for WebDAV or Azure.

## Gotchas already hit

- Call `opendal::install_default()` before building an `Operator`, because `#[ctor]` doesn't run on wasm.
- Don't set `strip = true` in the release profile; it breaks wasm-bindgen.
- `wrangler dev` reruns `worker-build` on file changes and needs `~/.cargo/bin` on PATH.
- On the user's shell setup, inline `python3` heredocs are blocked; write scripts to files instead.
