// Package logging configures the global logrus logger from app config.
// File output uses lumberjack rotation; stdout is always enabled.
package logging

import (
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/sirupsen/logrus"
	"gopkg.in/natefinch/lumberjack.v2"
)

// Config tunes the logging setup.
type Config struct {
	Level         string
	FileEnabled   bool
	Dir           string
	RetentionDays int
}

// Setup applies the supplied config to the global logger and returns it.
func Setup(cfg Config) (*logrus.Logger, error) {
	logger := logrus.StandardLogger()

	level, err := logrus.ParseLevel(strings.TrimSpace(cfg.Level))
	if err != nil {
		level = logrus.InfoLevel
	}
	logger.SetLevel(level)
	logger.SetFormatter(&logrus.JSONFormatter{
		TimestampFormat: "2006-01-02T15:04:05.000Z07:00",
	})

	if cfg.FileEnabled && strings.TrimSpace(cfg.Dir) != "" {
		if err := os.MkdirAll(cfg.Dir, 0o750); err != nil {
			return nil, err
		}
		rotator := &lumberjack.Logger{
			Filename:   filepath.Join(cfg.Dir, "cpa-usage.log"),
			MaxSize:    50,
			MaxBackups: cfg.RetentionDays,
			MaxAge:     cfg.RetentionDays,
			Compress:   true,
		}
		logger.SetOutput(io.MultiWriter(os.Stdout, rotator))
	} else {
		logger.SetOutput(os.Stdout)
	}
	return logger, nil
}
