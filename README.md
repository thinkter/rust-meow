# Rust Meow

A small WhatsApp desktop client. The UI is SolidJS in a Tauri webview. A Go
sidecar built on [whatsmeow](https://github.com/tulir/whatsmeow) does the real
work and owns the databases.

<img width="1912" height="1160" alt="Rust Meow screenshot" src="https://github.com/user-attachments/assets/dfd4818f-f273-443c-a701-8c7873359ce0" />

Private testing only. It's an unofficial client and not a WhatsApp Desktop
replacement, so don't treat it like one.

## Running it

You need Go 1.25+, Rust (stable), Node 22, pnpm 10.28.2, and the Tauri Linux
deps. The apt list is in `.github/workflows/release.yml`. Codex CLI is only for
Agent Control.

```sh
make deps
make dev-fake   # fake data, no account. good for layout, nothing else
make dev        # real sidecar. scan the QR under WhatsApp > Linked devices
```

On Windows, run these from Git Bash. For a throwaway profile, prefix `make dev`
with `RUST_MEOW_DATA_DIR="$(mktemp -d)"`.

## Checks and builds

- `make check`: Go tests, TypeScript and Rust lint
- `make test`: Go, frontend and Tauri tests
- `make build` or `make release-linux`: release binary or `.deb`. The `.deb`
  target runs `make check` first.

Pushing a `v*` tag builds installers for every supported platform and publishes
a GitHub Release. Run the Release workflow by hand if you only want artifacts.

## Agent Control

Experimental. Allowlisted WhatsApp chats can start and watch Codex runs on your
machine. Only use it on machines and chats you control.

**Read this first.** Runs get `:danger-full-access` with network access and no
approval prompts. Owners and Operators can run any command and touch files
outside the workspace. Only the Access list and Control chats decide who gets
in, so pick carefully.

Turn it on under **Settings > Advanced > Experimental features**. In the Agent
Control panel, add a workspace folder, enable the chats that can send commands,
then enable the controller under **Overview**.

Owners (the linked-device account) can use every workspace. Operators can start
and stop runs in granted workspaces. Viewers can only check status. Replies go
back to the chat, so the whole group can read them.

```text
!meow agent @rust-meow summarize this repository
!meow agent status
!meow agent stop 12AB34CD
```

Leave out `@rust-meow` for the default workspace. Reply to a run to continue it.
One active run per workspace, three per machine.

## Data

Your profile is in `~/.local/share/rust-meow` on Linux (`~/Library/Application
Support/rust-meow` on macOS, `%LOCALAPPDATA%\rust-meow` on Windows). It holds
linked-device credentials, so keep it out of bug reports. Logout erases the
local databases and media cache, but not backups or snapshots.

More detail, including architecture and troubleshooting, is in
[tauri/README.md](tauri/README.md).
