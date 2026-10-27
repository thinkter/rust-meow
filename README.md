# Rust Meow

Rust Meow is a small WhatsApp desktop client. The interface is SolidJS in a
Tauri webview. A Go sidecar built on
[whatsmeow](https://github.com/tulir/whatsmeow) owns the session, history,
media, and databases. The webview displays them. Keep that straight and the
rest of this file will make sense.

<img width="1912" height="1160" alt="Rust Meow screenshot" src="https://github.com/user-attachments/assets/dfd4818f-f273-443c-a701-8c7873359ce0" />

> [!WARNING]
> Private testing only. This is an unofficial client, and it is not a WhatsApp
> Desktop replacement yet. Check [docs/TAURI_PARITY.md](docs/TAURI_PARITY.md)
> before you claim otherwise.

`tauri/` is the app. `desktop/` is the GPUI build, kept as a migration reference.

## Prerequisites

Yes, all of them.

- Go 1.25 or newer
- Rust stable with Cargo
- Node.js 22 and pnpm 10.28.2
- Tauri v2 Linux dependencies, including WebKitGTK 4.1. On Debian or Ubuntu,
  copy the package list from the **Install Linux dependencies** step in
  [`release.yml`](.github/workflows/release.yml). It's right there.
- [Codex CLI](https://developers.openai.com/codex/cli/), installed and signed in.
  Only needed for Agent Control.

## Quick start

```sh
make deps       # install the locked frontend dependencies
make dev-fake   # fake data, no account needed
make dev        # real sidecar
```

- `make dev-fake` serves 10,000 fake chats and periodic live messages. It's for
  layout. It proves nothing about pairing, persistence, receipts, or media.
- `make dev` builds the Go sidecar and connects to it. A clean profile shows a
  QR code on first launch. Scan it from **WhatsApp > Linked devices > Link a
  device**.
- Windows: run these from Git Bash.
- Throwaway profile: `RUST_MEOW_DATA_DIR="$(mktemp -d)" make dev`.
- Build the app and sidecar from the same commit. Protocol v22 fails closed on a
  mismatch. That's the point.

## Commands

| Command | What it does |
| --- | --- |
| `make check` | Go tests and vet, strict TypeScript, Rust clippy with warnings as errors |
| `make test` | Go tests, frontend tests and build, Tauri Rust tests |
| `make build` | Optimized Tauri binary with the sidecar beside it, in `tauri/src-tauri/target/release/` |
| `make release-linux` | Native `.deb` with the sidecar bundled. Runs `make check` first |
| `make legacy-test` | Tests for the GPUI reference app |

## Releases

Pushing a `v*` tag builds installers for Linux (x86-64, ARM64), macOS (Intel,
Apple Silicon), and Windows (x86-64), then publishes them to a GitHub Release
with `SHA256SUMS.txt`. Just want the artifacts? Run the **Release** workflow by
hand. It's a button. macOS builds are ad-hoc signed. Windows and macOS
production signing and notarization still need credentials.

## WhatsApp Agent Control

Experimental. Allowlisted WhatsApp chats can start and watch Codex runs on this
machine. Enable it only on a machine and in chats you administer.

> [!CAUTION]
> Runs use Codex's `:danger-full-access` profile, have network access, and never
> ask for approval. Owners and Operators can run arbitrary commands and read or
> change files outside the registered workspace. The Access list and Control
> chats allowlist are the only security boundary. If that sounds like a lot of
> power, that's because it is.

Setup:

1. Run `make dev`, then open **Settings > Advanced > Experimental features** and
   turn on **Agent Control**. It's off by default.
2. Open **Agent Control** from the left navigation.
3. **Workspaces**: add a repository folder with an alias, such as `rust-meow`.
4. **Control chats**: enable each direct chat or group allowed to send commands.
5. **Access** (optional): give a contact the Operator or Viewer role on a
   workspace.
6. **Overview**: set the agent alias and Codex executable (`codex`), then choose
   **Enable Agent Control**. It stays disabled until you have a workspace and a
   control chat.

Roles: Owners (the linked-device account) reach every workspace with no grant
needed. Operators start and stop runs in granted workspaces. Viewers only check
status. Replies go to the chat where the command was sent, so everyone in a
group can read them, whatever their role.

With an agent alias of `agent` and a workspace alias of `rust-meow`:

```text
!meow agent @rust-meow summarize this repository
!meow agent status
!meow agent stop 12AB34CD
```

Leave out `@rust-meow` to use the default workspace. Reply to a run message to
continue that Codex thread. Only one run can be active per workspace, and three
across the host. Use **Runs & audit** to watch activity or emergency-stop a run.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `RUST_MEOW_DATA_DIR` | Profile directory. Point it at a throwaway folder for QA. |
| `RUST_MEOW_CONFIG_DIR` | Config directory override. |
| `RUST_MEOW_BACKEND` | Sidecar binary. `make dev` sets it. Otherwise the app looks next to itself. |

## Data and safety

- The profile lives in the platform data directory: `~/.local/share/rust-meow`
  on Linux, `~/Library/Application Support/rust-meow` on macOS, and
  `%LOCALAPPDATA%\rust-meow` on Windows.
- It holds linked-device credentials. Never attach it to a bug report.
- One process per profile. A second one refuses to start.
- Logout unlinks the device and erases the local databases and cached media.
  Backups and filesystem snapshots are out of its reach.
- Edit and delete history is stored locally. Showing it in chats is opt-in under
  **Settings > Advanced > Message change history**.
- Diagnostics go to `backend.log` in the data directory.

## More

- [`tauri/README.md`](tauri/README.md): architecture, security boundaries, troubleshooting
- [`docs/TAURI_PARITY.md`](docs/TAURI_PARITY.md): parity ledger and release gates
- [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md): performance budgets
- [`docs/VERSIONING.md`](docs/VERSIONING.md): version and protocol policy
- [`CHANGELOG.md`](CHANGELOG.md)
