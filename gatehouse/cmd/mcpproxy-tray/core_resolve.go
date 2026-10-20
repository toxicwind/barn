//go:build darwin || windows

package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/socket"
)

func resolveCoreURL() string {
	// Priority 1: Explicit override via environment variable
	if override := strings.TrimSpace(os.Getenv("MCPPROXY_CORE_URL")); override != "" {
		return override
	}

	// Priority 2: Try socket/pipe communication first (preferred for local tray-core communication)
	// This provides better security (no API key needed) and performance
	// Note: We return the socket path even if it doesn't exist yet, because:
	//   - When launching core: Core will create the socket
	//   - When connecting: isCoreAlreadyRunning() will check existence and fall back if needed
	socketPath := socket.DetectSocketPath("") // Empty dataDir uses default ~/.mcpproxy
	if socketPath != "" {
		return socketPath
	}

	// Priority 3: Fall back to TCP (HTTP/HTTPS)
	// Determine protocol based on TLS setting
	protocol := "http"
	if strings.TrimSpace(os.Getenv("MCPPROXY_TLS_ENABLED")) == "true" {
		protocol = "https"
	}

	if listen := normalizeListen(strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_LISTEN"))); listen != "" {
		return protocol + "://127.0.0.1" + listen
	}

	if port := strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_PORT")); port != "" {
		return fmt.Sprintf("%s://127.0.0.1:%s", protocol, port)
	}

	// Update default URL based on TLS setting
	if protocol == "https" {
		return "https://127.0.0.1:8080"
	}
	return defaultCoreURL
}

func shouldSkipCoreLaunch() bool {
	value := strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_SKIP_CORE"))
	return value == "1" || strings.EqualFold(value, "true")
}

// isSocketEndpoint returns true if the endpoint uses socket/pipe communication
func isSocketEndpoint(endpoint string) bool {
	return strings.HasPrefix(endpoint, "unix://") || strings.HasPrefix(endpoint, "npipe://")
}

// isCoreAlreadyRunning checks if a core instance is already running and healthy
// Returns true if core is accessible and responding to health checks
func isCoreAlreadyRunning(coreURL string, logger *zap.Logger) bool {
	// For socket endpoints, first verify the socket file exists
	if isSocketEndpoint(coreURL) {
		parsed, err := url.Parse(coreURL)
		if err != nil {
			return false
		}

		if parsed.Scheme == "unix" {
			socketPath := parsed.Path
			if socketPath == "" {
				socketPath = parsed.Opaque
			}
			// Check if socket file exists and is a socket
			info, err := os.Stat(socketPath)
			if err != nil {
				logger.Debug("Socket file does not exist", zap.String("path", socketPath))
				return false
			}
			// Check if it's a socket (not a regular file)
			if info.Mode()&os.ModeSocket == 0 {
				logger.Debug("Path exists but is not a socket", zap.String("path", socketPath))
				return false
			}
		}
	}

	// Try to connect and perform health check
	client := &http.Client{
		Timeout: 2 * time.Second, // Short timeout for quick detection
	}

	// Create custom dialer if using socket
	if isSocketEndpoint(coreURL) {
		dialer, baseURL, err := socket.CreateDialer(coreURL)
		if err != nil {
			logger.Debug("Failed to create dialer for core health check", zap.Error(err))
			return false
		}

		transport := &http.Transport{}
		if dialer != nil {
			transport.DialContext = dialer
		}
		client.Transport = transport

		// Use the base URL for the request
		coreURL = baseURL
	}

	// Try the /ready endpoint (lightweight health check)
	healthURL := fmt.Sprintf("%s/ready", strings.TrimSuffix(coreURL, "/"))
	resp, err := client.Get(healthURL)
	if err != nil {
		logger.Debug("Core health check failed",
			zap.String("url", healthURL),
			zap.Error(err))
		return false
	}
	defer resp.Body.Close()

	// Check if response is successful
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		logger.Debug("Core health check successful",
			zap.String("url", healthURL),
			zap.Int("status", resp.StatusCode))
		return true
	}

	logger.Debug("Core health check returned non-success status",
		zap.String("url", healthURL),
		zap.Int("status", resp.StatusCode))
	return false
}

// resolveCoreBinary locates or stages the core binary for launching.
func resolveCoreBinary(logger *zap.Logger) (string, error) {
	if override := strings.TrimSpace(os.Getenv("MCPPROXY_CORE_PATH")); override != "" {
		if info, err := os.Stat(override); err == nil && !info.IsDir() {
			return override, nil
		}
		return "", fmt.Errorf("MCPPROXY_CORE_PATH does not point to a valid binary: %s", override)
	}

	if managedPath, err := ensureManagedCoreBinary(logger); err == nil {
		return managedPath, nil
	} else if !errors.Is(err, errNoBundledCore) {
		return "", err
	}

	return findMcpproxyBinary()
}

// ensureManagedCoreBinary copies the bundled core binary into a writable location if necessary.
func ensureManagedCoreBinary(logger *zap.Logger) (string, error) {
	bundled, err := discoverBundledCore()
	if err != nil {
		return "", err
	}

	targetDir, err := getManagedBinDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create managed binary directory: %w", err)
	}

	targetPath := filepath.Join(targetDir, "mcpproxy")
	copyNeeded, err := shouldCopyBinary(bundled, targetPath)
	if err != nil {
		return "", err
	}
	if copyNeeded {
		if err := copyFile(bundled, targetPath); err != nil {
			return "", fmt.Errorf("failed to stage bundled core binary: %w", err)
		}
		if err := os.Chmod(targetPath, 0755); err != nil {
			return "", fmt.Errorf("failed to set permissions on managed core binary: %w", err)
		}
		if logger != nil {
			logger.Info("Staged bundled core binary", zap.String("source", bundled), zap.String("target", targetPath))
		}
	}

	return targetPath, nil
}

func discoverBundledCore() (string, error) {
	execPath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("failed to get executable path: %w", err)
	}

	execPath, err = filepath.EvalSymlinks(execPath)
	if err != nil {
		return "", fmt.Errorf("failed to resolve executable path: %w", err)
	}

	macOSDir := filepath.Dir(execPath)
	contentsDir := filepath.Dir(macOSDir)
	if !strings.HasSuffix(contentsDir, "Contents") {
		return "", errNoBundledCore
	}

	resourcesDir := filepath.Join(contentsDir, "Resources")
	candidate := filepath.Join(resourcesDir, "bin", "mcpproxy")
	if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
		return candidate, nil
	}

	return "", errNoBundledCore
}

func getManagedBinDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}

	if runtime.GOOS == platformDarwin {
		return filepath.Join(homeDir, "Library", "Application Support", "mcpproxy", "bin"), nil
	}

	return filepath.Join(homeDir, ".mcpproxy", "bin"), nil
}

func shouldCopyBinary(source, target string) (bool, error) {
	srcInfo, err := os.Stat(source)
	if err != nil {
		return false, fmt.Errorf("failed to stat source binary: %w", err)
	}

	dstInfo, err := os.Stat(target)
	if errors.Is(err, os.ErrNotExist) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to stat target binary: %w", err)
	}

	if srcInfo.Size() != dstInfo.Size() {
		return true, nil
	}

	if srcInfo.ModTime().After(dstInfo.ModTime()) {
		return true, nil
	}

	return false, nil
}

func copyFile(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.Create(target)
	if err != nil {
		return err
	}
	defer func() {
		_ = out.Close()
	}()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}

	return out.Sync()
}

// findMcpproxyBinary resolves the core binary deterministically, preferring
// well-known locations before falling back to PATH lookups.
func findMcpproxyBinary() (string, error) {
	var candidates []string
	seen := make(map[string]struct{})
	addCandidate := func(path string) {
		if path == "" {
			return
		}
		clean := filepath.Clean(path)
		if _, ok := seen[clean]; ok {
			return
		}
		seen[clean] = struct{}{}
		candidates = append(candidates, clean)
	}

	// 1. Paths derived from the tray executable (common during development builds).
	if execPath, err := os.Executable(); err == nil {
		if resolvedExec, err := filepath.EvalSymlinks(execPath); err == nil {
			execDir := filepath.Dir(resolvedExec)
			addCandidate(filepath.Join(execDir, "mcpproxy"))
			addCandidate(filepath.Join(filepath.Dir(execDir), "mcpproxy"))
			addCandidate(filepath.Join(filepath.Dir(filepath.Dir(execDir)), "mcpproxy"))
			addCandidate(filepath.Join(filepath.Dir(execDir), "mcpproxy", "mcpproxy"))
		}
	}

	// 2. Working-directory relative binary (local dev workflow).
	addCandidate(filepath.Join(".", "mcpproxy"))
	if runtime.GOOS == platformWindows {
		addCandidate(filepath.Join(".", "mcpproxy-windows-amd64"))
	}

	// 3. Managed installation directories (Application Support on macOS).
	if homeDir, err := os.UserHomeDir(); err == nil {
		addCandidate(filepath.Join(homeDir, ".mcpproxy", "bin", "mcpproxy"))
		if runtime.GOOS == platformDarwin {
			addCandidate(filepath.Join(homeDir, "Library", "Application Support", "mcpproxy", "bin", "mcpproxy"))
		}
	}

	// 4. Common package manager locations.
	addCandidate("/opt/homebrew/bin/mcpproxy")
	addCandidate("/usr/local/bin/mcpproxy")

	for _, candidate := range candidates {
		if resolved, ok := resolveExecutableCandidate(candidate); ok {
			return resolved, nil
		}
	}

	// 5. Final fallback to PATH search.
	if resolved, err := exec.LookPath("mcpproxy"); err == nil {
		return resolved, nil
	}

	return "", fmt.Errorf("mcpproxy binary not found; checked %v and PATH", candidates)
}

func resolveExecutableCandidate(path string) (string, bool) {
	var abs string
	if runtime.GOOS == platformWindows {
		candidate := path
		lower := strings.ToLower(candidate)
		// try adding .exe if not present
		if !strings.HasSuffix(lower, ".exe") {
			if filepath.IsAbs(candidate) {
				candidate = candidate + ".exe"
			} else {
				candidate = candidate + ".exe"
			}
		}

		if filepath.IsAbs(candidate) {
			abs = candidate
		} else {
			var err error
			abs, err = filepath.Abs(candidate)
			if err != nil {
				return "", false
			}
		}

		info, err := os.Stat(abs)
		if err != nil || info.IsDir() {
			return "", false
		}
		// On Windows, execute bit is not meaningful; presence is enough
		return abs, true
	}

	if filepath.IsAbs(path) {
		abs = path
	} else {
		var err error
		abs, err = filepath.Abs(path)
		if err != nil {
			return "", false
		}
	}

	info, err := os.Stat(abs)
	if err != nil || info.IsDir() {
		return "", false
	}

	if info.Mode()&0o111 == 0 {
		return "", false
	}

	return abs, true
}

func buildCoreArgs(coreURL string) []string {
	args := []string{"serve"}

	if cfg := strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_CONFIG_PATH")); cfg != "" {
		args = append(args, "--config", cfg)
	}

	// IMPORTANT: Only add --listen for TCP/HTTP connections
	// Socket/pipe connections should NOT have --listen (core enables socket by default)
	if !isSocketEndpoint(coreURL) {
		if listen := listenArgFromURL(coreURL); listen != "" {
			args = append(args, "--listen", listen)
		} else if listenEnv := normalizeListen(strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_LISTEN"))); listenEnv != "" {
			args = append(args, "--listen", listenEnv)
		}
	}

	if extra := strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_EXTRA_ARGS")); extra != "" {
		args = append(args, strings.Fields(extra)...)
	}

	return args
}

func wrapCoreLaunchWithShell(coreBinary string, args []string) (string, []string, error) {
	shellPath, err := selectUserShell()
	if err != nil {
		return "", nil, err
	}

	command := buildShellExecCommand(coreBinary, args)
	return shellPath, []string{"-l", "-c", command}, nil
}

func selectUserShell() (string, error) {
	candidates := []string{}
	if shellEnv := strings.TrimSpace(os.Getenv("SHELL")); shellEnv != "" {
		candidates = append(candidates, shellEnv)
	}
	candidates = append(candidates,
		"/bin/zsh",
		"/bin/bash",
		"/bin/sh",
	)

	seen := make(map[string]struct{})
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}

		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}

	return "", fmt.Errorf("no usable shell found for core launch")
}

func buildShellExecCommand(binary string, args []string) string {
	quoted := make([]string, 0, len(args)+1)
	quoted = append(quoted, shellQuote(binary))
	for _, arg := range args {
		quoted = append(quoted, shellQuote(arg))
	}

	return "exec " + strings.Join(quoted, " ")
}

func shellQuote(arg string) string {
	if arg == "" {
		return "''"
	}

	var builder strings.Builder
	builder.Grow(len(arg) + 2)
	builder.WriteByte('\'')
	for i := 0; i < len(arg); i++ {
		if arg[i] == '\'' {
			builder.WriteString("'\\''")
		} else {
			builder.WriteByte(arg[i])
		}
	}
	builder.WriteByte('\'')
	return builder.String()
}

func listenArgFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}

	port := u.Port()
	if port == "" {
		return ""
	}

	host := u.Hostname()
	if host == "" || host == "localhost" || host == "127.0.0.1" {
		// Always use localhost binding for security, never bind to all interfaces
		return "127.0.0.1:" + port
	}

	return net.JoinHostPort(host, port)
}

func normalizeListen(listen string) string {
	if listen == "" {
		return ""
	}

	if strings.HasPrefix(listen, "localhost:") {
		return strings.TrimPrefix(listen, "localhost")
	}

	if strings.HasPrefix(listen, "127.0.0.1:") {
		return strings.TrimPrefix(listen, "127.0.0.1")
	}

	if strings.HasPrefix(listen, ":") {
		return listen
	}

	if !strings.Contains(listen, ":") {
		return ":" + listen
	}

	return listen
}

// getCoreTimeout returns the configured core startup timeout
func getCoreTimeout() time.Duration {
	if timeoutStr := strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_CORE_TIMEOUT")); timeoutStr != "" {
		if timeout, err := strconv.Atoi(timeoutStr); err == nil && timeout > 0 {
			return time.Duration(timeout) * time.Second
		}
	}
	return 30 * time.Second // Default timeout
}

// getRetryDelay returns the configured retry delay
func getRetryDelay() time.Duration {
	if delayStr := strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_RETRY_DELAY")); delayStr != "" {
		if delay, err := strconv.Atoi(delayStr); err == nil && delay > 0 {
			return time.Duration(delay) * time.Second
		}
	}
	return 5 * time.Second // Default delay
}

// getStateDebug returns whether state machine debug mode is enabled
func getStateDebug() bool {
	value := strings.TrimSpace(os.Getenv("MCPPROXY_TRAY_STATE_DEBUG"))
	return value == "1" || strings.EqualFold(value, "true")
}

// maskAPIKey masks an API key for logging (shows first and last 4 chars)
func maskAPIKey(apiKey string) string {
	if len(apiKey) <= 8 {
		return "****"
	}
	return apiKey[:4] + "****" + apiKey[len(apiKey)-4:]
}

// shouldTerminateCore reports whether tray shutdown may kill the core: only a
// core the tray itself launched.
//
// GH #410: coreOwnershipExternalManaged ("a core was already running, so I
// attached to it") used to be terminated as well — via the PID from /status and
// a `pgrep -f "mcpproxy serve"` sweep — so quitting the tray killed a core the
// user was running under launchd/brew. Attaching to a process is not a claim of
// ownership over it.
func shouldTerminateCore(ownership coreOwnershipMode) bool {
	return ownership == coreOwnershipTrayManaged
}
