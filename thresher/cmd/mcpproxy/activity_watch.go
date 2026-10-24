package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/logs"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/socket"
)

// runActivityWatch implements the activity watch command
func runActivityWatch(cmd *cobra.Command, _ []string) error {
	// Setup logger
	cmdLogLevel, _ := cmd.Flags().GetString("log-level")
	cmdLogToFile, _ := cmd.Flags().GetBool("log-to-file")
	cmdLogDir, _ := cmd.Flags().GetString("log-dir")

	logger, err := logs.SetupCommandLogger(false, cmdLogLevel, cmdLogToFile, cmdLogDir)
	if err != nil {
		return fmt.Errorf("failed to setup logger: %w", err)
	}
	defer func() { _ = logger.Sync() }()

	// Load config to get endpoint - use same logic as getActivityClient
	cfg, err := loadActivityConfig()
	if err != nil {
		return outputActivityError(err, "CONFIG_ERROR")
	}

	// Resolve the SSE target via the shared daemon detection: socket first,
	// then probed TCP fallback with the env>config API key (QA finding
	// CLI-SOCKET — same semantics as getActivityClient).
	sseURL, apiKey, transport, ok := activityWatchTarget(cfg, logger.Sugar())
	if !ok {
		return outputActivityError(fmt.Errorf("mcpproxy daemon is not reachable. Start with: mcpproxy serve"), "CONNECTION_ERROR")
	}

	// Setup context with signal handling
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		fmt.Fprintln(os.Stderr, "\nReceived interrupt, stopping...")
		cancel()
	}()

	outputFormat := ResolveOutputFormat()

	// Create HTTP client with transport
	httpClient := &http.Client{
		Transport: transport,
		Timeout:   0, // No timeout for SSE
	}

	// Watch with reconnection
	return watchWithReconnect(ctx, sseURL, apiKey, outputFormat, logger.Sugar(), httpClient)
}

// activityWatchTarget resolves the SSE URL, API key, and HTTP transport for
// `activity watch` using the shared daemon detection (daemonEndpoint):
// socket first (no API key needed), then probed TCP fallback with the
// env>config API key. ok=false when no daemon is reachable.
func activityWatchTarget(cfg *config.Config, logger *zap.SugaredLogger) (sseURL, apiKey string, transport *http.Transport, ok bool) {
	endpoint, apiKey, ok := daemonEndpoint(cfg)
	if !ok {
		return "", "", nil, false
	}
	transport, baseURL := activityTransport(endpoint, logger)
	return baseURL + "/events", apiKey, transport, true
}

// activityTransport builds an HTTP transport + base URL for a daemonEndpoint
// result: unix://|npipe:// endpoints get a socket dialer, http(s) endpoints
// are used as-is.
func activityTransport(endpoint string, logger *zap.SugaredLogger) (*http.Transport, string) {
	transport := &http.Transport{}
	dialer, baseURL, err := socket.CreateDialer(endpoint)
	if err != nil {
		if logger != nil {
			logger.Warnw("Failed to create socket dialer, using endpoint directly",
				"endpoint", endpoint,
				"error", err)
		}
		return transport, endpoint
	}
	if dialer == nil {
		return transport, endpoint
	}
	transport.DialContext = dialer
	if logger != nil {
		logger.Debugw("Using socket/pipe connection", "endpoint", endpoint)
	}
	return transport, baseURL
}

// watchWithReconnect watches the SSE stream with automatic reconnection
func watchWithReconnect(ctx context.Context, sseURL, apiKey string, outputFormat string, logger *zap.SugaredLogger, httpClient *http.Client) error {
	backoff := 1 * time.Second
	maxBackoff := 30 * time.Second

	for {
		err := watchActivityStream(ctx, sseURL, apiKey, outputFormat, logger, httpClient)

		select {
		case <-ctx.Done():
			return nil
		default:
		}

		if err != nil {
			fmt.Fprintf(os.Stderr, "Connection lost: %v. Reconnecting in %v...\n", err, backoff)
			time.Sleep(backoff)
			backoff = min(backoff*2, maxBackoff)
			continue
		}

		backoff = 1 * time.Second
	}
}

// watchActivityStream connects to SSE and streams events
func watchActivityStream(ctx context.Context, sseURL, apiKey string, outputFormat string, _ *zap.SugaredLogger, httpClient *http.Client) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sseURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Accept", "text/event-stream")
	if apiKey != "" {
		// TCP fallback: /events sits behind apiKeyAuthMiddleware. Header, not
		// ?apikey= query param, so the key never lands in URLs/logs.
		req.Header.Set("X-API-Key", apiKey)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body))
	}

	scanner := bufio.NewScanner(resp.Body)
	var eventType, eventData string

	for scanner.Scan() {
		line := scanner.Text()

		switch {
		case strings.HasPrefix(line, "event: "):
			eventType = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			eventData = strings.TrimPrefix(line, "data: ")
		case line == "":
			// Empty line = event complete
			// Display all activity events except .started (which have no meaningful status/duration)
			// Includes: .completed, policy_decision, system_start, system_stop, config_change
			if strings.HasPrefix(eventType, "activity.") && !strings.HasSuffix(eventType, ".started") {
				displayActivityEvent(eventType, eventData, outputFormat)
			}
			eventType, eventData = "", ""
		}
	}

	return scanner.Err()
}
