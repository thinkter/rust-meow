package logging

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNewRestrictsExistingLogFileMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows permissions are enforced by the user-profile ACL")
	}
	path := filepath.Join(t.TempDir(), "backend.log")
	if err := os.WriteFile(path, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	_, closer, err := New(path)
	if err != nil {
		t.Fatal(err)
	}
	defer closer.Close()

	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("log mode = %04o, want 0600", got)
	}
}
