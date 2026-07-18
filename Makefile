.PHONY: check test build backend desktop release fake clean

check:
	cd backend && go test ./...
	cd desktop && cargo check --tests

test:
	cd backend && go test ./...
	cd desktop && cargo test

build: backend desktop

backend:
	mkdir -p build
	cd backend && go build -o ../build/rust-meow-backend ./cmd/rust-meow-backend

desktop: backend
	cd desktop && cargo build
	cp build/rust-meow-backend desktop/target/debug/rust-meow-backend

release:
	mkdir -p build desktop/target/release
	cd backend && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o ../build/rust-meow-backend ./cmd/rust-meow-backend
	cd desktop && cargo build --release --locked
	cp build/rust-meow-backend desktop/target/release/rust-meow-backend

fake:
	cd desktop && cargo run -- --fake-backend

clean:
	cd backend && go clean
	cd desktop && cargo clean
