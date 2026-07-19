# Rust Meow desktop

Run the deterministic UI/performance fixture:

```sh
cargo run -- --fake-backend
```

Run against the real Go sidecar by placing `rust-meow-backend` beside the
desktop binary or setting `RUST_MEOW_BACKEND=/absolute/path/to/rust-meow-backend`.
Application data defaults to the platform user-data directory and can be
redirected with `RUST_MEOW_DATA_DIR`.

The fake backend exposes 10,000 chats and paged variable-height messages. Set
`RUST_MEOW_FAKE_PAIRING=1` to exercise QR pairing.
