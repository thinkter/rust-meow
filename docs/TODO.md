# Engineering TODOs

This document tracks concrete follow-up work that is not yet implemented.
Items should include the observed failure, intended design, and acceptance
criteria so they can be implemented and tested without reconstructing the
original incident.

## P0: Make logout fast, observable, and crash-safe

### Observed failure

On a profile containing roughly 160,000 messages, logout removed the linked
WhatsApp device but spent several minutes clearing the product database. The
frontend gave up after the generic 60-second write timeout while the backend
continued its synchronous `DELETE`, secure-delete, checkpoint, and `VACUUM`
work.

The frontend was then closed, leaving the busy backend orphaned with
`.profile.lock`, `client.db`, and `session.db` open. A subsequent launch
correctly failed with:

```text
Rust Meow profile is already in use
backend transport failed: failed to fill whole buffer
```

Deleting `.profile.lock` is not a safe recovery: lock ownership belongs to the
live process, and that process may still be mutating SQLite.

### Preferred design: rotate the profile

- After remote unlink succeeds, stop account-scoped work and close all database
  handles.
- Atomically rename the active profile to a unique tombstone such as
  `rust-meow.deleting-<uuid>`.
- Create and open a fresh private profile immediately, then return the UI to
  pairing.
- Delete the tombstoned profile in a supervised background job. Include the
  databases, WAL/SHM files, managed media and avatars, logs, and any
  application-created backups.
- Resume an interrupted tombstone deletion on the next launch.
- Preserve fail-closed behavior: never expose a fresh pairing state until the
  old account can no longer write into the active profile.

Removing whole retired database files is preferable to deleting hundreds of
thousands of rows and vacuuming them synchronously. Document that
application-level deletion cannot guarantee erasure from filesystem snapshots,
user-created backups, or flash wear levelling.

### Logout UX and protocol

- Model logout as a long-running operation with explicit stages:
  `unlinking`, `isolating`, `rotating_profile`, `deleting_local_data`, and
  `ready`.
- Show progress in the UI and keep account actions disabled until profile
  rotation has completed.
- Do not use the generic 60-second `WRITE_TIMEOUT` for logout.
- If background deletion continues after rotation, say so without blocking
  fresh pairing.
- A timeout or interrupted UI must report that cleanup is continuing; it must
  not turn an in-progress logout into a generic fatal bridge error.

### Sidecar and profile-lock lifecycle

- Ensure the backend cannot remain indefinitely after its desktop parent exits
  or crashes. Use parent-death/process-group supervision appropriate to Linux,
  macOS, and Windows, in addition to graceful `Shutdown` and forced reap.
- Make long-running database work context-cancellable and roll back safely when
  the parent dies.
- Store diagnostic metadata in the locked file after acquiring it: PID,
  process start time, application version, and current operation.
- On lock conflict, focus the existing app where supported. Otherwise show an
  actionable message such as “Rust Meow is still deleting local data” with a
  safe retry path.
- Never automatically remove a lock file as a substitute for checking the
  owning process.

### Acceptance criteria

- A populated fixture with at least 200,000 messages reaches a fresh pairing
  profile within five seconds of confirmed remote unlink.
- Closing or crashing the desktop during every logout stage leaves no
  indefinitely running backend and no writable old account in the active
  profile.
- Relaunching during background deletion either focuses the existing instance
  or starts against the new profile without a misleading transport failure.
- Tests cover cancellation, database-close failures, rename failures,
  interrupted deletion, restart recovery, and cross-filesystem/custom
  `RUST_MEOW_DATA_DIR` behavior.
- After cleanup, the retired profile contains no databases, WAL/SHM files,
  FTS content, managed media, avatars, logs, or application-created backups.
- Double-launch and parent-crash integration tests pass on Linux, macOS, and
  Windows.

### Relevant code

- `backend/internal/wa/client.go`: logout isolation and session cleanup
- `backend/internal/store/store.go`: product database clearing
- `backend/internal/sqliteprivacy/sqliteprivacy.go`: checkpoint and vacuum
- `backend/internal/profilelock/`: profile ownership
- `desktop/src/bridge.rs`: sidecar launch, shutdown, and reap
- `tauri/src-tauri/src/lib.rs`: request timeouts and lifecycle supervision
- `tauri/src/state/app.ts`: logout UI state

