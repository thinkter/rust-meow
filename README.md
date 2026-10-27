# Rust Meow

A small WhatsApp desktop client. The UI is SolidJS in a Tauri webview. A Go
sidecar built on [whatsmeow](https://github.com/tulir/whatsmeow) does the actual
WhatsApp work and owns the databases.

<img width="1912" height="1160" alt="Rust Meow screenshot" src="https://github.com/user-attachments/assets/dfd4818f-f273-443c-a701-8c7873359ce0" />

This is private-testing software. It's an unofficial client, not a WhatsApp
Desktop replacement, so don't treat it like one.

## Running it

You need Go 1.25+, Rust (stable), Node 22, pnpm 10.28.2, and the Tauri Linux
dependencies. Copy the apt list from `.github/workflows/release.yml`, it's all
there. Codex CLI is only needed for Agent Control.

```sh
make deps
make dev-fake   # fake data, no account. good for layout, nothing else
make dev        # real sidecar. scan the QR under WhatsApp > Linked devices
```

On Windows, run these from Git Bash.

For a throwaway profile:

```sh
RUST_MEOW_DATA_DIR="$(mktemp -d)" make dev
```

## Checks and builds

- `make check`: Go tests and vet, strict TypeScript, Rust clippy
- `make test`: Go, frontend and Tauri tests
- `make build`: release binary in `tauri/src-tauri/target/release/`
- `make release-linux`: `.deb` with the sidecar bundled (runs `make check` first)
- `make legacy-test`: tests for the old GPUI app in `desktop/`

Push a `v*` tag to build installers for each supported platform and publish them
to a GitHub Release. You can also run the Release workflow by hand.

## Agent Control

Experimental. Allowlisted WhatsApp chats can start and watch Codex runs on your
machine. Only turn this on for machines and chats you actually control.

**Read this first.** Runs get Codex's `:danger-full-access` profile, with network
access and no approval prompts. Owners and Operators can run any command and
read or change files outside the workspace. Only the Access list and Control
chats decide who gets in. Pick carefully.

To set it up, go to **Settings > Advanced > Experimental features** and turn on
Agent Control. Then, in the Agent Control panel, add a workspace folder, enable
the chats allowed to send commands, and enable the controller under
**Overview**. Use **Access** to give contacts a role.

- **Owner**: the linked-device account. Everything, no grant needed.
- **Operator**: starts and stops runs in granted workspaces.
- **Viewer**: status only.

Replies go to the chat the command came from, so everyone in a group can read
them. Usage:

```text
!meow agent @rust-meow summarize this repository
!meow agent status
!meow agent stop 12AB34CD
```

Leave out `@rust-meow` for the default workspace. Reply to a run to continue it.
One active run per workspace, three per machine.

## Data

Your profile lives in `~/.local/share/rust-meow` on Linux
(`~/Library/Application Support/rust-meow` on macOS, `%LOCALAPPDATA%\rust-meow`
on Windows). It holds linked-device credentials, so keep it out of bug reports.
Logout erases the local databases and cached media, but it can't reach backups
or snapshots.

Architecture, security boundaries and troubleshooting are in
[tauri/README.md](tauri/README.md).
