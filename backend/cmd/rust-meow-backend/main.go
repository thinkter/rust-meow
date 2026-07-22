package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/rust-meow/rust-meow/backend/internal/app"
	"github.com/rust-meow/rust-meow/backend/internal/bridge"
	"github.com/rust-meow/rust-meow/backend/internal/logging"
	"github.com/rust-meow/rust-meow/backend/internal/securefs"
	"github.com/rust-meow/rust-meow/backend/internal/store"
	"github.com/rust-meow/rust-meow/backend/internal/wa"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	var dataDir, logFile string
	var stdio bool
	flag.StringVar(&dataDir, "data-dir", "", "directory for session and client databases")
	flag.StringVar(&logFile, "log-file", "", "optional log path")
	flag.BoolVar(&stdio, "stdio", false, "serve framed protobuf over stdin/stdout")
	flag.Parse()
	if !stdio {
		return fmt.Errorf("--stdio is required")
	}
	if dataDir == "" {
		return fmt.Errorf("--data-dir is required")
	}
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return err
	}
	if err = securefs.EnsurePrivateDirectory(abs); err != nil {
		return err
	}
	log, closer, err := logging.New(logFile)
	if err != nil {
		return err
	}
	if closer != nil {
		defer closer.Close()
	}
	base, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancel(base)
	defer cancel()
	productStore, err := store.Open(ctx, filepath.Join(abs, "client.db"))
	if err != nil {
		return err
	}
	defer productStore.Close()
	codec := bridge.NewCodec(os.Stdin, os.Stdout)
	server := app.New(ctx, cancel, codec, productStore)
	client, err := wa.New(ctx, abs, productStore, server.Emit, log)
	if err != nil {
		return err
	}
	defer client.Close()
	server.SetWhatsApp(client)
	if client.IsPaired() {
		go func() {
			if err := client.Connect(); err != nil {
				log.Error("connect failed", "error", err)
			}
		}()
	}
	return server.Run()
}
