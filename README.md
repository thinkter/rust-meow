# Rust Meow

Rust Meow is a small Tauri desktop client backed by a local
[whatsmeow](https://github.com/tulir/whatsmeow) process. The SolidJS webview
owns presentation and virtualized lists; the Tauri Rust core owns the typed
desktop boundary; the Go sidecar remains the sole owner of WhatsApp state,
history reduction, media, and the durable databases.

The Tauri app under `tauri/` is the primary desktop on this branch. The GPUI
implementation under `desktop/` remains available as the behavioral reference
during migration. This is still a private-testing build, not a production-ready
WhatsApp Desktop replacement; the exact parity and release gates live in
[`docs/TAURI_PARITY.md`](docs/TAURI_PARITY.md).

## Architecture

```text
SolidJS + TanStack Virtual (Tauri webview)
              typed invoke + ordered Channel events
Tauri Rust core
              4-byte BE length + protobuf v16 Envelope
Go sidecar (whatsmeow)
              session.db + client.db + bounded media cache
```

Only protobuf frames are written to sidecar stdout. Diagnostics go to
`backend.log`. Frames are capped at 8 MiB, and the versioned Hello handshake
must finish before other RPCs or events are accepted. The Tauri core reuses the
existing Rust bridge, path, and sticker modules, while Rust protobuf bindings
are generated directly from `proto/bridge.proto`.

## Prerequisites

- Go 1.25 or newer
- the repository Rust toolchain and Cargo
- Node.js plus pnpm 10.28.2
- Tauri v2 Linux development packages, including WebKitGTK 4.1 headers
- `dpkg` tooling to create the Linux `.deb`

Install the pinned frontend dependency graph with:

```sh
make deps
```

## Run it

The deterministic fake backend needs no account and is the fastest UI loop:

```sh
make dev-fake
```

It provides 10,000 chats, paged messages, pairing events, and periodic live
messages. It does not prove real pairing, persistence, receipts, or media
transport.

Build and run against the real Go sidecar with:

```sh
make dev
```

The first clean launch displays a QR code. Scan it from **WhatsApp > Linked
devices > Link a device**. Use `RUST_MEOW_DATA_DIR` to isolate a QA profile;
the backend takes an OS-level profile lock and fails a second process closed.

## Checks and builds

| Command | Result |
| --- | --- |
| `make check` | Go tests/vet, strict TypeScript, and warning-free all-target Tauri Rust lint |
| `make test` | Go tests, minified frontend build, and Tauri Rust tests |
| `make build` | Unbundled size-optimized Tauri executable with adjacent stripped sidecar |
| `make release-linux` | Native x86-64 or arm64 `.deb` containing the stripped Go sidecar |
| `make legacy-test` | GPUI regression tests |
| `make legacy-release` | Previous GPUI release layout |

`make build` writes `tauri/src-tauri/target/release/rust-meow` and places a
stripped static sidecar next to it. `make release-linux` detects the native Linux
architecture, stages the target-triple-suffixed sidecar expected by Tauri, and
writes the package beneath:

```text
tauri/src-tauri/target/<target-triple>/release/bundle/deb/
```

The bundle-only config is `tauri/src-tauri/tauri.bundle.conf.json`. Keeping
`externalBin` there means normal fake development does not require a staged Go
binary. A release is not validated merely because it bundles: unpack it and
prove the installed app starts its adjacent sidecar and completes protocol v16
Hello without `RUST_MEOW_BACKEND`.

The 2026-07-22 Linux x86-64 release measurement is:

| Artifact | Exact bytes |
| --- | ---: |
| Tauri executable | 6,016,104 |
| stripped static Go sidecar | 22,229,154 |
| combined executable payload | 28,245,258 |
| `.deb` package | 10,673,232 |

That combined payload is 48.94% smaller than the measured 55,320,882-byte
GPUI-plus-sidecar baseline. The final `.deb` SHA-256 is
`f69724eb32eef434a7df2cf47d340d1797eacc61ef2e1c99369455ff0b48b7cd`;
its manifest, two mode-755 executables, desktop entry, and 32/128/256-pixel
icons were verified after unpacking. A prior adjacent-layout smoke reached
pairing after Hello without a backend override, rejected a second app instance,
and reaped the sidecar on window close. Cross-platform, clean-machine, and
current-artifact launch tests remain release gates.

## Data and safety

Private state uses the existing `rust-meow` platform data directory. It
contains linked-device credentials and must never be attached to bug reports.
`RUST_MEOW_BACKEND` can select a development sidecar; `RUST_MEOW_DATA_DIR` and
`RUST_MEOW_CONFIG_DIR` select isolated locations.

On Unix, startup creates or repairs the profile and cache directories to mode
0700 and database/log files to mode 0600. An advisory profile lock prevents two
backend processes from opening the same databases. Logout stops account-scoped
background work, unlinks the device, clears both SQLite databases including the
FTS5 index, checkpoints and vacuums them, and removes managed avatar/media
caches before a fresh pairing client is exposed. This is application-level
deletion of active files, not a forensic guarantee against backups, filesystem
snapshots, or storage-device wear levelling.

This is an unofficial client built on WhatsApp's linked-device protocol. Keep
it to private testing until the packaging, lifecycle, platform, accessibility,
security, and feature gates in the parity ledger are proven. In particular,
an app/sidecar update must remain atomic because different protocol versions
fail closed by design.

More implementation detail, direct commands, troubleshooting, and QA guidance
are in [`tauri/README.md`](tauri/README.md).
