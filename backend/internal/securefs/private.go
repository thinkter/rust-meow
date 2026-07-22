package securefs

import (
	"fmt"
	"os"
)

const (
	privateDirectoryMode os.FileMode = 0o700
	privateFileMode      os.FileMode = 0o600
)

// EnsurePrivateDirectory creates path when needed and also repairs permissions
// on an existing directory. MkdirAll deliberately does not change an existing
// directory, which matters for explicit data-directory overrides.
func EnsurePrivateDirectory(path string) error {
	if err := os.MkdirAll(path, privateDirectoryMode); err != nil {
		return fmt.Errorf("create private directory: %w", err)
	}
	if err := os.Chmod(path, privateDirectoryMode); err != nil {
		return fmt.Errorf("restrict private directory: %w", err)
	}
	return nil
}

// EnsurePrivateFile creates an empty file when needed and repairs the mode of
// an existing file before a database or logger opens it.
func EnsurePrivateFile(path string) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, privateFileMode)
	if err != nil {
		return fmt.Errorf("open private file: %w", err)
	}
	chmodErr := file.Chmod(privateFileMode)
	closeErr := file.Close()
	if chmodErr != nil {
		return fmt.Errorf("restrict private file: %w", chmodErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close private file: %w", closeErr)
	}
	return nil
}

// RestrictFileIfPresent repairs SQLite sidecars left by an older build without
// creating empty WAL/SHM files, which SQLite would interpret as malformed.
func RestrictFileIfPresent(path string) error {
	if err := os.Chmod(path, privateFileMode); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("restrict existing private file: %w", err)
	}
	return nil
}

// RestrictOpenFile applies the private-file mode to an already-open log file.
func RestrictOpenFile(file *os.File) error {
	if err := file.Chmod(privateFileMode); err != nil {
		return fmt.Errorf("restrict open private file: %w", err)
	}
	return nil
}
