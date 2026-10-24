//go:build darwin || windows

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"

	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/cmd/mcpproxy-tray/internal/api"
	"github.com/smart-mcp-proxy/mcpproxy-go/cmd/mcpproxy-tray/internal/state"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/tray"
)

const (
	platformDarwin  = "darwin"
	platformWindows = "windows"
)

var (
	version          = "development" // Set by build flags
	defaultCoreURL   = "http://127.0.0.1:8080"
	errNoBundledCore = errors.New("no bundled core binary found")
	trayAPIKey       = ""                  // API key generated for core communication
	shutdownComplete = make(chan struct{}) // Signal when shutdown is complete
	shutdownOnce     sync.Once
)

// getLogDir returns the standard log directory for the current OS.
// Falls back to a temporary directory when a platform path cannot be resolved.
func getLogDir() string {
	fallback := filepath.Join(os.TempDir(), "mcpproxy", "logs")

	switch runtime.GOOS {
	case platformDarwin:
		if homeDir, err := os.UserHomeDir(); err == nil {
			return filepath.Join(homeDir, "Library", "Logs", "mcpproxy")
		}
	case platformWindows: // This case will never be reached due to build constraints, but kept for clarity
		if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
			return filepath.Join(localAppData, "mcpproxy", "logs")
		}
		if userProfile := os.Getenv("USERPROFILE"); userProfile != "" {
			return filepath.Join(userProfile, "AppData", "Local", "mcpproxy", "logs")
		}
	default: // linux and others
		if homeDir, err := os.UserHomeDir(); err == nil {
			return filepath.Join(homeDir, ".mcpproxy", "logs")
		}
	}

	return fallback
}

// generateAPIKey creates a cryptographically secure random API key
func generateAPIKey() string {
	bytes := make([]byte, 32) // 32 bytes = 256 bits
	if _, err := rand.Read(bytes); err != nil {
		// Fallback to less secure method if crypto/rand fails
		return fmt.Sprintf("tray_%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(bytes)
}

func main() {
	// Setup logging
	logger, err := setupLogging()
	if err != nil {
		log.Fatalf("Failed to setup logging: %v", err)
	}
	defer func() {
		if syncErr := logger.Sync(); syncErr != nil {
			logger.Error("Failed to sync logger", zap.Error(syncErr))
		}
	}()

	logger.Info("Starting mcpproxy-tray", zap.String("version", version))

	// Check environment variables for configuration
	coreTimeout := getCoreTimeout()
	retryDelay := getRetryDelay()
	stateDebug := getStateDebug()

	if stateDebug {
		logger.Info("State machine debug mode enabled")
	}

	logger.Info("Tray configuration",
		zap.Duration("core_timeout", coreTimeout),
		zap.Duration("retry_delay", retryDelay),
		zap.Bool("state_debug", stateDebug),
		zap.Bool("skip_core", shouldSkipCoreLaunch()))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Resolve core configuration up front
	coreURL := resolveCoreURL()
	logger.Info("Resolved core URL", zap.String("core_url", coreURL))

	// Determine if we're using socket/pipe communication (which doesn't need API key)
	usingSocketCommunication := isSocketEndpoint(coreURL)

	// Setup API key for secure communication between tray and core
	// Skip API key generation for socket/pipe connections as they're trusted by default
	if trayAPIKey == "" && !usingSocketCommunication {
		// Check environment variable first (for consistency with core behavior)
		if envAPIKey := os.Getenv("MCPPROXY_API_KEY"); envAPIKey != "" {
			trayAPIKey = envAPIKey
			logger.Info("Using API key from environment variable for tray-core communication",
				zap.String("api_key_source", "MCPPROXY_API_KEY environment variable"),
				zap.String("api_key_prefix", maskAPIKey(trayAPIKey)))
		} else {
			trayAPIKey = generateAPIKey()
			logger.Info("Generated API key for tray-core communication",
				zap.String("api_key_source", "auto-generated"),
				zap.String("api_key_prefix", maskAPIKey(trayAPIKey)))
		}
	} else if usingSocketCommunication {
		logger.Info("Using socket/pipe communication - API key not required",
			zap.String("connection_type", "socket"))
	}

	// Create state machine
	stateMachine := state.NewMachine(logger.Sugar())

	// Create enhanced API client with better connection management
	apiClient := api.NewClient(coreURL, logger.Sugar())
	apiClient.SetAPIKey(trayAPIKey)

	// Create launcher variable that will be set after tray app is created
	var launcher *CoreProcessLauncher
	var trayApp *tray.App

	// Create tray application early so icon appears
	shutdownFunc := func() {
		firstCaller := false
		shutdownOnce.Do(func() {
			firstCaller = true

			go func() {
				defer func() {
					if r := recover(); r != nil {
						logger.Error("Recovered from panic during shutdown", zap.Any("panic", r))
					}
					close(shutdownComplete)
				}()

				logger.Info("Tray shutdown requested")

				// Notify the state machine so it stops launching or reconnecting cores.
				stateMachine.SendEvent(state.EventShutdown)

				// Shutdown launcher FIRST (stops SSE, health monitor, kills core)
				// This must happen BEFORE cancelling context to prevent tray from quitting early
				if launcher != nil {
					logger.Info("Shutting down launcher...")
					launcher.handleShutdown()
					logger.Info("Launcher shutdown complete")
				}

				// Shutdown state machine (waits up to its internal timeout)
				logger.Info("Shutting down state machine...")
				stateMachine.Shutdown()
				logger.Info("State machine shutdown complete")

				// NOW cancel the context (this will trigger tray to quit via context monitor)
				logger.Info("Cancelling tray context")
				cancel()

				// Give tray.Run() goroutine a moment to notice cancellation before requesting explicit quit.
				time.Sleep(50 * time.Millisecond)

				// Finally, request the tray UI to quit (safe even if already quitting)
				if trayApp != nil {
					logger.Info("Quitting system tray")
					trayApp.Quit()
				}

				logger.Info("Shutdown sequence finished")
			}()
		})

		if !firstCaller {
			// Wait until the first shutdown completes so callers don't proceed early.
			<-shutdownComplete
		}
	}

	trayApp = tray.NewWithAPIClient(api.NewServerAdapter(apiClient), apiClient, logger.Sugar(), version, shutdownFunc)

	// Start the state machine (without automatic initial event)
	stateMachine.Start()

	// Launch core management with state machine
	launcher = NewCoreProcessLauncher(
		coreURL,
		logger.Sugar(),
		stateMachine,
		apiClient,
		trayApp,
		coreTimeout,
	)

	// Determine initial ownership strategy before dispatching events
	skipCoreEnv := shouldSkipCoreLaunch()
	coreAlreadyRunning := false
	if !skipCoreEnv {
		coreAlreadyRunning = isCoreAlreadyRunning(coreURL, logger)
	}

	initialOwnership := coreOwnershipTrayManaged
	initialEvent := state.EventStart

	if skipCoreEnv {
		logger.Info("Skipping core launch (MCPPROXY_TRAY_SKIP_CORE=1)")
		initialOwnership = coreOwnershipExternalUnmanaged
		initialEvent = state.EventSkipCore
	} else if coreAlreadyRunning {
		logger.Info("Detected existing running core, will use it instead of launching subprocess",
			zap.String("core_url", coreURL))
		initialOwnership = coreOwnershipExternalManaged
		initialEvent = state.EventSkipCore
	} else {
		logger.Info("No running core detected, will launch new core process")
	}

	launcher.SetCoreOwnership(initialOwnership)

	// Start launcher FIRST to ensure it subscribes to transitions before events are sent
	go launcher.Start(ctx)

	// Give the launcher goroutine a moment to subscribe to state transitions
	// This prevents race condition where initial event is sent before subscription is ready
	time.Sleep(10 * time.Millisecond)

	stateMachine.SendEvent(initialEvent)

	// Handle signals for graceful shutdown
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		logger.Info("Received shutdown signal")

		// Use the same shutdown flow as Quit menu item
		shutdownFunc()
	}()

	logger.Info("Starting tray event loop")
	if err := trayApp.Run(ctx); err != nil && err != context.Canceled {
		logger.Error("Tray application error", zap.Error(err))
	}

	// Wait for shutdown to complete (with timeout)
	select {
	case <-shutdownComplete:
		logger.Info("Shutdown completed successfully")
	case <-time.After(5 * time.Second):
		logger.Warn("Shutdown timeout - forcing exit")
	}

	// Final cleanup
	stateMachine.Shutdown()

	logger.Info("mcpproxy-tray shutdown complete")
}

// monitorDockerStatus polls the core API for Docker recovery status and shows notifications
func monitorDockerStatus(ctx context.Context, apiClient *api.Client, logger *zap.SugaredLogger) {
	logger.Info("Starting Docker status monitor")

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	var lastStatus *api.DockerStatus
	var lastRecoveryMode bool
	var lastFailureCount int

	// Initial poll
	status, err := apiClient.GetDockerStatus()
	if err != nil {
		logger.Debugw("Failed to get initial Docker status", "error", err)
	} else {
		lastStatus = status
		lastRecoveryMode = status.RecoveryMode
		lastFailureCount = status.FailureCount
	}

	for {
		select {
		case <-ctx.Done():
			logger.Info("Docker status monitor stopping")
			return
		case <-ticker.C:
			status, err := apiClient.GetDockerStatus()
			if err != nil {
				logger.Debugw("Failed to get Docker status", "error", err)
				continue
			}

			// Check for state changes and show appropriate notifications
			if lastStatus == nil {
				lastStatus = status
				lastRecoveryMode = status.RecoveryMode
				lastFailureCount = status.FailureCount
				continue
			}

			// Docker became unavailable (recovery mode started)
			if !lastRecoveryMode && status.RecoveryMode {
				logger.Info("Docker recovery started")
				if err := tray.ShowDockerRecoveryStarted(); err != nil {
					logger.Warnw("Failed to show Docker recovery notification", "error", err)
				}
			}

			// Docker recovery succeeded (was in recovery, now available)
			if lastRecoveryMode && !status.RecoveryMode && status.DockerAvailable {
				logger.Info("Docker recovery completed successfully")
				if err := tray.ShowDockerRecoverySuccess(0); err != nil {
					logger.Warnw("Failed to show Docker recovery success notification", "error", err)
				}
			}

			// Retry attempt detected (failure count increased while in recovery)
			if status.RecoveryMode && status.FailureCount > lastFailureCount {
				logger.Infow("Docker recovery retry attempt",
					"attempt", status.FailureCount,
					"last_error", status.LastError)
				// Intentionally no tray notification to avoid spam; log only.
			}

			// Recovery failed (exceeded max retries or persistent error)
			if lastRecoveryMode && !status.RecoveryMode && !status.DockerAvailable {
				logger.Warnw("Docker recovery failed", "last_error", status.LastError)
				if err := tray.ShowDockerRecoveryFailed(status.LastError); err != nil {
					logger.Warnw("Failed to show Docker recovery failed notification", "error", err)
				}
			}

			lastStatus = status
			lastRecoveryMode = status.RecoveryMode
			lastFailureCount = status.FailureCount
		}
	}
}
