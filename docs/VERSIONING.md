# Versioning

Rust Meow uses Semantic Versioning for installable product releases. The
canonical product version is the single line in the repository-root `VERSION`
file. A release commit must keep every app/backend manifest aligned with it and
must be tagged `v<version>` after the full test suite passes.

## Current versions

| Version | Current | Changes when |
| --- | ---: | --- |
| Product release | 0.2.0 | User-visible features, fixes, or compatibility change |
| Desktop/backend bridge protocol | 22 | The protobuf RPC contract becomes incompatible |
| Local database schema | 20 | A persisted SQLite migration is added |

Protocol and schema numbers are deliberately not derived from the product
version. They only advance when their own compatibility boundary changes.

## Release checklist

1. Choose the next Semantic Versioning number and update `VERSION` plus
   `CHANGELOG.md`.
2. Update the product manifests and `backend/internal/productversion/version.go`.
3. Run `make version-check`, then `make check && make test`.
4. Commit, merge into `main`, and create the matching annotated `vX.Y.Z` tag.
5. Build and install from that exact tagged commit.

`make version-check` is also part of `make check`; it fails if a product
manifest or lockfile drifts from `VERSION`.
