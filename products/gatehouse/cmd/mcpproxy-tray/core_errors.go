//go:build darwin || windows

package main

import (
	"net"
	"net/url"
	"strconv"
	"time"

	"github.com/smart-mcp-proxy/mcpproxy-go/cmd/mcpproxy-tray/internal/state"
)

// handlePortConflictError handles port conflict errors
func (cpl *CoreProcessLauncher) handlePortConflictError() {
	cpl.logger.Warn("Core failed due to port conflict")
	// Attempt automatic port resolution on Windows/macOS
	// 1) Parse current coreURL and extract port
	u, err := url.Parse(cpl.coreURL)
	if err != nil {
		cpl.logger.Error("Failed to parse coreURL for port conflict handling", "core_url", cpl.coreURL, "error", err)
		return
	}
	portStr := u.Port()
	if portStr == "" {
		portStr = "8080"
	}
	baseHost := u.Hostname()
	if baseHost == "" {
		baseHost = "127.0.0.1"
	}
	// 2) Find next available port
	startPort, _ := strconv.Atoi(portStr)
	newPort, err := findNextAvailablePort(startPort+1, startPort+50)
	if err != nil {
		cpl.logger.Error("Failed to find available port after conflict", "start_port", startPort, "error", err)
		return
	}
	// 3) Update coreURL and restart flow
	u.Host = net.JoinHostPort(baseHost, strconv.Itoa(newPort))
	cpl.coreURL = u.String()
	cpl.logger.Info("Auto-selected alternate port after conflict", "new_core_url", cpl.coreURL)

	// Stop monitors so they can be recreated with new URL
	if cpl.healthMonitor != nil {
		cpl.healthMonitor.Stop()
		cpl.healthMonitor = nil
	}
	if cpl.processMonitor != nil {
		cpl.processMonitor.Shutdown()
		cpl.processMonitor = nil
	}
	// Trigger retry which will launch core with updated args based on coreURL
	cpl.stateMachine.SendEvent(state.EventRetry)
}

// handleDBLockedError handles database locked errors
func (cpl *CoreProcessLauncher) handleDBLockedError() {
	cpl.logger.Warn("Core failed due to database lock")
	// Could implement automatic stale lock cleanup here
}

// handleConfigError handles configuration errors
func (cpl *CoreProcessLauncher) handleConfigError() {
	cpl.logger.Error("Core failed due to configuration error")
	// Configuration errors are usually not recoverable without user intervention
}

// handleGeneralError handles general errors with retry logic
func (cpl *CoreProcessLauncher) handleGeneralError() {
	currentState := cpl.stateMachine.GetCurrentState()
	cpl.logger.Error("Core failed with general error", "state", currentState)

	// Check if we should retry
	if cpl.stateMachine.ShouldRetry(currentState) {
		retryCount := cpl.stateMachine.GetRetryCount(currentState)
		retryDelay := cpl.stateMachine.GetRetryDelay(currentState)

		cpl.logger.Info("Will retry after delay",
			"state", currentState,
			"retry_attempt", retryCount+1,
			"delay", retryDelay)

		// Wait for retry delay
		time.Sleep(retryDelay)

		// Send retry event
		cpl.stateMachine.SendEvent(state.EventRetry)
	} else {
		cpl.logger.Error("Max retries exceeded, giving up", "state", currentState)
	}
}
