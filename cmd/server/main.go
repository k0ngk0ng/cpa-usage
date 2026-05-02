package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/k0ngk0ng/cpa-usage/internal/app"
	"github.com/k0ngk0ng/cpa-usage/internal/config"
)

var (
	Version   = "dev"
	Commit    = ""
	BuildDate = ""
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	a, err := app.New(cfg, app.BuildInfo{Version: Version, Commit: Commit, BuildDate: BuildDate})
	if err != nil {
		log.Fatalf("init app: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	if err := a.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Printf("run: %v", err)
		_ = a.Close()
		os.Exit(1)
	}
	_ = a.Close()
}
