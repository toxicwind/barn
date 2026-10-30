//go:build darwin || windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"time"

	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/logs"
)

// setupLogging configures the logger with appropriate settings for the tray
func setupLogging() (*zap.Logger, error) {
	return newTrayLogger(newTrayLogConfig(runtime.GOOS, getLogDir()))
}

func newTrayLogger(cfg *config.LogConfig) (*zap.Logger, error) {
	if cfg == nil {
		return nil, fmt.Errorf("tray log config is required")
	}

	writeSyncer, err := logs.CreateRotatingWriteSyncer(cfg)
	if err != nil {
		return nil, fmt.Errorf("failed to create rotating tray log sink: %w", err)
	}

	level := zap.InfoLevel
	cores := []zapcore.Core{
		zapcore.NewCore(newTrayJSONEncoder(), writeSyncer, level),
	}
	if cfg.EnableConsole {
		cores = append(cores, zapcore.NewCore(newTrayJSONEncoder(), zapcore.AddSync(os.Stdout), level))
	}

	core := zapcore.NewTee(cores...)
	core = zapcore.NewSamplerWithOptions(core, time.Second, 100, 100)
	core = logs.NewSecretSanitizer(core)

	return zap.New(
		core,
		zap.AddCaller(),
		zap.AddStacktrace(zap.ErrorLevel),
		zap.ErrorOutput(zapcore.AddSync(os.Stderr)),
	), nil
}

func newTrayLogConfig(goos, logDir string) *config.LogConfig {
	cfg := logs.DefaultLogConfig()
	cfg.Level = logs.LogLevelInfo
	cfg.EnableFile = true
	cfg.EnableConsole = goos != platformWindows
	cfg.Filename = "tray.log"
	cfg.LogDir = logDir
	cfg.JSONFormat = true
	return cfg
}

func newTrayJSONEncoder() zapcore.Encoder {
	return zapcore.NewJSONEncoder(zapcore.EncoderConfig{
		TimeKey:        "timestamp",
		LevelKey:       "level",
		NameKey:        "logger",
		CallerKey:      "caller",
		FunctionKey:    zapcore.OmitKey,
		MessageKey:     "message",
		StacktraceKey:  "stacktrace",
		LineEnding:     zapcore.DefaultLineEnding,
		EncodeLevel:    zapcore.LowercaseLevelEncoder,
		EncodeTime:     zapcore.ISO8601TimeEncoder,
		EncodeDuration: zapcore.StringDurationEncoder,
		EncodeCaller:   zapcore.ShortCallerEncoder,
		EncodeName:     zapcore.FullNameEncoder,
	})
}
