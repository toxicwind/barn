//go:build darwin || windows

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/cmd/mcpproxy-tray/internal/api"
	"github.com/smart-mcp-proxy/mcpproxy-go/cmd/mcpproxy-tray/internal/monitor"
	"github.com/smart-mcp-proxy/mcpproxy-go/cmd/mcpproxy-tray/internal/state"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/tray"
)

type coreOwnershipMode int

const (
	coreOwnershipTrayManaged coreOwnershipMode = iota
	coreOwnershipExternalManaged
	coreOwnershipExternalUnmanaged
)

// CoreProcessLauncher manages the mcpproxy core process with state machine integration
type CoreProcessLauncher struct {
	coreURL      string
	logger       *zap.SugaredLogger
	stateMachine *state.Machine
	apiClient    *api.Client
	trayApp      *tray.App
	coreTimeout  time.Duration

	processMonitor *monitor.ProcessMonitor
	healthMonitor  *monitor.HealthMonitor

	coreOwnership coreOwnershipMode
}

// NewCoreProcessLauncher creates a new core process launcher
func NewCoreProcessLauncher(
	coreURL string,
	logger *zap.SugaredLogger,
	stateMachine *state.Machine,
	apiClient *api.Client,
	trayApp *tray.App,
	coreTimeout time.Duration,
) *CoreProcessLauncher {
	return &CoreProcessLauncher{
		coreURL:       coreURL,
		logger:        logger,
		stateMachine:  stateMachine,
		apiClient:     apiClient,
		trayApp:       trayApp,
		coreTimeout:   coreTimeout,
		coreOwnership: coreOwnershipTrayManaged,
	}
}

// SetCoreOwnership configures how the tray should treat the core lifecycle
func (cpl *CoreProcessLauncher) SetCoreOwnership(mode coreOwnershipMode) {
	cpl.coreOwnership = mode
	switch mode {
	case coreOwnershipTrayManaged:
		cpl.logger.Debug("Tray managing core lifecycle directly")
	case coreOwnershipExternalManaged:
		cpl.logger.Debug("Tray attached to existing core - will manage shutdown")
	case coreOwnershipExternalUnmanaged:
		cpl.logger.Debug("Tray configured to skip core management - will not terminate core on exit")
	}
}

// Start starts the core process launcher and state machine integration
func (cpl *CoreProcessLauncher) Start(ctx context.Context) {
	cpl.logger.Info("Core process launcher starting")

	// Subscribe to state machine transitions
	transitionsCh := cpl.stateMachine.Subscribe()

	// Handle state transitions
	go cpl.handleStateTransitions(ctx, transitionsCh)

	// The initial event (EventStart or EventSkipCore) is now sent from main.go
	// based on the shouldSkipCoreLaunch() check, so we just wait for state transitions
}

// handleStateTransitions processes state machine transitions
func (cpl *CoreProcessLauncher) handleStateTransitions(ctx context.Context, transitionsCh <-chan state.Transition) {
	for {
		select {
		case <-ctx.Done():
			cpl.logger.Debug("State transition handler context cancelled")
			return

		case transition := <-transitionsCh:
			cpl.logger.Infow("State transition",
				"from", transition.From,
				"to", transition.To,
				"event", transition.Event,
				"timestamp", transition.Timestamp.Format(time.RFC3339))

			// Update tray connection state based on machine state
			cpl.updateTrayConnectionState(transition.To)

			// Handle specific state entries
			switch transition.To {
			case state.StateLaunchingCore:
				go cpl.safeHandleLaunchCore(ctx)

			case state.StateWaitingForCore:
				go cpl.safeHandleWaitForCore(ctx)

			case state.StateConnectingAPI:
				go cpl.safeHandleConnectAPI(ctx)

			case state.StateConnected:
				cpl.handleConnected()

			case state.StateReconnecting:
				go cpl.safeHandleReconnecting(ctx)

			case state.StateCoreErrorPortConflict:
				cpl.handlePortConflictError()

			case state.StateCoreErrorDBLocked:
				cpl.handleDBLockedError()

			case state.StateCoreErrorDocker:
				// Docker errors are handled by the core, not the tray
				// The tray should monitor Docker status via API, not block on it
				cpl.logger.Warn("Core reported Docker error - this should be handled by core, not tray")

			case state.StateCoreRecoveringDocker:
				// Docker recovery is handled by the core, not the tray
				cpl.logger.Info("Core recovering from Docker issues")

			case state.StateCoreErrorConfig:
				cpl.handleConfigError()

			case state.StateCoreErrorGeneral:
				cpl.handleGeneralError()

			case state.StateShuttingDown:
				// handleShutdown() is called directly in shutdownFunc and signal handler
				// to ensure it executes before context cancellation kills the goroutines.
				// No action needed here.
			}
		}
	}
}

// updateTrayConnectionState updates the tray app's connection state based on the state machine state
func (cpl *CoreProcessLauncher) updateTrayConnectionState(machineState state.State) {
	var trayState tray.ConnectionState

	switch machineState {
	case state.StateInitializing:
		trayState = tray.ConnectionStateInitializing
	case state.StateLaunchingCore:
		trayState = tray.ConnectionStateStartingCore
	case state.StateWaitingForCore:
		trayState = tray.ConnectionStateStartingCore
	case state.StateConnectingAPI:
		trayState = tray.ConnectionStateConnecting
	case state.StateConnected:
		trayState = tray.ConnectionStateConnected
	case state.StateReconnecting:
		trayState = tray.ConnectionStateReconnecting
	// ADD: Map specific error states to detailed tray states
	case state.StateCoreErrorPortConflict:
		trayState = tray.ConnectionStateErrorPortConflict
	case state.StateCoreErrorDBLocked:
		trayState = tray.ConnectionStateErrorDBLocked
	case state.StateCoreErrorDocker:
		trayState = tray.ConnectionStateErrorDocker
	case state.StateCoreRecoveringDocker:
		trayState = tray.ConnectionStateRecoveringDocker
	case state.StateCoreErrorConfig:
		trayState = tray.ConnectionStateErrorConfig
	case state.StateCoreErrorGeneral:
		trayState = tray.ConnectionStateErrorGeneral
	case state.StateFailed:
		trayState = tray.ConnectionStateFailed
	default:
		trayState = tray.ConnectionStateDisconnected
	}

	cpl.trayApp.SetConnectionState(trayState)
}

// safeHandleLaunchCore wraps handleLaunchCore with panic recovery
func (cpl *CoreProcessLauncher) safeHandleLaunchCore(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			err := fmt.Errorf("panic in handleLaunchCore: %v", r)
			cpl.logger.Error("PANIC recovered in handleLaunchCore", "panic", r, "error", err)
			cpl.stateMachine.SetError(err)
			cpl.stateMachine.SendEvent(state.EventGeneralError)
		}
	}()
	cpl.handleLaunchCore(ctx)
}

// safeHandleWaitForCore wraps handleWaitForCore with panic recovery
func (cpl *CoreProcessLauncher) safeHandleWaitForCore(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			err := fmt.Errorf("panic in handleWaitForCore: %v", r)
			cpl.logger.Error("PANIC recovered in handleWaitForCore", "panic", r, "error", err)
			cpl.stateMachine.SetError(err)
			cpl.stateMachine.SendEvent(state.EventGeneralError)
		}
	}()
	cpl.handleWaitForCore(ctx)
}

// safeHandleConnectAPI wraps handleConnectAPI with panic recovery
func (cpl *CoreProcessLauncher) safeHandleConnectAPI(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			err := fmt.Errorf("panic in handleConnectAPI: %v", r)
			cpl.logger.Error("PANIC recovered in handleConnectAPI", "panic", r, "error", err)
			cpl.stateMachine.SetError(err)
			cpl.stateMachine.SendEvent(state.EventConnectionLost)
		}
	}()
	cpl.handleConnectAPI(ctx)
}

// safeHandleReconnecting wraps handleReconnecting with panic recovery
func (cpl *CoreProcessLauncher) safeHandleReconnecting(ctx context.Context) {
	defer func() {
		if r := recover(); r != nil {
			err := fmt.Errorf("panic in handleReconnecting: %v", r)
			cpl.logger.Error("PANIC recovered in handleReconnecting", "panic", r, "error", err)
			cpl.stateMachine.SetError(err)
			cpl.stateMachine.SendEvent(state.EventConnectionLost)
		}
	}()
	cpl.handleReconnecting(ctx)
}

// handleLaunchCore handles launching the core process
func (cpl *CoreProcessLauncher) handleLaunchCore(ctx context.Context) {
	cpl.logger.Info("Launching mcpproxy core process")

	// NOTE: We do NOT check Docker availability here - that's the core's responsibility!
	// The core will handle Docker isolation gracefully and fall back to direct execution.
	// The tray should not block core launch based on Docker status.

	// Stop existing process monitor if running
	if cpl.processMonitor != nil {
		cpl.processMonitor.Shutdown()
		cpl.processMonitor = nil
	}

	// Resolve core binary path
	coreBinary, err := resolveCoreBinary(cpl.logger.Desugar())
	if err != nil {
		cpl.logger.Error("Failed to resolve core binary", "error", err)
		cpl.stateMachine.SetError(err)
		cpl.stateMachine.SendEvent(state.EventGeneralError)
		return
	}

	// Build command arguments and environment
	args := buildCoreArgs(cpl.coreURL)
	env := cpl.buildCoreEnvironment()

	launchBinary := coreBinary
	launchArgs := args
	wrappedWithShell := false

	if shellBinary, shellArgs, err := wrapCoreLaunchWithShell(coreBinary, args); err != nil {
		cpl.logger.Warn("Falling back to direct core launch", "error", err)
	} else {
		launchBinary = shellBinary
		launchArgs = shellArgs
		wrappedWithShell = true
	}

	cpl.logger.Info("Starting core process",
		"binary", launchBinary,
		"args", cpl.maskSensitiveArgs(launchArgs),
		"env_count", len(env),
		"wrapped_with_shell", wrappedWithShell)

	if wrappedWithShell {
		cpl.logger.Debug("Wrapped core command",
			"core_binary", coreBinary,
			"core_args", cpl.maskSensitiveArgs(args))
	}

	// Create process configuration
	// Note: CaptureOutput is false because core logs to its own files
	// Tray only monitors exit codes for failure detection
	processConfig := monitor.ProcessConfig{
		Binary:        launchBinary,
		Args:          launchArgs,
		Env:           env,
		StartTimeout:  cpl.coreTimeout,
		CaptureOutput: false,
	}

	// Create process monitor
	cpl.processMonitor = monitor.NewProcessMonitor(&processConfig, cpl.logger, cpl.stateMachine)

	// Start the process
	if err := cpl.processMonitor.Start(); err != nil {
		cpl.logger.Error("Failed to start core process", "error", err)
		cpl.stateMachine.SetError(err)
		cpl.stateMachine.SendEvent(state.EventGeneralError)
		return
	}

	// The process monitor will send EventCoreStarted when the process starts successfully
}

// handleWaitForCore handles waiting for the core to become ready
func (cpl *CoreProcessLauncher) handleWaitForCore(_ context.Context) {
	cpl.logger.Info("Waiting for core to become ready")

	// Create health monitor if not exists
	if cpl.healthMonitor == nil {
		cpl.healthMonitor = monitor.NewHealthMonitor(cpl.coreURL, cpl.logger, cpl.stateMachine)
		cpl.healthMonitor.Start()
	}

	// Wait for core to become ready
	go func() {
		if err := cpl.healthMonitor.WaitForReady(); err != nil {
			cpl.logger.Error("Core failed to become ready", "error", err)
			cpl.stateMachine.SetError(err)
			cpl.stateMachine.SendEvent(state.EventTimeout)
		}
		// If successful, the health monitor will send EventCoreReady
	}()
}

// handleConnectAPI handles connecting to the core API
func (cpl *CoreProcessLauncher) handleConnectAPI(ctx context.Context) {
	cpl.logger.Info("Connecting to core API")

	// First, do a quick readiness check to verify the API is reachable
	// This provides instant feedback to the user
	if err := cpl.verifyAPIReadiness(ctx); err != nil {
		cpl.logger.Error("API readiness check failed", "error", err)
		cpl.stateMachine.SetError(err)
		cpl.stateMachine.SendEvent(state.EventConnectionLost)
		return
	}

	// API is ready! Send EventAPIConnected immediately for fast status update
	cpl.logger.Info("API is ready, transitioning to connected state")
	cpl.stateMachine.SendEvent(state.EventAPIConnected)

	// Start SSE connection in background for real-time updates
	if err := cpl.apiClient.StartSSE(ctx); err != nil {
		cpl.logger.Error("Failed to start SSE connection", "error", err)
		// Don't send EventConnectionLost here - we're already connected via HTTP
		// Just log the error and SSE will retry in the background
	}

	// Start Docker status monitor in background
	go monitorDockerStatus(ctx, cpl.apiClient, cpl.logger)

	// Subscribe to API client connection state changes
	// Pass alreadyConnected=true since we verified API is ready via HTTP
	// This tells the monitor to ignore SSE connection failures
	go cpl.monitorAPIConnection(ctx, true)
}

// verifyAPIReadiness does a quick check to verify the core API is responding
func (cpl *CoreProcessLauncher) verifyAPIReadiness(ctx context.Context) error {
	// Try up to 3 times with short delays
	for attempt := 1; attempt <= 3; attempt++ {
		// Simple GET /ready check
		err := cpl.apiClient.GetReady(ctx)
		if err == nil {
			cpl.logger.Infow("API readiness verified", "attempt", attempt)
			return nil
		}

		cpl.logger.Warn("API readiness check failed",
			"attempt", attempt,
			"error", err)

		if attempt < 3 {
			// Short delay before retry
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(500 * time.Millisecond):
				// Continue to next attempt
			}
		}
	}

	return fmt.Errorf("API not ready after 3 attempts")
}

// monitorAPIConnection monitors the API client connection state
// When alreadyConnected is true, this only monitors for successful SSE connections
// and ignores connection failures (since we're already connected via HTTP)
func (cpl *CoreProcessLauncher) monitorAPIConnection(ctx context.Context, alreadyConnected bool) {
	connectionStateCh := cpl.apiClient.ConnectionStateChannel()

	for {
		select {
		case <-ctx.Done():
			return
		case connState, ok := <-connectionStateCh:
			if !ok {
				return
			}
			switch connState {
			case tray.ConnectionStateConnected:
				// SSE connection established successfully
				// If we weren't already connected, send EventAPIConnected now
				if !alreadyConnected {
					cpl.stateMachine.SendEvent(state.EventAPIConnected)
				}
			case tray.ConnectionStateReconnecting, tray.ConnectionStateDisconnected:
				// SSE connection lost or reconnecting
				// Only send EventConnectionLost if we were relying on SSE for connection
				// If we're already connected via HTTP, ignore SSE failures
				if !alreadyConnected {
					cpl.stateMachine.SendEvent(state.EventConnectionLost)
				}
			}
		}
	}
}

// handleConnected handles the connected state
func (cpl *CoreProcessLauncher) handleConnected() {
	cpl.logger.Info("Core process fully connected and operational")

	// Docker reconnection is handled by the core's own recovery logic
	// The tray just monitors status via the Docker status API endpoint
}

// handleReconnecting handles reconnection attempts
func (cpl *CoreProcessLauncher) handleReconnecting(_ context.Context) {
	cpl.logger.Info("Attempting to reconnect to core")
	// The state machine will handle retry logic automatically
}

// findNextAvailablePort scans a range and returns the first free port on localhost
func findNextAvailablePort(start, end int) (int, error) {
	if start < 1 {
		start = 1
	}
	if end <= start {
		end = start + 50
	}
	for p := start; p <= end; p++ {
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
		if err == nil {
			_ = ln.Close()
			return p, nil
		}
	}
	return 0, fmt.Errorf("no free port in range %d-%d", start, end)
}

// handleShutdown handles graceful shutdown and waits for core termination
func (cpl *CoreProcessLauncher) handleShutdown() {
	cpl.logger.Infow("Core process launcher shutting down",
		"monitor_present", cpl.processMonitor != nil,
		"api_client_present", cpl.apiClient != nil,
		"core_ownership", cpl.coreOwnership)

	// CRITICAL: Disable menu sync FIRST to prevent API calls after shutdown
	// This prevents the menu sync from trying to fetch servers after core is killed
	if cpl.trayApp != nil {
		cpl.logger.Info("Disabling menu synchronization")
		cpl.trayApp.SetConnectionState(tray.ConnectionStateDisconnected)
	}

	// Stop SSE connection before killing core
	// This prevents SSE from detecting disconnection and trying to reconnect
	if cpl.apiClient != nil {
		cpl.logger.Info("Stopping SSE connection (enter)")

		sseDone := make(chan struct{})
		sseStarted := time.Now()
		go func() {
			cpl.apiClient.StopSSE()
			close(sseDone)
		}()

		select {
		case <-sseDone:
			cpl.logger.Infow("SSE connection stopped", "duration", time.Since(sseStarted))
		case <-time.After(5 * time.Second):
			cpl.logger.Warn("SSE stop timed out, continuing with shutdown")
		}
	} else {
		cpl.logger.Debug("API client unavailable, skipping SSE shutdown")
	}

	// Stop health monitor before killing core
	if cpl.healthMonitor != nil {
		cpl.logger.Info("Stopping health monitor")
		cpl.healthMonitor.Stop()
	}

	// Finally, kill the core process and WAIT for it to terminate
	if cpl.processMonitor != nil {
		pid := cpl.processMonitor.GetPID()
		cpl.logger.Infow("Shutting down core process - waiting for termination...",
			"pid", pid,
			"status", cpl.processMonitor.GetStatus())

		// NEW: Create timeout for core shutdown (30 seconds total)
		shutdownTimeout := time.After(30 * time.Second)
		shutdownDone := make(chan struct{})
		shutdownStarted := time.Now()

		go func() {
			cpl.processMonitor.Shutdown() // This already has 10s SIGTERM + SIGKILL logic
			close(shutdownDone)
		}()

		// NEW: Wait for shutdown with timeout
		select {
		case <-shutdownDone:
			cpl.logger.Infow("Core process terminated successfully", "duration", time.Since(shutdownStarted))
		case <-shutdownTimeout:
			cpl.logger.Error("Core shutdown timeout exceeded - forcing kill")
			// Attempt force kill as last resort
			cpl.forceKillCore()
		}

		// NEW: Verify core is actually dead
		if cpl.processMonitor.GetStatus() == monitor.ProcessStatusRunning {
			cpl.logger.Error("Core process still running after shutdown - emergency kill")
			cpl.forceKillCore()
			time.Sleep(1 * time.Second) // Give it a moment to die
		}
	} else if shouldTerminateCore(cpl.coreOwnership) {
		cpl.logger.Warn("Process monitor unavailable during shutdown - attempting emergency core termination")
		if err := cpl.shutdownExternalCoreFallback(); err != nil {
			cpl.logger.Error("Emergency core shutdown failed", zap.Error(err))
		}
	} else {
		cpl.logger.Info("Core was not started by the tray - leaving it running")
	}

	if shouldTerminateCore(cpl.coreOwnership) {
		if err := cpl.ensureCoreTermination(); err != nil {
			cpl.logger.Error("Final core termination verification failed", zap.Error(err))
		}
	}

	cpl.logger.Info("Core shutdown complete")
}

// lookupExternalCorePID retrieves the core PID from the status API.
func (cpl *CoreProcessLauncher) lookupExternalCorePID() (int, error) {
	if cpl.apiClient == nil {
		return 0, fmt.Errorf("api client not available")
	}

	status, err := cpl.apiClient.GetStatus()
	if err != nil {
		return 0, fmt.Errorf("failed to query core status: %w", err)
	}

	rawPID, ok := status["process_pid"]
	if !ok {
		return 0, fmt.Errorf("status payload missing process_pid field")
	}

	switch value := rawPID.(type) {
	case float64:
		return int(value), nil
	case int:
		return value, nil
	case int64:
		return int(value), nil
	case json.Number:
		parsed, parseErr := strconv.Atoi(value.String())
		if parseErr != nil {
			return 0, fmt.Errorf("failed to parse process_pid: %w", parseErr)
		}
		return parsed, nil
	case string:
		parsed, parseErr := strconv.Atoi(value)
		if parseErr != nil {
			return 0, fmt.Errorf("failed to parse process_pid string: %w", parseErr)
		}
		return parsed, nil
	default:
		return 0, fmt.Errorf("unsupported process_pid type %T", rawPID)
	}
}

// collectCorePIDs gathers candidate PIDs from the monitor and status API.
func (cpl *CoreProcessLauncher) collectCorePIDs() map[int]struct{} {
	pids := make(map[int]struct{})

	if cpl.processMonitor != nil {
		if pid := cpl.processMonitor.GetPID(); pid > 0 {
			pids[pid] = struct{}{}
			cpl.logger.Infow("Collected PID from process monitor",
				"pid", pid,
				"monitor_status", cpl.processMonitor.GetStatus())
		}
	}

	if pid, err := cpl.lookupExternalCorePID(); err == nil && pid > 0 {
		pids[pid] = struct{}{}
		cpl.logger.Infow("Collected PID from status API", "pid", pid)
	} else if err != nil {
		cpl.logger.Debug("Failed to obtain core PID from status API", zap.Error(err))
	}

	return pids
}

// findCorePIDsViaPgrep falls back to scanning the process list for lingering cores.
func (cpl *CoreProcessLauncher) findCorePIDsViaPgrep() ([]int, error) {
	cmd := exec.Command("pgrep", "-f", "mcpproxy serve")
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	raw := strings.TrimSpace(string(output))
	if raw == "" {
		return nil, nil
	}

	lines := strings.Split(raw, "\n")
	pids := make([]int, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		pid, err := strconv.Atoi(line)
		if err != nil {
			cpl.logger.Debug("Ignoring invalid PID from pgrep", zap.String("value", line), zap.Error(err))
			continue
		}
		if pid > 0 {
			pids = append(pids, pid)
		}
	}

	return pids, nil
}

// buildCoreEnvironment builds the environment for the core process
func (cpl *CoreProcessLauncher) buildCoreEnvironment() []string {
	env := os.Environ()

	// Filter out any existing MCPPROXY_API_KEY to avoid conflicts
	filtered := make([]string, 0, len(env))
	for _, envVar := range env {
		if !strings.HasPrefix(envVar, "MCPPROXY_API_KEY=") {
			filtered = append(filtered, envVar)
		}
	}

	// Add our environment variables
	filtered = append(filtered,
		"MCPPROXY_ENABLE_TRAY=false",
		fmt.Sprintf("MCPPROXY_API_KEY=%s", trayAPIKey))

	// Tell the core it was launched by the tray, so telemetry's launch_source
	// can say so. Without this a tray-spawned core is unclassifiable: its parent
	// is the tray (not launchd, so not login_item) and it has no TTY (so not
	// cli), leaving launch_source "unknown".
	//
	// The installer launches the tray with MCPPROXY_LAUNCHED_BY=installer and
	// the core inherits it through os.Environ() above; that first-run
	// attribution outranks "tray", so we must not overwrite it.
	if strings.TrimSpace(os.Getenv("MCPPROXY_LAUNCHED_BY")) != "installer" {
		filtered = append(filtered, "MCPPROXY_LAUNCHED_BY=tray")
	}

	// Pass through TLS configuration if set
	if tlsEnabled := strings.TrimSpace(os.Getenv("MCPPROXY_TLS_ENABLED")); tlsEnabled != "" {
		filtered = append(filtered, fmt.Sprintf("MCPPROXY_TLS_ENABLED=%s", tlsEnabled))
	}

	return filtered
}

// maskSensitiveArgs masks sensitive command line arguments
func (cpl *CoreProcessLauncher) maskSensitiveArgs(args []string) []string {
	masked := make([]string, len(args))
	copy(masked, args)

	for i, arg := range masked {
		if strings.Contains(strings.ToLower(arg), "key") ||
			strings.Contains(strings.ToLower(arg), "secret") ||
			strings.Contains(strings.ToLower(arg), "token") ||
			strings.Contains(strings.ToLower(arg), "password") {
			masked[i] = maskAPIKey(arg)
		}
	}

	return masked
}
