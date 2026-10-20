package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/logs"
)

func runUpstreamLogs(cmd *cobra.Command, args []string) error {
	serverName, err := resolveServerName(args, false)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Load configuration
	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading configuration: %v\n", err)
		return err
	}

	// Create logger
	logger, err := createUpstreamLogger(upstreamLogLevel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating logger: %v\n", err)
		return err
	}

	// Detect daemon (socket first, then TCP fallback)
	client, daemonOK := newDaemonClient(globalConfig, logger.Sugar())

	// Follow mode requires daemon
	if upstreamLogsFollow {
		if !daemonOK {
			return fmt.Errorf("--follow requires running daemon")
		}
		logger.Info("Following logs from daemon")
		// Use background context with signal handling for follow mode
		bgCtx, bgCancel := context.WithCancel(context.Background())
		defer bgCancel()

		// Handle Ctrl+C gracefully
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
		defer signal.Stop(sigChan)

		go func() {
			select {
			case <-sigChan:
				logger.Info("Received interrupt signal, stopping...")
				bgCancel()
			case <-bgCtx.Done():
				// Context canceled, exit goroutine
			}
		}()

		return runUpstreamLogsFollowMode(bgCtx, client, serverName, logger)
	}

	// Check if daemon is running
	if daemonOK {
		logger.Info("Detected running daemon, using client mode")
		return runUpstreamLogsClientMode(ctx, client, serverName)
	}

	// No daemon - read from log file
	logger.Info("No daemon detected, reading from log file")
	return runUpstreamLogsFromFile(globalConfig, serverName)
}

func runUpstreamLogsClientMode(ctx context.Context, client *cliclient.Client, serverName string) error {
	// Call GET /api/v1/servers/{name}/logs?tail=N
	logs, err := client.GetServerLogs(ctx, serverName, upstreamLogsTail)
	if err != nil {
		return fmt.Errorf("failed to get logs from daemon: %w", err)
	}

	for _, entry := range logs {
		fmt.Printf("%s [%s] %s\n", entry.Timestamp.Format("2006-01-02 15:04:05"), entry.Level, entry.Message)
	}

	return nil
}

func runUpstreamLogsFromFile(globalConfig *config.Config, serverName string) error {
	// Read from log file directly
	logDir := globalConfig.Logging.LogDir
	if logDir == "" {
		// Use OS-specific standard log directory
		var err error
		logDir, err = logs.GetLogDir()
		if err != nil {
			return fmt.Errorf("failed to determine log directory: %w", err)
		}
	}

	logFile := filepath.Join(logDir, logs.ServerLogFilename(serverName))

	// Defense-in-depth: logs.ServerLogFilename already sanitizes the (user-controlled)
	// server name to a single path element, but verify the resolved path stays inside
	// logDir before it reaches os.Stat/tail so a crafted name can never escape the log
	// directory (path-injection barrier).
	if !strings.HasPrefix(filepath.Clean(logFile), filepath.Clean(logDir)+string(os.PathSeparator)) {
		return fmt.Errorf("invalid server name: %s", serverName)
	}

	// Check if file exists
	if _, err := os.Stat(logFile); os.IsNotExist(err) {
		return fmt.Errorf("log file not found: %s (daemon may not have run yet)", logFile)
	}

	// Read last N lines using tail command
	cmd := exec.Command("tail", "-n", fmt.Sprintf("%d", upstreamLogsTail), logFile)
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to read log file: %w", err)
	}

	fmt.Print(string(output))
	return nil
}

func runUpstreamLogsFollowMode(ctx context.Context, client *cliclient.Client, serverName string, logger *zap.Logger) error {
	fmt.Printf("Following logs for server '%s' (Ctrl+C to stop)...\n", serverName)

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()

	// Ring buffer to track recently seen lines and prevent unbounded memory growth
	const maxTrackedLines = 1000
	lastLines := make(map[string]bool)
	lineOrder := make([]string, 0, maxTrackedLines)

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			logs, err := client.GetServerLogs(ctx, serverName, upstreamLogsTail)
			if err != nil {
				logger.Warn("Failed to fetch logs", zap.Error(err))
				continue
			}

			// Print only new lines
			for _, entry := range logs {
				// Format the log entry as a unique string for deduplication
				logLine := fmt.Sprintf("%s [%s] %s", entry.Timestamp.Format("2006-01-02 15:04:05"), entry.Level, entry.Message)

				if !lastLines[logLine] {
					fmt.Println(logLine)
					lastLines[logLine] = true
					lineOrder = append(lineOrder, logLine)

					// Implement ring buffer: remove oldest line if we exceed max
					if len(lineOrder) > maxTrackedLines {
						oldestLine := lineOrder[0]
						delete(lastLines, oldestLine)
						lineOrder = lineOrder[1:]
					}
				}
			}
		}
	}
}
