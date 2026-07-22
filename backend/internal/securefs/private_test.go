package securefs

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func requireMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("Windows permissions are enforced by the user-profile ACL")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("mode for %s = %04o, want %04o", path, got, want)
	}
}

func TestEnsurePrivateDirectoryRepairsExistingMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "profile")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateDirectory(path); err != nil {
		t.Fatal(err)
	}
	requireMode(t, path, 0o700)
}

func TestEnsurePrivateFileCreatesAndRepairsMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.db")
	if err := os.WriteFile(path, []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsurePrivateFile(path); err != nil {
		t.Fatal(err)
	}
	requireMode(t, path, 0o600)
}

func TestRestrictFileIfPresentRepairsModeWithoutCreatingMissingSidecar(t *testing.T) {
	path := filepath.Join(t.TempDir(), "client.db-wal")
	if err := RestrictFileIfPresent(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("missing SQLite sidecar was created: %v", err)
	}
	if err := os.WriteFile(path, []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RestrictFileIfPresent(path); err != nil {
		t.Fatal(err)
	}
	requireMode(t, path, 0o600)
}
