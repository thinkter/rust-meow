# Rust Meow Tauri desktop

This directory contains the primary Tauri v2 desktop on the migration branch.
It keeps the existing Go/whatsmeow backend and durable data model while
replacing the GPUI shell with SolidJS. GPUI remains the behavioral reference
until the proof gates in [`../docs/TAURI_PARITY.md`](../docs/TAURI_PARITY.md)
pass.

This is not yet a production release. A successful build is evidence that the
boundaries compile, not evidence of WhatsApp Desktop feature parity.

## Stack and ownership

- Tauri 2.11 Rust core
- SolidJS 1.9, TypeScript, Vite 8, and TanStack Solid Virtual
- protocol v14 of the existing framed protobuf bridge
- the existing statically linked Go/whatsmeow sidecar

```text
SolidJS webview
  typed invoke commands + ordered Channel events
                    |
Tauri Rust core (`src-tauri/src/lib.rs`)
  RPC correlation + dialog/opener + sticker preparation
                    |
  4-byte BE length + protobuf Envelope (v14, max 8 MiB)
                    |
Go sidecar
  WhatsApp + session.db + client.db + media cache + backend.log
```

WhatsApp credentials, session state, product SQLite data, media download, and
protocol behavior stay in Go. The webview is a bundled static SPA and does not
receive a database or process-spawn API.

The Rust core reuses the non-UI modules in `../desktop/src/bridge.rs`,
`paths.rs`, and `sticker.rs`. `src-tauri/build.rs` generates Rust types directly
from `../proto/bridge.proto`; there is no copied Tauri protocol schema.

The frontend boundary lives in `src/lib/types.ts` and `src/lib/bridge.ts`.
`src/App.tsx`, `src/state/app.ts`, and `src/components/` provide the application
store and screens. The Rust core registers 27 commands, including attachment
send/download, validated media opening, and app restart, and forwards backend
state through a Tauri `Channel`.

## Prerequisites

- Go 1.25 or newer
- the repository Rust toolchain and Cargo
- Node.js supported by Vite 8
- pnpm 10.28.2, as declared in `package.json`
- Tauri v2 Linux dependencies, including WebKitGTK 4.1 development packages
- `dpkg` tooling for the Linux package target

From the repository root, install the exact lockfile dependency graph:

```sh
make deps
```

## Fake-backend development

```sh
make dev-fake
```

This passes `--fake-backend` through pnpm and the Tauri CLI to the Rust binary.
The deterministic fixture provides 10,000 chats, paged messages, pairing
events, and periodic live messages without a WhatsApp account.

Use it for layout, virtualization, search/navigation, scroll anchoring, and
repeatable screenshots. It is not evidence for real pairing, persistence,
receipts, identity merging, or media transport.

The equivalent direct command from `tauri/` is:

```sh
pnpm tauri dev -- -- --fake-backend
```

Both `--` separators are intentional.

## Real-backend development

```sh
make dev
```

The target builds `build/rust-meow-backend` and starts Tauri with its absolute
path in `RUST_MEOW_BACKEND`. The sidecar is launched with `--stdio`,
`--data-dir`, and `--log-file`.

Use an isolated profile when a test could pair, mutate, or log out an account:

```sh
qa_profile="$(mktemp -d)"
RUST_MEOW_DATA_DIR="$qa_profile" make dev
```

The profile contains linked-device credentials. Keep it private, never attach
it to bug reports, and never run two clients against the same directory. The
single-instance plugin is registered before sidecar setup so a normal second
application process exits before it can open the databases; external backend
processes and deliberate profile overrides still require operator care.

## Bootstrap and failure model

The frontend initializes in this order:

1. create a Tauri `Channel` and invoke `subscribe_backend`;
2. invoke `hello` and require protocol v14 on both sides;
3. invoke `get_auth_state`;
4. start pairing or load the first chat page;
5. apply responses as snapshots and Channel messages as idempotent live
   upserts.

Protocol v14 and attachment RPCs are wired through the Go backend, fake bridge,
Tauri handler, and typed frontend. This does not prove the document/audio/video
UX; real transport, persistence, playback, error, and platform checks remain in
parity gates `CP-10` through `CP-12`.

The adapter preserves backend event sequence and reports gaps, but still lacks
a backend epoch/restart-resync supervisor. Until `TR-07` and `TR-08` pass, a
bridge exit requires an app restart and cannot be treated as recovered live
state.

## Checks

Run the Tauri-primary checks from the repository root:

```sh
make check
make test
```

`make check` runs Go tests/vet, strict TypeScript, and warning-free all-target
Tauri Rust clippy. `make test` runs Go tests, produces the minified frontend,
and runs the Tauri Rust tests. `make release-linux` depends on the complete
check target before packaging.

GPUI remains the migration reference, so run its separate regression suite
before cutover-sensitive changes:

```sh
make legacy-test
```

## Unbundled release executable

```sh
make build
./tauri/src-tauri/target/release/rust-meow
```

The target makes a size-optimized Tauri release and copies a stripped static Go
sidecar beside it. The Rust release profile uses one codegen unit, full LTO,
`opt-level = "s"`, panic abort, and symbol stripping.

## Linux package with sidecar

```sh
make release-linux
```

The target supports native Linux x86-64 and arm64. It builds a static stripped
Go binary with the target-triple suffix Tauri requires, then merges
`src-tauri/tauri.bundle.conf.json` to create a `.deb` under:

```text
src-tauri/target/<target-triple>/release/bundle/deb/
```

The base `tauri.conf.json` deliberately omits `externalBin`, so fake development
does not require a staged Go binary. The generated sidecar inputs under
`src-tauri/binaries/` are ignored.

Bundling is only the first distribution gate. Unpack the package, verify the
sidecar and executable modes, launch without `RUST_MEOW_BACKEND`, and prove the
installed app completes Hello. Signing, atomic app/sidecar updates, and clean
machine tests remain open gates `TR-18`, `TR-19`, and `DS-18`.

`.deb` is the primary Linux size comparison. AppImage bundles more runtime
libraries and should be measured separately. The current base config leaves
AppImage media-framework bundling off; audio/video QA must decide the codec
tradeoff explicitly.

### Measured Linux x86-64 package

Measured from commit `49e70ef` in the 2026-07-22 integration worktree:

| Artifact | Exact bytes | gzip -9 reference |
| --- | ---: | ---: |
| Tauri executable | 6,016,104 | 2,521,560 |
| stripped static Go sidecar | 22,229,154 | 7,839,622 |
| combined executable payload | 28,245,258 | 10,361,182 |
| `.deb` | 10,673,232 | package size |

The measured `.deb` SHA-256 is
`f69724eb32eef434a7df2cf47d340d1797eacc61ef2e1c99369455ff0b48b7cd`.

The frontend JavaScript plus CSS is 61,418 bytes with per-file gzip -9. The
combined executable payload is 48.94% smaller than the measured
55,320,882-byte GPUI-plus-sidecar baseline; the Tauri executable alone is
81.93% smaller than the 33,284,240-byte GPUI executable. The Go sidecar grew
192,512 bytes (0.87%) with attachment transport, media-cache limits, profile
locking, and secure logout erasure.

The final `.deb` was unpacked, its md5 manifest passed, and it contained both
mode-755 executables under `/usr/bin`, a desktop entry, and 32/128/256-pixel
launcher icons. An earlier adjacent-layout smoke with a fresh profile and no
`RUST_MEOW_BACKEND` reached the pairing screen after Hello/auth, reaped the
sidecar on normal close, and rejected a second launch without spawning another
backend. A current-artifact launch plus cross-platform signing and clean-machine
tests remain open gates.

## Security boundaries

The production frontend must stay local: no remote pages, CDN scripts, remote
fonts, or unsandboxed message HTML.

The `main` window can use a native file dialog and open validated URLs. It has
no direct opener path permission. Downloaded documents go through the Rust
`open_media_path` command, which canonicalizes the existing file and rejects
anything outside the active profile's `media` directory before asking the OS
to open it.

The asset protocol has an empty static scope. During setup, Rust grants the
resolved active profile's `media` tree and direct files in its managed `avatars`
directory, so custom `RUST_MEOW_DATA_DIR` profiles work without exposing their
databases or logs. Rust tests reject database files, nested avatar paths,
symlink escapes, and unrelated files; repeat the proof on every target. Never
return WhatsApp media keys or session secrets to JavaScript.

Logout blocks new account work, joins active and queued media operations,
invalidates old event/pairing/reconciliation generations, clears the product
and WhatsMeow tables, removes FTS5 terms with its secure-delete mode, then
checkpoints and vacuums both databases before publishing a fresh pairing
client. Managed avatar and media caches are removed too. This cannot erase
copies retained by backups, filesystem snapshots, or storage wear levelling.

## Troubleshooting

### Backend missing or immediate bridge exit

For development, use `make dev` so `RUST_MEOW_BACKEND` is absolute. Without an
override, the bridge looks for `rust-meow-backend` next to the app executable.

For a package, use `make release-linux`, unpack the `.deb`, and confirm both
executables are installed together. Presence alone is not proof that Hello
succeeds.

### Port 1420 is already in use

Vite uses fixed port 1420 with `strictPort: true`. Stop the existing dev process
instead of silently changing ports.

### Protocol mismatch

Build the app and backend from the same commit. Do not bypass the Hello error;
mixed protocol versions fail closed intentionally.

### A paired profile appears empty or asks for QR again

Check `RUST_MEOW_DATA_DIR`. Do not copy only `client.db`; the linked-device
`session.db` and related store state belong together. Stop all Rust Meow
processes before copying a profile.

### Media works in development but not release

Inspect the CSP, opener and asset scopes, canonical path, and approved media
root. Do not grant all of `$HOME` or disable the CSP as a workaround.
