# Tauri migration parity ledger

This document is the release contract for replacing the GPUI desktop with the
Tauri desktop. It deliberately separates four different claims:

1. the feature exists in the current GPUI client;
2. the Go backend and protobuf bridge can perform it;
3. the Tauri Rust core exposes it safely;
4. the SolidJS UI has passed end-to-end desktop QA.

A matching screen is not parity. A row is complete only when the user action,
backend operation, persistence, live event, rendered result, failure handling,
and platform behavior named by its proof gate have all been observed.

Snapshot date: **2026-07-22**. The source of truth is the current
`codex/tauri-migration` worktree, especially `proto/bridge.proto`,
`backend/internal/`, `desktop/src/`, `tauri/src-tauri/src/lib.rs`, and
`tauri/src/`. The root README documents the supported Tauri-first workflows;
this ledger remains the more conservative release contract.

## Status language

| Status | Meaning |
| --- | --- |
| **GPUI** | Implemented in the existing GPUI desktop; it remains the behavioral reference until cutover. |
| **Core** | The Tauri Rust command/event adapter exists, but this alone does not prove UI parity. |
| **UI** | A Tauri UI path exists, but the named proof gate has not yet passed on all required platforms. |
| **Proven** | The named automated and manual evidence exists for Linux, Windows, and macOS where applicable. |
| **Missing** | No complete implementation exists in the current Tauri path. |
| **Upstream gap** | The current whatsmeow transport cannot provide literal WhatsApp Desktop behavior. |

When a cell contains multiple labels, the rightmost label is the current
Tauri state. Nothing in this ledger is **Proven** merely because it compiles.

## Architecture invariants

These are not optional implementation details. Violating any invariant blocks
release even if the visible UI appears correct.

- The Go sidecar remains the sole owner of the WhatsApp connection,
  `session.db`, `client.db`, history reduction, outgoing idempotency, and media
  cache.
- The Tauri webview never opens either database and cannot spawn arbitrary
  processes or read arbitrary local files.
- Tauri and the sidecar communicate only through one coordinated protocol
  version using four-byte big-endian length, protobuf payload, and a maximum
  frame size of 8 MiB. Poll and pinned-message work advanced the wire contract to v15; both
  processes must always be rebuilt together at that version.
- `Hello` is the first request. Normal requests are not sent before its version
  handshake succeeds.
- Request IDs correlate exactly one response. Timeouts, late responses, wrong
  response variants, bridge exit, and sidecar restart are explicit states.
- Backend event ordering is process-local. A restart resets the backend
  sequence, so the desktop must create a new epoch and refetch chats plus every
  open message window after a restart or event gap.
- Only one sidecar may use a data directory at a time. The desktop must enforce
  single-instance behavior and still fail safely if an external process holds
  the data directory.
- A clean app exit sends `Shutdown`, waits for the child, then force-kills and
  reaps it only after the grace period. An update must stop the sidecar before
  replacing binaries.
- The existing default data location and `RUST_MEOW_DATA_DIR` override remain
  compatible so migration does not silently require re-pairing.
- Media displayed in the webview is resolved from an opaque identity or a
  canonical path below an explicitly allowed media root. Session databases,
  logs, config, and arbitrary temporary files are never web assets.

## Current migration foundation

The scaffold currently uses SolidJS 1.9, Vite 8, TanStack Solid Virtual, Tauri
2.11, and a Rust adapter that reuses `desktop/src/bridge.rs`, `paths.rs`, and
`sticker.rs`. It exposes typed async commands and a Tauri `Channel` for backend
events. `tauri/src/lib/types.ts` defines the camelCase DTO boundary and
`tauri/src/lib/bridge.ts` wraps all 27 registered commands, including the two
attachment calls, validated media opening, and app restart. This is a useful
foundation, not a completed supervisor or proven UI.

Known foundation blockers at this snapshot:

- the Linux release target stages a target-triple Go backend and merges a
  bundle-only `externalBin` config; the unpacked `.deb` startup/Hello smoke
  passes on the current host, but a clean-machine install is still required;
- backend event `sequence` is preserved and gaps surface a problem event, but
  there is no process epoch, automatic resync, or restart/backoff supervisor;
- the asset protocol has an empty static scope and dynamically grants the
  active profile's media tree plus direct managed avatar files; Rust escape
  tests pass, but cross-platform proof is still required;
- the backend repairs Unix profile directories to mode 0700 and sensitive
  files to 0600, and takes a cross-process advisory profile lock; Linux lock
  tests and an earlier packaged double-launch pass, while cross-platform focus
  and failure behavior remain unproven;
- the reused bridge locates an adjacent binary or `RUST_MEOW_BACKEND`; adjacent
  lookup is verified for the unpacked `.deb`, not every installer format;
- the release profile uses `panic = "abort"`; crash-diagnostic implications
  must be accepted explicitly rather than inferred from the smaller size;
- the Makefile now makes Tauri the default development/build/check path; GPUI
  regressions remain an explicit migration gate;
- protocol v15 and attachment, poll, and pinned-message RPCs are wired through the Go backend,
  shared fake bridge, Tauri commands, and typed frontend, but the end-to-end
  document/audio/video gates remain unproven.

## Transport, lifecycle, and data integrity

| Capability | GPUI baseline | Tauri state | Proof required before cutover |
| --- | --- | --- | --- |
| Sidecar is sole state owner | GPUI | Core | **TR-01:** inspect open files while paired; only the Go PID may hold `session.db`/`client.db`; webview and Tauri code contain no SQL/session access. |
| Protocol v15 Hello-first handshake | Shared GPUI bridge at v15 | Core | **TR-02:** both processes declare v15; valid Hello succeeds; request-before-Hello and incompatible versions fail closed in backend tests and a packaged-app smoke test. |
| 8 MiB framed protobuf codec | GPUI | Core | **TR-03:** round-trip, zero-length, truncated, corrupt, and oversized frame tests pass on both sides. |
| Concurrent request correlation | GPUI | Core | **TR-04:** issue mixed read/write RPCs with deliberately reordered responses; each promise completes once with its own response. |
| Per-operation timeouts | GPUI | Core | **TR-05:** control/read/write stalls produce typed errors; late replies are ignored and pending entries are removed. |
| Ordered live event subscription | GPUI | Core | **TR-06:** subscribe before bootstrap, inject 500 ordered events, prove no loss, duplication, or response/event confusion. |
| Event sequence and restart epoch | GPUI partial | Gap detection core; recovery missing | **TR-07:** kill the backend mid-stream; UI announces reconnecting, increments epoch, refetches list/open chat, and converges without duplicates. |
| Bounded backpressure/resync | GPUI bounded queues | Gap warning core; resync missing | **TR-08:** stall the webview during an event burst; memory remains bounded and recovery emits/resolves `resyncRequired`. |
| Graceful shutdown and forced reap | GPUI | Core via reused bridge | **TR-09:** normal quit observes Shutdown; hung backend is killed after the grace period; no backend PID remains. |
| Crash/orphan containment | Partial | Missing | **TR-10:** force-crash the Tauri core on Linux, Windows, and macOS and prove the sidecar cannot remain indefinitely against the profile. |
| Automatic restart/backoff | Missing | Missing | **TR-11:** retry transient exits with bounded exponential backoff; protocol/data-corruption exits do not loop forever. |
| Single app/profile instance | Documented requirement | Backend profile lock proven on Linux; earlier package smoke passed | **TR-12:** start two packaged apps on every target; no second sidecar opens the DB, and the second either focuses the first or exits with an explicit product decision. |
| Stable data-directory resolution | GPUI | Core via reused paths | **TR-13:** upgrade a copied paired profile on all OSes without QR re-pair; custom `RUST_MEOW_DATA_DIR` remains isolated. |
| Product DB migration safety | GPUI | Backend-owned | **TR-14:** backup a populated DB, migrate, run `PRAGMA integrity_check`, verify counts/identities/media, and test rollback on injected failure. |
| Logout and fail-closed wipe | GPUI | Backend physical purge and lifecycle isolation proven; live UI pending | **TR-15:** confirm cancel does nothing in the packaged UI; automated tests already prove injected failure is fail-closed, active/queued work is isolated, SQLite/FTS/WAL bytes are purged, caches are removed, and a fresh pairing store remains usable. |
| Diagnostics never corrupt stdout | GPUI | Backend-owned | **TR-16:** backend diagnostics go to `backend.log`/stderr only; a log storm cannot corrupt framed stdout. |
| Fake 10,000-chat fixture | GPUI | Core (`--fake-backend`) | **TR-17:** packaged/debug Tauri starts with `--fake-backend`, renders 10,000 virtual chats, and exercises pairing plus paging deterministically. |
| Self-contained backend bundle | Manual adjacent copy | Linux `.deb` unpack/startup smoke passed; other targets pending | **TR-18:** unpack every installer, find the correct target sidecar, launch without environment overrides, and complete Hello. |
| Atomic app + sidecar update | Missing | Missing | **TR-19:** signed upgrade stops old child, replaces both versions, restarts, handshakes, and preserves the profile; rollback cannot mix protocol versions. |

## Authentication and synchronization

| User-visible behavior | GPUI baseline | Tauri state | Proof gate |
| --- | --- | --- | --- |
| Launch into paired/unpaired state | GPUI | Core command | **AU-01:** test clean, paired-disconnected, paired-connected, logged-out, and corrupt-profile starts. |
| QR pairing display and expiry | GPUI | Core/event; real isolated-profile scan reached connected | **AU-02:** retain packaged clean-profile proof for code replacement, expiry, cancellation, and connected state; automated lifecycle tests and a real development scan pass. |
| Pairing retry and readable errors | GPUI | Core/event; stale-handler retry regression proven | **AU-03:** packaged offline, QR channel failure, expired QR, and backend exit must expose actionable retry without blank UI. |
| Connection state and reconnect status | GPUI | Core/event | **AU-04:** toggle network and sleep/resume; header moves through connecting/connected/disconnected without stale state. |
| History-sync progress | GPUI | Core/event | **AU-05:** real initial sync reports progress, remains interactive, and converges to persisted chat/message counts after restart. |
| PN/LID conversation identity merge | Backend/GPUI | Backend/Core event | **AU-06:** history and live messages using both aliases render in one conversation; merge remaps selected chat and draft. |
| Reactions repair after legacy migration | GPUI | Core command/event | **AU-07:** seeded legacy reaction rows recover once, do not create pseudo-bubbles, and remain correct after restart. |
| Manual reconnect control | Missing | Missing | **AU-08:** if product design includes it, command resets only transient transport state and cannot damage the paired store. |
| Multiple accounts/profile switching | Missing | Missing | **AU-09:** each profile has isolated process/data/notifications; otherwise document single-account scope explicitly. |

## Sidebar, navigation, and search

| User-visible behavior | GPUI baseline | Tauri state | Proof gate |
| --- | --- | --- | --- |
| Virtualized, cursor-paged chat list | GPUI | Core command; UI required | **NV-01:** 10,000 chats create a bounded DOM, cursor pages append once, and scrolling does not request duplicate pages. |
| Sort by pinned/activity with stable ties | GPUI | Backend data | **NV-02:** fixture verifies pinned ordering, timestamp/ID ties, and live reorder without losing selection. |
| Chat avatar, title, preview, time, unread badge | GPUI | Core commands/events | **NV-03:** direct/group/unknown/avatar-denied rows match backend state and update live. |
| Inbox versus archived view | GPUI | Core data | **NV-04:** archived chats are excluded from inbox, visible in Archive, searchable, and open to the correct view. |
| Open newest/first-unread window | GPUI | Core command | **NV-05:** unread chat anchors first unread; read chat starts at latest; mark-read boundary is exact. |
| Older and newer keyset paging | GPUI | Core commands | **NV-06:** page both directions across timestamp ties with no gaps/duplicates and stable visual anchor. |
| Jump to latest | GPUI | Core command | **NV-07:** returning from old/search window fetches latest and follows only after data is rendered. |
| Smooth scroll and scroll interruption | GPUI | UI required | **NV-08:** discrete wheel acceleration, touchpad input, keyboard navigation, and user interruption behave naturally on all OSes. |
| New messages while at bottom | GPUI behavior reference | UI required | **NV-09:** append and remain pinned to bottom within tolerance; render event-to-row p95 is within target. |
| New messages while scrolled up | GPUI behavior reference | UI required | **NV-10:** viewport does not jump; unseen counter/jump affordance increments and clears correctly. |
| Per-chat session drafts | GPUI | UI required | **NV-11:** switch among chats during text/reply/mention composition; each draft restores and failed send cannot overwrite newer text. |
| Ctrl-Tab recent-chat switcher | GPUI | Missing until UI proof | **NV-12:** forward/reverse cycling wraps, commits on modifier release, cancels on Escape, and merged chat IDs remap. |
| Global grouped search | GPUI | Core command | **NV-13:** results remain contacts, groups, then messages; empty sections disappear and keyboard selection maps to real rows. |
| Open unknown contact from search | GPUI | Core command | **NV-14:** contact without local conversation opens exactly one conversation and later events use its returned opaque chat ID. |
| Exact message search jump | GPUI | Core commands | **NV-15:** selecting a hit loads around its ID, centers/highlights it, and supports older/newer continuation. |
| Debounce, stale-result suppression, clear | GPUI | UI required | **NV-16:** fast query changes cannot display an older response; clearing restores chat list/focus. |
| In-chat search next/previous | Missing | Missing | **NV-17:** search within the active chat, navigate all matches, and restore the prior viewport on close. |
| WhatsApp-style filters (All/Unread/Favorites/Groups) | Missing | Missing | **NV-18:** filters reflect persisted app state and live mutations, with virtual/paged correctness. |
| Start-new-chat/contact picker | Search can open contact | Partial | **NV-19:** dedicated flow lists/searches contacts and groups, creates/opens one opaque conversation, and is keyboard accessible. |

## Conversation rendering and live state

| Message behavior | GPUI baseline | Tauri state | Proof gate |
| --- | --- | --- | --- |
| Incoming/outgoing text bubbles | GPUI | Core data | **MS-01:** multiline, Unicode, bidi, long unbroken text, emoji, and max-length messages render without overflow. |
| Sender name/color in groups | GPUI | Backend data | **MS-02:** saved, push-name, business-name, phone-only, PN, and LID participants remain stable and distinct. |
| Timestamps and date separation | GPUI | UI required | **MS-03:** locale/day/DST/year boundaries are unambiguous and do not reorder messages. |
| Pending/sent/delivered/read/failed state | GPUI | Core response/events | **MS-04:** receipts advance monotonically; failure remains retryable and cannot masquerade as sent. |
| Native reply preview and navigation | GPUI | Core data | **MS-05:** compose/send/display quoted target; missing target degrades safely; clicking preview jumps or fetches around target. |
| Reply count and “view replies” jump | GPUI | Core data | **MS-06:** multiple replies update live, deletion/replay does not double count, and first-reply navigation is exact. |
| Mentions rendered/resolved | GPUI | Core data | **MS-07:** outgoing encoded JIDs and incoming mentions display names while preserving copyable text and notification semantics. |
| Linkification and safe external open | GPUI | Core opener permission | **MS-08:** only validated http/https URLs open; punctuation, IDN, malformed schemes, and untrusted message text cannot invoke Tauri. |
| Link preview presentation | GPUI local presentation | UI required | **MS-09:** preview cannot make network requests to attacker-controlled URLs without an explicit privacy-reviewed backend path. |
| Reactions chips and reactor details | GPUI | Core command/events | **MS-10:** add/change/remove, optimistic races, retries, historical repair, counts, and sender identity converge. |
| Typing and recording indicators | GPUI | Core command/event | **MS-11:** direct/group concurrent indicators expire, composing refreshes at the correct cadence, and stop on send/switch/blur. |
| Chat/message live upsert | GPUI | Core event | **MS-12:** incoming message creates/reorders chat and appears once; updates do not reset scroll or discard hydrated media paths. |
| Chat identity merge event | GPUI | Core event | **MS-13:** list/order/selection/messages/draft/search caches remap atomically from old to new chat ID. |
| Image thumbnail and full viewer | GPUI | Core command + asset protocol | **MS-14:** only visible rows download; thumbnail survives replay; viewer loads full image; retry/error and cache restart are correct. |
| Sticker rendering | GPUI | Core data | **MS-15:** static/animated WebP aspect ratio, transparency, bounded dimensions, retry, and cache behavior pass. |
| Typed unsupported placeholders | Backend/GPUI | Core data | **MS-16:** every known non-rendered type remains a descriptive bubble rather than disappearing. |
| Edited indicator/content replacement | Backend has some edit reduction; UI incomplete | Missing | **MS-17:** real edit updates content once, preserves identity/replies/reactions, and shows edit state. |
| Deleted/revoked message state | Backend parses protocol types partially | Missing | **MS-18:** delete-for-everyone and delete-for-me semantics match the linked device and survive replay. |
| Forwarded/frequently forwarded labels | Missing | Missing | **MS-19:** incoming metadata renders correctly and outgoing forward preserves supported context. |
| Starred messages | Missing | Missing | **MS-20:** star/unstar app-state sync, starred browser, exact jump, and multi-device persistence. |
| Disappearing/view-once media behavior | Timer visible in info only | Missing | **MS-21:** expiry/view rules are enforced by backend and UI without leaking cached content after expiry. |
| Selection/copy/message context menu | Missing | Missing | **MS-22:** keyboard/mouse menu exposes only valid actions and copy preserves plain text safely. |

## Composer and outgoing actions

| User action | GPUI baseline | Tauri state | Proof gate |
| --- | --- | --- | --- |
| Text compose, validation, send | GPUI | Core command | **CP-01:** Enter/Shift-Enter, blank/oversize validation, Unicode, offline failure, idempotent retry, and restored draft pass. |
| Reply compose/cancel | GPUI | Core command | **CP-02:** capture target before async work; switching chats cannot send reply to the wrong conversation. |
| Group mention picker | GPUI | Core chat-info command | **CP-03:** `@` filtering, keyboard/mouse selection, duplicate display names, deleted token, and exact JIDs pass. |
| Emoji picker/search/categories/tones | GPUI | UI required | **CP-04:** complete supported catalog, skin tones, focus return, reaction/composer modes, and keyboard access pass. |
| Send image with caption | GPUI | Core command/dialog | **CP-05:** picker cancellation, type/size/caption validation, upload progress/failure, reply capture, and native image message pass. |
| Send native sticker | GPUI | Core command/dialog | **CP-06:** off-thread conversion, static/animated constraints, wrong-chat race, timeout, and backend validation pass. |
| Send/remove reaction | GPUI | Core command | **CP-07:** latest intent wins across rapid choices; retry uses stable action ID and stale responses cannot revert UI. |
| Mark read through exact message | GPUI | Core command | **CP-08:** optimistic unread rollback on failure and group receipt context are correct. |
| Paste/drag-drop image | Missing | Missing | **CP-09:** clipboard/drop validation enters the same preview/send path without granting broad filesystem access. |
| Document attachment | Backend/Core/UI path | Implemented; proof pending | **CP-10:** upload, filename/MIME/size, caption, download/open/save, retry, history persistence, and registered typed Tauri calls. |
| Video/GIF attachment and playback | Backend/Core/UI path | UI loops downloaded GIF-playback media inline and falls back to the OS player on codec failure; proof pending | **CP-11:** transcoding/thumbnail/duration, range playback, codec fallback, caption, bounded cache, and registered typed Tauri calls. |
| Audio file and voice-note recording | Stored-attachment path; no recorder | Partial; recorder missing | **CP-12:** microphone permission, waveform/duration, cancel/lock/pause, upload, playback speed, seeking, background behavior, and registered typed Tauri calls. |
| Contact and location message | Placeholder only | Missing | **CP-13:** render and send structured contact/location with safe external actions and privacy review. |
| Poll create/vote/results | Placeholder only | Core/UI: single/multi-select creation, encrypted full-state voting/retraction, live totals, durable replay, and stale-intent rollback | **CP-14:** single/multi-select, encrypted vote updates, retraction, live totals, and history replay. |
| Edit sent message | Missing | Missing | **CP-15:** eligibility window, optimistic edit, rejection rollback, edit event, and multi-device convergence. |
| Delete for me/everyone | Missing | Missing | **CP-16:** eligibility/admin rules, confirmation, persistence, media-cache cleanup, and remote revoke result. |
| Forward/share messages | Missing | Missing | **CP-17:** multi-select targets, forwarded metadata, media reuse/reupload, partial failure, and no wrong-chat sends. |
| Retry failed outgoing message | Partial idempotency, no complete UI | Missing | **CP-18:** stable client ID prevents duplicates across timeout/restart and UI clearly exposes terminal versus retryable failure. |
| Text formatting and spellcheck | Missing | Missing | **CP-19:** WhatsApp formatting semantics, platform spellcheck, shortcuts, paste, and literal-character escapes. |

## Chat and contact information

| Surface/action | GPUI baseline | Tauri state | Proof gate |
| --- | --- | --- | --- |
| Direct-chat identity/about/phone | GPUI | Core command | **IN-01:** saved/unsaved/business/PN/LID identities display without leaking raw internal IDs unnecessarily. |
| Group title/about/creation date | GPUI | Core command | **IN-02:** loading/error/retry, empty metadata, and live metadata changes pass. |
| Participant list and avatars | GPUI | Core commands | **IN-03:** large group is scrollable/virtualized; roles/names/phones/avatars and privacy-denied images are correct. |
| Disappearing timer display | GPUI | Core data | **IN-04:** off and supported durations render human-readable values. |
| Set disappearing timer | Missing | Missing | **IN-05:** supported durations update remote/app state and emit system-state change. |
| Archive/unarchive action | Read-only archived view | Missing | **IN-06:** mutation persists across devices and moves row between views without losing the active conversation. |
| Pin/unpin action | Sorts existing pinned state | Core/UI: admin-aware mutation, durable ordered pinned browser, unavailable-target fallback, exact navigation | **IN-07:** app-state limits/errors and ordering persist across restart. |
| Mute/unmute action | Displays backend field indirectly | Missing | **IN-08:** duration/forever semantics drive notification suppression and app-state sync. |
| Clear/delete chat | Missing | Missing | **IN-09:** explicit confirmation, remote/local semantics, message/media cleanup, and selected-chat fallback pass. |
| Block/unblock/report | Missing | Missing | **IN-10:** privacy state, reporting confirmation, transport errors, and composer availability update correctly. |
| Create group | Missing | Missing | **IN-11:** contact selection, title/icon, creation failure/partial state, and resulting chat event. |
| Group participant/admin management | Read-only participants | Missing | **IN-12:** add/remove/promote/demote permissions, pending approval, errors, and group events. |
| Edit group title/about/icon | Read-only | Missing | **IN-13:** admin checks, upload/update, cache invalidation, and event convergence. |
| Invite link/join/leave group | Missing | Missing | **IN-14:** create/reset/copy/QR/join/leave flows and destructive confirmation. |
| Communities | Missing | Missing | **IN-15:** parent/announcement/member groups, navigation, permissions, and app-state lifecycle. |

## Broader WhatsApp Desktop surfaces

These rows are part of literal “WhatsApp Desktop parity”; they cannot be
silently excluded when declaring the migration complete.

| Surface | Current support | Required proof or decision |
| --- | --- | --- |
| Status/updates viewing and posting | Missing | **WA-01:** audience/privacy, text/media status, view receipts, expiry, mute, and history behavior. |
| Channels/newsletters | Missing | **WA-02:** directory/subscription, live updates, reactions, mute, admin/posting, and notification behavior. |
| One-to-one voice/video calls | **Upstream gap** | **WA-03:** whatsmeow currently lists calls as unimplemented. Implement a separately reviewed call stack or record an explicit product-scope exception; do not label it full parity. |
| Group calls/call links/call history | **Upstream gap** | **WA-04:** signaling, WebRTC media, permissions, devices, ringing, reconnect, history, and security review. |
| Communities and announcements | Missing | **WA-05:** full parent/child lifecycle and permissions, not merely chat rendering. |
| Business/catalog/order surfaces | Incoming placeholders only | **WA-06:** define private-client scope or implement safe catalog/order rendering and actions. |
| Broadcast lists | Upstream/WhatsApp Web limitations | **WA-07:** document upstream support and desktop comparison explicitly. |
| Multiple linked profiles | Missing | **WA-08:** implement isolation/switching or explicitly constrain the product to one linked account. |

## Desktop integration, accessibility, and security

| Requirement | GPUI baseline | Tauri state | Proof gate |
| --- | --- | --- | --- |
| Native open-file dialog | GPUI native picker | Core/plugin permission | **DS-01:** image/sticker filters and cancellation work on all OSes; arbitrary paths cannot bypass command validation. |
| Safe external URL opener | GPUI validation | Core/plugin permission | **DS-02:** allow only reviewed schemes; custom protocols, local files, credentials, and malformed URLs are rejected. |
| Desktop notifications | Missing | Core/UI: permission, foreground/mute suppression, privacy previews, grouping, and exact-message action routing; platform proof pending | **DS-03:** OS permission, foreground suppression, muted chats, privacy preview setting, click-to-open exact chat/message, and grouping. |
| App/tray badge and background mode | Missing | Missing | **DS-04:** unread aggregate, hide/quit distinction, startup behavior, and sidecar lifetime match settings. |
| Window geometry persistence | Missing/limited | Missing | **DS-05:** position/size/maximized state restore safely across monitor/DPI changes without off-screen launch. |
| Single-instance focus/deep-link routing | Missing | Missing | **DS-06:** second launch and notification/deep link focus the running window and route once. |
| Signed auto-update | Missing | Missing | **DS-07:** check/download/signature/install/relaunch, progress/error, sidecar stop, and rollback/mixed-version protection. |
| Light/dark/system theme | GPUI light/dark toggle | UI required | **DS-08:** system default/change plus explicit override persist and maintain contrast. |
| UI scale/zoom | GPUI persisted scale | UI required | **DS-09:** keyboard/menu controls, clamp/reset/persist, layout at each step, and no blurry media. |
| Keyboard navigation and shortcuts | GPUI partial | UI required | **DS-10:** complete keyboard map for sidebar, search, message list, composer, menus, modal focus trap, and Escape behavior. |
| Screen reader semantics | Not proven | Missing proof | **DS-11:** labels/roles/live regions/order/state on NVDA, VoiceOver, and Orca; no virtualized focus loss. |
| Contrast, focus, reduced motion, high DPI | Not proven | Missing proof | **DS-12:** WCAG AA contrast, visible focus, OS reduced-motion behavior, 125–300% scaling, and touch targets. |
| RTL/bidi/localization/time formats | Partial message bidi | Missing proof | **DS-13:** Arabic/Hebrew mixed content, locale strings, 12/24-hour time, pluralization, and layout direction. |
| CSP and local-only frontend | N/A native | Configured, proof pending | **DS-14:** release CSP has no remote/CDN/script escape; message content cannot execute JS or invoke unintended commands. |
| Least-privilege capabilities | N/A native | Partial | **DS-15:** main local window only; explicit app commands; no frontend shell/database; plugin permissions limited to exact operations. |
| Managed media/avatar asset scope | N/A native | Rust scope/escape tests pass; target proof pending | **DS-16:** attempts to load DB, log, config, nested avatar, symlink-escape, and arbitrary temp/home files fail; cached media, thumbnails, and direct managed avatars succeed. |
| Secrets excluded from webview/logs | GPUI boundary | Architecture invariant | **DS-17:** inspect IPC/devtools/logs/crash output; session keys, media keys, tokens, and private paths are absent unless strictly required. |
| Code signing/notarization | Missing | Missing | **DS-18:** verify app, sidecar, installers, notarization/timestamp, and clean-machine launch on each platform. |

## Performance and size contract

### Measured GPUI baseline

The following Linux x86-64 release artifacts were measured in the source
checkout on 2026-07-22:

| Artifact | Uncompressed | gzip -9 reference |
| --- | ---: | ---: |
| GPUI `rust-meow-desktop` | 33,284,240 bytes (31.74 MiB) | 13,085,247 bytes (12.48 MiB) |
| Go `rust-meow-backend` | 22,036,642 bytes (21.02 MiB) | 7,773,886 bytes (7.41 MiB) |
| Combined executable payload | 55,320,882 bytes (52.76 MiB) | 20,859,133 bytes (19.89 MiB) |

The current Linux x86-64 Tauri release and `.deb` were measured from the
integration worktree on 2026-07-22. AppImage and non-Linux formats remain
unmeasured. The final `.deb` SHA-256 is
`f69724eb32eef434a7df2cf47d340d1797eacc61ef2e1c99369455ff0b48b7cd`;
the built JavaScript and CSS total 61,418 bytes with per-file gzip -9.

### Initial Tauri acceptance targets

Targets are budgets, not evidence. Record measurements for every target/format
in the evidence table below.

- Tauri Rust executable plus bundled frontend assets: **at most 8 MiB**
  unpacked on Linux x86-64.
- Go sidecar: do not exceed the measured **22,036,642-byte** baseline without a
  reviewed reason. The current attachment-enabled, media-bounded,
  profile-locked, secure-logout sidecar is 192,512 bytes (0.87%) above that
  baseline and requires explicit acceptance.
- Combined unpacked executable payload: **at most 32 MiB**, a material reduction
  from 52.76 MiB.
- Built frontend JavaScript plus CSS: **at most 500 KiB gzip**; emoji/media-heavy
  features should be lazy-loaded.
- Fake-backend cold start to usable 10,000-chat UI: **p95 below 1.0 s** on the
  recorded reference machine.
- Cached chat switch to first painted message rows: **p95 below 100 ms**.
- Backend event receipt to visible incoming row: **p95 below 100 ms**, excluding
  WhatsApp network delivery.
- Thirty-second continuous scroll: **p95 frame time below 16.7 ms** and less
  than **1%** frames above 33.3 ms.
- After a 30-second quiescent period: combined app idle CPU **below 1% of one
  core** and combined RSS **below 200 MiB** on the reference Linux machine.
- The DOM stays bounded while traversing 10,000 chats and the 2,000-message
  in-memory window; visible/overscan rows grow with the viewport, not dataset
  size.

AppImage is recorded separately. Tauri AppImage bundles can exceed 70 MiB
because they include runtime libraries, so `.deb`/`.rpm` are the primary Linux
size comparison and AppImage is a convenience artifact, not evidence that the
executable target was missed.

### Measurement evidence

| Date | Git commit | OS/arch | Artifact/format | Exact bytes | gzip/download bytes | Cold p95 | Idle RSS/CPU | Scroll result | Evidence link |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| 2026-07-22 | source baseline | Linux x86-64 | GPUI + Go executables | 55,320,882 | 20,859,133 | not recorded | not recorded | fake fixture existed; not recorded | local measurement above |
| 2026-07-22 | `49e70ef` | Linux x86-64 | Tauri executable + Go sidecar | 28,245,258 | 10,361,182 | pending | pending | pending | final build/unpack; prior adjacent-layout startup smoke |
| 2026-07-22 | `49e70ef` | Linux x86-64 | `.deb` | 10,673,232 | 10,673,232 download | pending | pending | pending | md5 manifest, ELF types, desktop entry, and launcher icons verified after unpacking |
| pending | pending | Linux x86-64 | AppImage | pending | pending | pending | pending | pending | pending |
| pending | pending | Windows x86-64 | NSIS/MSI | pending | pending | pending | pending | pending | pending |
| pending | pending | macOS arm64 | `.app`/DMG | pending | pending | pending | pending | pending | pending |

## Desktop redesign surfaces

These rows cover work introduced by the 2026-07-22 redesign
(`docs/UI_REDESIGN.md`). None of them existed in the GPUI client except where
noted, so "GPUI baseline" is mostly *N/A*: they are new product surface, not
migration parity. Nothing here is **Proven** — every row still needs desktop QA
on all three platforms.

| Requirement | GPUI baseline | Tauri state | Proof gate |
| --- | --- | --- | --- |
| Token-driven theming with user themes | GPUI light/dark only | UI | **RD-01:** every rule reads `var(--token)`; switching, editing, importing, exporting, and deleting a theme persists and repaints without reload; a malformed or hostile theme file is rejected by `normalizeTheme` and cannot inject CSS beyond a colour value. Supersedes **DS-08** only once system-preference following is implemented — it is not yet. |
| Custom window chrome (`decorations: false`) | N/A native | UI | **RD-02:** drag, double-click maximise, minimise/maximise/close, and all eight resize edges work on GNOME/KDE/Wayland/X11, Windows, and macOS; the window can still be resized and moved with no OS decorations; snap/tiling still functions. Regressing this makes the app unusable, so it gates release harder than most rows. |
| Tab strip and two-pane split | Missing | UI | **RD-03:** open/close/reorder/move tabs between panes; both panes receive live messages, receipts, reactions, and typing; drafts and unread counts stay per chat; the workspace restores after reload; closing the last tab of a pane behaves as specified. |
| Per-chat conversation state | Single active chat | UI | **RD-04:** two panes on two chats simultaneously never cross-contaminate messages, drafts, scroll position, or read receipts; conversation eviction bounds memory with ≥8 chats opened; `chatMerged` remaps every keyed structure. |
| `Ctrl+Tab` hold-to-cycle switcher | GPUI reference behaviour | UI | **RD-05:** matches `desktop/src/main.rs` — overlay opens on first press, further presses only move the highlight, Ctrl release commits, Escape cancels, window blur cancels rather than commits, and it works when opened from a focused text input. |
| Docked group member list | Missing | UI | **RD-06:** opens by default for groups, role grouping and counts are correct, a 1000-member group neither janks nor issues 1000 avatar fetches, and it stays consistent with participant changes. |
| Sender avatars in group messages | GPUI shows sender name only | UI | **RD-07:** avatars appear for incoming group messages, group consecutively within 5 minutes, and the virtualiser's height estimate keeps scroll anchored while they hydrate asynchronously. |
| Arbitrary emoji reactions | GPUI quick set | UI | **RD-08:** full categorised picker with working keyword search and persisted recents; picking, replacing, and removing a reaction round-trips through the backend; the popover is never clipped by the scroller. |
| Sticker library from local history | GPUI sticker send only | UI, scope-limited | **RD-09:** stickers from chat history and app-state favourites list, render, and send without re-encoding. **Upstream gap:** WhatsApp does not sync the phone's installed sticker packs to linked devices, so a complete library is not obtainable. The UI must say so plainly rather than appear empty or broken. |
| Configurable save location | Missing | UI | **RD-10:** `save_media_as` refuses sources outside the managed media cache, reduces the requested name to one path component, never overwrites, and writes only inside the user-chosen directory; an empty setting falls back to the picker. |
| Compact density | Missing | UI, experimental | **RD-11:** message height estimates match rendered heights so the virtualiser does not drift; the setting persists; layout holds at every UI scale step. |
| Long-URL containment | Bug: overflowed the pane | UI | **RD-12:** an unbroken 500-character URL wraps inside the bubble, the pane never scrolls horizontally, and the truncated link text still opens the complete URL. |

## Required verification commands

Run from the repository root unless a command changes directory:

```sh
cd backend && go test ./...
cd ../desktop && cargo test --locked
cd ../tauri && pnpm install --frozen-lockfile
pnpm check
pnpm build
cd src-tauri && cargo test --locked
cargo clippy --all-targets --locked -- -D warnings
```

`make check` and `make test` cover the Go backend, frontend, and Tauri Rust core.
Run `make legacy-test` as the additional GPUI behavioral-reference gate.

Static checks must be followed by both fake and real-backend QA described in
`tauri/README.md`. For each manual gate, capture:

- commit and exact artifact hash;
- OS, architecture, WebView version, display scale, and hardware;
- fresh or copied profile, plus the test account/chat fixture;
- screen recording or screenshots for visual/scroll claims;
- relevant `backend.log`, console, crash, and process-lifecycle evidence;
- database integrity/count queries when persistence is part of the claim;
- exact binary, installer, CPU, RSS, latency, and frame measurements.

## Cutover gates

The GPUI desktop may stop being the default only when all of the following are
true:

1. **Build:** Go tests, GPUI regression tests, Tauri Rust tests/clippy, frontend
   typecheck/build, and protocol-generation drift checks pass from a clean
   checkout.
2. **Current-feature parity:** every GPUI row above is **Proven**, including
   failure paths, keyboard behavior, live events, and scroll anchoring.
3. **Profile safety:** a real paired copied profile upgrades without QR re-pair,
   passes SQLite integrity checks, and can still be opened by the documented
   rollback build if no schema change makes that unsafe.
4. **Lifecycle:** single-instance, graceful quit, forced reap, crash cleanup,
   restart/epoch/resync, sleep/resume, offline recovery, and update lifecycle
   pass on Linux, Windows, and macOS.
5. **Security:** explicit command/capability review, managed media/avatar asset access,
   production CSP, dependency audit, URL/path validation, secret/log review,
   signed binaries, and installer clean-machine tests pass.
6. **Performance:** every target in the evidence table has a current measured
   result or an explicitly accepted exception with rationale.
7. **Distribution:** each installer contains the correct Go sidecar, starts
   without development environment variables, completes Hello, updates both
   binaries atomically, and uninstalls without deleting user data unexpectedly.
8. **WhatsApp scope:** all missing Desktop surfaces are implemented, or the
   product has a clearly approved scope document that does not call itself
   “full feature parity.” The calls upstream gap must remain explicit.
