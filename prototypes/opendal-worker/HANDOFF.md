# Handoff: OpenDAL Rust Worker prototype

Branch `proto/opendal-worker` (pushed). Findings and run steps are in `README.md`, which you should read first.

## Why this exists

We asked whether RSilo should replace its S3-only storage with Apache OpenDAL. OpenDAL's npm package is a native NAPI addon that can't load in a Worker, so the only route is a Rust Worker (`workers-rs`, compiled to wasm). This prototype checks whether that works before anyone considers rewriting RSilo (about 16k lines of TS) in Rust. Nothing has been decided, and there's no ADR yet.

## State

- `src/lib.rs`: a minimal Worker. The backend comes from `STORAGE_SCHEME` plus `STORAGE_*` vars, GET and PUT bodies stream, and conditional requests pass through.
- `smoke.sh`: 18 checks. All pass on SeaweedFS S3. On SeaweedFS WebDAV, the 9 basic checks pass and the 9 conditional ones return 501 (expected).
- Bundle: 1.21 MB gzipped with S3 only, 1.36 MB with S3 + WebDAV + Azure. The free plan allows 3 MB.
- GCS can't work on wasm (`reqsign-core` compiles out `jwt` on wasm32).
- Was deployed to Cloudflare and torn down; see Edge results below.

## Setting up a new machine

1. Tools come from a flox env in this directory, not Homebrew: `flox init -d .`, then `flox install -d . rustup seaweedfs nodejs_22 gcc pkg-config openssl`, with `openssl.outputs = ["out", "dev"]` and `~/.cargo/bin` on PATH in the manifest (see `README.md`). `.flox` is gitignored. `rust-toolchain.toml` pins stable with the `wasm32-unknown-unknown` target, and rustup installs it on first `cargo` use.
2. `cargo install worker-build` (0.8.7 was used). It downloads a matching `wasm-bindgen` itself.
3. Node 22 for `npx wrangler@4`.
4. SeaweedFS (`weed`) for local S3 and WebDAV. Start it with `-ip=127.0.0.1 -ip.bind=127.0.0.1`, otherwise WebDAV binds only to the LAN IP.
5. Follow the Run section in `README.md`, then `./smoke.sh`. Expect 0 failures on S3.

## Edge results (2026-10-22)

Deployed as `opendal-worker-proto-r2` against the throwaway R2 bucket `opendal-proto` with `./r2.sh setup`. 17/18 smoke checks passed; R2 ignores `If-Match` on DELETE. CPU time is over the Free plan's 10 ms for many small requests and grows with body size (364 ms for a 12 MB GET). Details are in `README.md` under **Edge**. On this NixOS machine the tools come from a gitignored flox env in this directory (see `README.md`). The auto-mode guard blocks `wrangler secret put`, so the user runs `./r2.sh setup`.

## Next steps

1. Nothing; ADR-0007 (`docs/adr/0007-no-rust-opendal-rewrite.md`) accepted not doing the rewrite. This prototype is kept for reference.
2. Torn down on 2026-10-22 (`./r2.sh teardown`); `./r2.sh setup` recreates it.
3. Optional: Azure Blob against Azurite, and B2 at the edge, only if the ADR is reopened.

## Gotchas already hit

- Call `opendal::install_default()` before building an `Operator`, because `#[ctor]` doesn't run on wasm.
- Don't set `strip = true` in the release profile; it breaks wasm-bindgen.
- `wrangler dev` reruns `worker-build` on file changes and needs `~/.cargo/bin` on PATH.
- On NixOS, `cargo install worker-build` needs openssl's `dev` output in the flox env.
- On the user's shell setup, inline `python3` heredocs are blocked; write scripts to files instead.
