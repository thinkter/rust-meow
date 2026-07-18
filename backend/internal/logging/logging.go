package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
)

func New(path string) (*slog.Logger, io.Closer, error) {
	var writer io.Writer = os.Stderr
	var closer io.Closer
	if path != "" {
		file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return nil, nil, fmt.Errorf("open log file: %w", err)
		}
		writer = io.MultiWriter(os.Stderr, file)
		closer = file
	}
	return slog.New(slog.NewJSONHandler(writer, &slog.HandlerOptions{Level: slog.LevelInfo})), closer, nil
}
