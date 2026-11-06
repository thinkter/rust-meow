# Rust Meow

Rust Meow is an unofficial WhatsApp desktop client for private testing. It uses a
SolidJS frontend in a Tauri shell and a Go/whatsmeow sidecar for WhatsApp,
local storage, and media.

## Quick start

Requirements: Go 1.25+, stable Rust, Node.js 22, pnpm 10.28.2, and the Tauri
Linux packages when developing on Linux.

```sh
make deps
make dev-fake   # deterministic data; no WhatsApp account needed
make dev        # real backend; scan the QR code in WhatsApp > Linked devices
```

Use an isolated profile when pairing or testing logout:

```sh
RUST_MEOW_DATA_DIR="$(mktemp -d)" make dev
```

The profile contains linked-device credentials. Do not put it in bug reports.

## Common commands

| Command | Purpose |
| --- | --- |
| `make check` | Version check, Go tests/vet, TypeScript check, Rust clippy |
| `make test` | Backend, frontend, performance, and Tauri tests/build |
| `make build` | Unbundled optimized desktop binary plus sidecar |
| `make release-linux` | Linux `.deb` with the Go sidecar |
| `make legacy-test` | Tests the old GPUI client kept as a migration reference |

The Makefile is a small project-level wrapper: it builds the Go sidecar, runs
checks across Go/TypeScript/Rust, stages Tauri's sidecar, and keeps release
commands reproducible. It is not another build system. Run `make help` for the
full target list.

## Repository layout

- `backend/` — Go WhatsApp/whatsmeow sidecar, databases, media, and bridge logic.
- `tauri/` — current desktop app: SolidJS/Vite UI and Tauri/Rust host.
- `desktop/` — previous GPUI desktop, retained until the Tauri migration is complete.
- `proto/` — protobuf contract shared by the sidecar and desktop clients.
- `scripts/` — version, release, and performance tooling.
- `docs/` — migration, release, QA, and performance notes.
- `plugins/` — the optional Agent Control plugin.

`build/`, `tauri/node_modules/`, `tauri/dist/`, Cargo targets, and
`tauri/src-tauri/binaries/` are generated or local-only and ignored by Git.
Release scripts populate the binaries directory with the sidecar for the target
being packaged.

## Agent Control

Agent Control is experimental and off by default. When enabled, allowlisted
WhatsApp chats can start Codex runs with full filesystem and network access.
Only enable it on machines and chats you control.

## More detail

- [Tauri development and release notes](tauri/README.md)
- [Versioning and release checklist](docs/VERSIONING.md)
- [Changelog](CHANGELOG.md)
