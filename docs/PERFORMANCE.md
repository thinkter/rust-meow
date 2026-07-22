# Performance budget runner

Rust Meow measures the release application against the budgets in
[`TAURI_PARITY.md`](TAURI_PARITY.md#performance-and-size-contract). The report
is JSON so a runner can upload it as an artifact and fail the release job when
`passed` is false.

## What is measured

The deterministic fixture contains 10,000 chats and a 2,000-message history.
Five fresh packaged Tauri processes record process-launch-to-usable, cached
chat switches, backend-event-to-visible-row latency, a 30-second continuous
scroll, and DOM row bounds in the platform's native WebView. The 1,000-member
group fixture also records mounted roster and avatar element bounds. The
collector records the release executable, Go sidecar and
gzip frontend sizes and hashes, then samples the native process tree after a
30-second quiescent period for idle CPU and RSS.

Every report includes the commit and dirty flag, capture time, OS release,
architecture, CPU, logical CPU count, memory, WebView, viewport, scale factor,
power-source evidence, fixture size, trials, raw samples, aggregate values and
the result of every budget. A missing metric fails its budget.

## Linux reference run

Install `pnpm`, Go, Rust, and the Tauri Linux prerequisites. Then run:

```sh
make perf-test
make perf-linux
```

The normal-mode report is `perf-results/linux-normal.json`. `make perf-linux`
builds the release artifacts before measuring and exits nonzero if a budget is
missed.

Battery capture is deliberately separate:

```sh
make perf-linux-battery
```

That target checks `/sys/class/power_supply` before launching the app and
refuses to label a result as battery mode unless a real battery reports
`Discharging`. Keep the display, scaling, WebView version and workload the same
as the normal run. A desktop or VM without a reported battery must publish no
battery baseline.

## macOS and Windows runners

Use stable, dedicated or self-hosted hardware for an authoritative comparison.
Shared hosted runners are useful for schema and regression smoke checks, but
their variable hardware and lack of a discharging battery make them unsuitable
as the recorded acceptance baseline.

On both platforms, install the platform's Tauri prerequisites, Node/pnpm, Go,
and Rust, then build the three inputs:

```sh
pnpm --dir tauri install --frozen-lockfile
pnpm --dir tauri build
go build -trimpath -ldflags="-s -w" -o build/rust-meow-backend ./backend/cmd/rust-meow-backend
cargo build --manifest-path tauri/src-tauri/Cargo.toml --release --locked
```

On Windows, use `rust-meow-backend.exe` for the Go output; the collector selects
`.exe` defaults automatically. Record the actual WebView version in the runner
environment because it cannot be inferred portably:

```sh
export RUST_MEOW_WEBVIEW_VERSION="WKWebView <OS build>"       # macOS
export RUST_MEOW_WEBVIEW_VERSION="WebView2 <runtime version>" # Windows
```

PowerShell uses `$env:RUST_MEOW_WEBVIEW_VERSION = "WebView2 ..."` instead.
Capture and collect normal mode with the packaged app's native WebView:

```sh
pnpm --dir tauri perf:renderer -- --mode normal --output ../perf-results/renderer-normal.json
node scripts/perf/collect.mjs --mode normal --renderer perf-results/renderer-normal.json --output perf-results/platform-normal.json
```

For a battery run, first disconnect external power and require positive power
evidence with `node scripts/perf/power.mjs --require-battery`; then repeat both
commands with `battery`. Upload the final JSON even when it fails a budget so
the exact regression remains inspectable. Never relabel a normal-mode or
unknown-power capture as a battery baseline.
