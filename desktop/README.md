# Rust Meow desktop

## Release profile

The checked-in release profile uses thin LTO, one codegen unit, and symbol
stripping. On Linux x86-64 with Rust 1.88, the desktop executable measured
48,071,728 bytes before tuning and 33,073,168 bytes afterward (31.2% smaller).
Re-run `cargo build --release` and record the result when changing these
settings; binary size alone is not a reason to use `panic = "abort"`, which
would remove unwinding and reduce crash diagnostics.

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
