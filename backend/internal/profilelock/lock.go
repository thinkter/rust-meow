package profilelock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/rust-meow/rust-meow/backend/internal/securefs"
)

var ErrAlreadyLocked = errors.New("Rust Meow profile is already in use")

// Lock owns the operating-system advisory lock for one backend data directory.
type Lock struct {
	mu     sync.Mutex
	file   *os.File
	closed bool
}

// Acquire prevents two backend processes (including different desktop shells)
// from opening the same WhatsApp session and product databases concurrently.
// The on-disk file may safely outlive the process: ownership is represented by
// the OS lock, not by the file's existence.
func Acquire(dataDir string) (*Lock, error) {
	path := filepath.Join(dataDir, ".profile.lock")
	if err := securefs.EnsurePrivateFile(path); err != nil {
		return nil, fmt.Errorf("prepare profile lock: %w", err)
	}
	file, err := os.OpenFile(path, os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open profile lock: %w", err)
	}
	acquired, err := tryLock(file)
	if err != nil {
		file.Close()
		return nil, fmt.Errorf("lock Rust Meow profile: %w", err)
	}
	if !acquired {
		file.Close()
		return nil, fmt.Errorf("%w: %s", ErrAlreadyLocked, dataDir)
	}
	return &Lock{file: file}, nil
}

// Close releases the advisory lock. It is safe to call more than once.
func (lock *Lock) Close() error {
	lock.mu.Lock()
	defer lock.mu.Unlock()
	if lock.closed {
		return nil
	}
	lock.closed = true
	return errors.Join(unlock(lock.file), lock.file.Close())
}
