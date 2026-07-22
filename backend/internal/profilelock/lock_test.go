package profilelock

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestAcquireIsExclusiveAndReleasesCleanly(t *testing.T) {
	directory := t.TempDir()
	first, err := Acquire(directory)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Acquire(directory)
	if second != nil {
		second.Close()
		t.Fatal("second process acquired an already locked profile")
	}
	if !errors.Is(err, ErrAlreadyLocked) {
		t.Fatalf("second acquire error = %v, want ErrAlreadyLocked", err)
	}
	if err = first.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Acquire(directory)
	if err != nil {
		t.Fatalf("reacquire after release: %v", err)
	}
	if err = reopened.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAcquireTreatsStaleFileAsUnlockedAndRestrictsItsMode(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, ".profile.lock")
	if err := os.WriteFile(path, []byte("stale metadata is not ownership"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	lock, err := Acquire(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("lock file mode = %04o, want 0600", got)
	}
}
