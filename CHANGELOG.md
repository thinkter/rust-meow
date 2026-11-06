# Changelog

Rust Meow follows [Semantic Versioning](https://semver.org/). Product releases
are tagged as `vMAJOR.MINOR.PATCH`; transport protocol and database schema
versions are tracked separately in `docs/VERSIONING.md`.

## Unreleased

- Expanded the emoji picker and reactions to the full Unicode catalog, with
  native color-emoji font preference where available.
- Fixed Linux GIF playback so animated GIFs render inline instead of falling
  back to generic attachment cards.
- Stabilized message scrolling while new messages arrive and older history is
  prepended.
- Removed the redundant per-conversation “Connected” status label.
- File-send confirmation now focuses Send so Enter confirms pasted images.

## [0.2.0] - 2026-08-09

### Added

- Experimental WhatsApp Agent Control with trusted chats, workspace grants,
  approvals, audit history, and a default-off gate nested under Advanced
  settings.
- Locally persisted edit/deletion history with a separate default-off recovery
  display setting and clear edited/deleted indicators.

### Fixed

- Outgoing image messages now send small interoperable wire thumbnails while
  retaining a higher-quality local preview.
- Agent Control is disabled in the backend before its experimental UI is
  hidden.
- Animated GIF images and WhatsApp GIF videos now play inline; Linux playback
  uses bounded blob URLs to avoid WebKitGTK local-media protocol failures.
- Sticker-only messages no longer render standard bubble chrome.

[0.2.0]: https://github.com/thinkter/rust-meow/releases/tag/v0.2.0
