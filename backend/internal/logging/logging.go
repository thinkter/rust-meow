package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"

	signallogger "go.mau.fi/libsignal/logger"

	"github.com/rust-meow/rust-meow/backend/internal/securefs"
)

// signalLogger adapts libsignal's package-global logger to slog. libsignal's
// default logger prints to stdout, which is the framed protobuf channel in
// --stdio mode, so a single decryption warning would corrupt the bridge.
type signalLogger struct{ log *slog.Logger }

func (l signalLogger) Debug(caller, message string) {
	l.log.Debug(message, "caller", caller)
}

func (l signalLogger) Info(caller, message string) {
	l.log.Info(message, "caller", caller)
}

func (l signalLogger) Warning(caller, message string) {
	l.log.Warn(message, "caller", caller)
}

func (l signalLogger) Error(caller, message string) {
	l.log.Error(message, "caller", caller)
}

func (signalLogger) Configure(string) {}

// InstallSignalLogger routes libsignal's process-global logger through log so
// protocol diagnostics never reach the stdio bridge's framed output.
func InstallSignalLogger(log *slog.Logger) {
	// libsignal's Setup takes a pointer to an interface value, then stores the
	// value itself, so the interface must live in an addressable variable.
	var adapter signallogger.Loggable = signalLogger{log: log}
	signallogger.Setup(&adapter)
}

func New(path string) (*slog.Logger, io.Closer, error) {
	var writer io.Writer = os.Stderr
	var closer io.Closer
	if path != "" {
		file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, nil, fmt.Errorf("open log file: %w", err)
		}
		if err = securefs.RestrictOpenFile(file); err != nil {
			file.Close()
			return nil, nil, fmt.Errorf("secure log file: %w", err)
		}
		writer = io.MultiWriter(os.Stderr, file)
		closer = file
	}
	return slog.New(slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: slog.LevelInfo})), closer, nil
}
