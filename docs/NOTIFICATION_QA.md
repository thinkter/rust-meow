# Desktop notification release gate

Rust Meow sends desktop notifications through a native Tauri command so the
process owns the platform click callback. Every activation is also copied into
a bounded native queue before the webview event is emitted. The frontend
registers its event listener, drains that queue, and waits until Hello, auth,
the chat list, and restored panes are ready before routing the target once.

## Automated coverage

Run the platform-independent policy and routing tests with:

```sh
pnpm --dir tauri test
cargo test --manifest-path tauri/src-tauri/Cargo.toml native_notifications
```

These tests cover foreground/mute/incoming policy, preview privacy, responsive
split visibility, pre-bootstrap delivery, duplicate delivery, chat-ID merges,
missing chats/messages, bounded native storage, stable per-chat replacement
IDs, and session-cached permission denial. A second instance can inject the
same activation path without starting another sidecar:

```sh
rust-meow \
  --notification-chat-id='<chat jid>' \
  --notification-message-id='<message id>'
```

The running instance must focus and route the exact target once. This command
is also the deterministic packaged smoke path when an OS notification server
cannot be scripted safely.

## Packaged DS-03 matrix

Use a throwaway paired profile and record the commit, package hash, OS version,
desktop notification service, and result for every row. Do not use development
mode as packaged proof.

| Scenario | Linux | Windows | macOS |
| --- | --- | --- | --- |
| First notification appears with previews enabled | pending | pending | pending |
| Preview-disabled body contains no message text | pending | pending | pending |
| Muted, outgoing, and currently visible messages are suppressed | pending | pending | pending |
| Repeated messages in one chat replace/group coherently | pending | pending | pending |
| Click while UI bootstrap is loading routes after bootstrap | pending | pending | pending |
| Click while hidden focuses the existing window and exact message | pending | pending | pending |
| Second-instance activation focuses the first process once | pending | pending | pending |
| Deleted message opens latest with a non-fatal explanation | pending | pending | pending |
| Merged chat ID resolves to its canonical chat | pending | pending | pending |
| Disabled OS service never prevents messaging startup | pending | pending | pending |

### Linux

- Record the desktop shell and notification daemon because action support is a
  server capability, not one uniform Linux permission prompt.
- Test the shipped AppImage and Debian/RPM package where produced. Confirm the
  application name/icon and the `default` action callback.
- Repeat once with the D-Bus notification service unavailable; startup and
  message delivery must continue even though notification display reports an
  isolated failure.

### Windows

- Install the signed MSI/NSIS artifact so the configured
  `com.rustmeow.desktop` AppUserModel ID is registered; an unpacked release
  executable is not sufficient proof.
- Verify Focus Assist and per-app Notifications settings, then disable and
  re-enable the app in Settings without triggering repeated application-level
  permission prompts.

### macOS

- Test a signed `.app` bundle launched from Finder. Development notifications
  are associated with Terminal and do not prove the packaged bundle identity.
- Verify denial and re-enable through System Settings, hidden-window focus,
  and action delivery on every supported macOS baseline.

Platform rows stay `pending` until tested on that actual packaged target. A
cross-compiled binary or a unit test is useful build evidence but is not an OS
notification activation result.
