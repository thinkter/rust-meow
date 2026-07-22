//go:build !linux && !darwin && !windows

package profilelock

import (
	"errors"
	"os"
)

func tryLock(*os.File) (bool, error) {
	return false, errors.New("profile locking is not supported on this platform")
}

func unlock(*os.File) error { return nil }
