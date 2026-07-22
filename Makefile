SHELL := /bin/sh

.DEFAULT_GOAL := help

TAURI_DIR := tauri
TAURI_CRATE_DIR := $(TAURI_DIR)/src-tauri
BUILD_DIR := build
BACKEND_BIN := $(abspath $(BUILD_DIR)/rust-meow-backend)
TAURI_RELEASE_DIR := $(TAURI_CRATE_DIR)/target/release

HOST_OS := $(shell uname -s)
HOST_ARCH := $(shell uname -m)

ifeq ($(HOST_ARCH),x86_64)
LINUX_TARGET ?= x86_64-unknown-linux-gnu
LINUX_GOARCH ?= amd64
else ifneq ($(filter aarch64 arm64,$(HOST_ARCH)),)
LINUX_TARGET ?= aarch64-unknown-linux-gnu
LINUX_GOARCH ?= arm64
else
LINUX_TARGET ?= unsupported
LINUX_GOARCH ?= unsupported
endif

LINUX_SIDECAR := $(TAURI_CRATE_DIR)/binaries/rust-meow-backend-$(LINUX_TARGET)
LINUX_BUNDLE_DIR := $(TAURI_CRATE_DIR)/target/$(LINUX_TARGET)/release/bundle/deb

.PHONY: help deps check test build desktop backend backend-release frontend-build tauri-check \
	tauri-test tauri-build dev dev-real dev-fake fake guard-linux \
	sidecar-linux release release-linux legacy-check legacy-test legacy-build \
	legacy-release clean

.PHONY: perf-test perf-linux perf-linux-normal perf-linux-battery

help:
	@echo "Rust Meow (Tauri primary desktop)"
	@echo "  make dev-fake       Run the deterministic 10,000-chat UI"
	@echo "  make dev            Build and run against the real Go backend"
	@echo "  make check          Go vet/tests, TypeScript, and warning-free Rust lint"
	@echo "  make test           Go, production frontend, and Tauri Rust tests"
	@echo "  make build          Unbundled size-optimized Tauri release"
	@echo "  make release-linux  Native Linux .deb with bundled Go sidecar"
	@echo "  make legacy-test    Test the GPUI behavioral reference"
	@echo "  make perf-linux     Capture the Linux normal-mode budget report"
	@echo "  make perf-linux-battery  Capture while a battery host is discharging"

deps:
	pnpm --dir $(TAURI_DIR) install --frozen-lockfile

check: backend-check tauri-check

.PHONY: backend-check
backend-check:
	cd backend && go test ./...
	cd backend && go vet ./...

tauri-check: deps
	pnpm --dir $(TAURI_DIR) check
	cd $(TAURI_CRATE_DIR) && cargo clippy --all-targets --locked -- -D warnings

test: backend-test tauri-test

.PHONY: backend-test
backend-test:
	cd backend && go test ./...

tauri-test: deps
	pnpm --dir $(TAURI_DIR) test
	pnpm --dir $(TAURI_DIR) perf:test
	pnpm --dir $(TAURI_DIR) build
	cd $(TAURI_CRATE_DIR) && cargo test --locked

perf-test: deps
	pnpm --dir $(TAURI_DIR) perf:test

perf-linux: perf-linux-normal

perf-linux-normal: guard-linux build
	pnpm --dir $(TAURI_DIR) perf:renderer -- --mode normal --output ../perf-results/renderer-normal.json
	node scripts/perf/collect.mjs --mode normal --renderer perf-results/renderer-normal.json --output perf-results/linux-normal.json

perf-linux-battery: guard-linux build
	node scripts/perf/power.mjs --require-battery
	pnpm --dir $(TAURI_DIR) perf:renderer -- --mode battery --output ../perf-results/renderer-battery.json
	node scripts/perf/collect.mjs --mode battery --renderer perf-results/renderer-battery.json --output perf-results/linux-battery.json

backend:
	mkdir -p $(BUILD_DIR)
	cd backend && go build -o ../$(BUILD_DIR)/rust-meow-backend ./cmd/rust-meow-backend

backend-release:
	mkdir -p $(BUILD_DIR)
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../$(BUILD_DIR)/rust-meow-backend ./cmd/rust-meow-backend

frontend-build: deps
	pnpm --dir $(TAURI_DIR) build

build: tauri-build

desktop: tauri-build

tauri-build: deps backend-release
	pnpm --dir $(TAURI_DIR) tauri build --no-bundle
	cp $(BACKEND_BIN) $(TAURI_RELEASE_DIR)/rust-meow-backend

dev: dev-real

dev-real: deps backend
	RUST_MEOW_BACKEND=$(BACKEND_BIN) pnpm --dir $(TAURI_DIR) tauri dev

dev-fake: deps
	pnpm --dir $(TAURI_DIR) tauri dev -- -- --fake-backend

fake: dev-fake

guard-linux:
	@test "$(HOST_OS)" = "Linux" || { echo "release-linux requires a Linux host" >&2; exit 2; }
	@test "$(LINUX_TARGET)" != "unsupported" || { echo "unsupported Linux architecture: $(HOST_ARCH)" >&2; exit 2; }

sidecar-linux: guard-linux
	mkdir -p $(TAURI_CRATE_DIR)/binaries
	cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=$(LINUX_GOARCH) go build -trimpath -ldflags="-s -w" -o ../$(LINUX_SIDECAR) ./cmd/rust-meow-backend

release: release-linux

release-linux: check sidecar-linux
	pnpm --dir $(TAURI_DIR) tauri build --target $(LINUX_TARGET) --bundles deb --config src-tauri/tauri.bundle.conf.json
	@echo "Linux package: $(LINUX_BUNDLE_DIR)"

legacy-check:
	cd desktop && cargo check --tests --locked

legacy-test:
	cd desktop && cargo test --locked

legacy-build: backend
	cd desktop && cargo build --locked
	cp $(BACKEND_BIN) desktop/target/debug/rust-meow-backend

legacy-release: backend-release
	mkdir -p desktop/target/release
	cd desktop && cargo build --release --locked
	cp $(BACKEND_BIN) desktop/target/release/rust-meow-backend

clean:
	cd backend && go clean
	cd $(TAURI_CRATE_DIR) && cargo clean
