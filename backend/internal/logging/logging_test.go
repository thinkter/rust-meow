package logging

import (
	"bytes"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	signallogger "go.mau.fi/libsignal/logger"
)

func TestInstallSignalLoggerRoutesToSlog(t *testing.T) {
	var buf bytes.Buffer
	InstallSignalLogger(slog.New(slog.NewJSONHandler(&buf, nil)))
	t.Cleanup(func() {
		InstallSignalLogger(slog.New(slog.NewTextHandler(io.Discard, nil)))
	})

	signallogger.Error("Unable to verify ciphertext mac: mismatching MAC in signal message")

	line := buf.String()
	if !strings.Contains(line, `"level":"ERROR"`) {
		t.Fatalf("libsignal log missing error level: %q", line)
	}
	if !strings.Contains(line, "Unable to verify ciphertext mac") {
		t.Fatalf("libsignal log missing message: %q", line)
	}
	if !strings.Contains(line, `"caller":`) {
		t.Fatalf("libsignal log missing caller: %q", line)
	}
}

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
