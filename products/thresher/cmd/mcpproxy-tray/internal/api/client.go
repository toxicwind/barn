package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/socket"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/tray"
)

// HealthStatus represents the unified health status of an upstream MCP server.
// This matches the contracts.HealthStatus struct from the core.
// Spec 013: Health is the single source of truth for server status.
type HealthStatus struct {
	Level      string `json:"level"`            // "healthy", "degraded", "unhealthy"
	AdminState string `json:"admin_state"`      // "enabled", "disabled", "quarantined"
	Summary    string `json:"summary"`          // e.g., "Connected (5 tools)"
	Detail     string `json:"detail,omitempty"` // Optional longer explanation
	Action     string `json:"action,omitempty"` // "login", "restart", "enable", "approve", "set_secret", "configure", "view_logs", ""
}

// Server represents a server from the API
type Server struct {
	Name        string        `json:"name"`
	Connected   bool          `json:"connected"`
	Connecting  bool          `json:"connecting"`
	Enabled     bool          `json:"enabled"`
	Quarantined bool          `json:"quarantined"`
	Protocol    string        `json:"protocol"`
	URL         string        `json:"url"`
	Command     string        `json:"command"`
	ToolCount   int           `json:"tool_count"`
	LastError   string        `json:"last_error"`
	Status      string        `json:"status"`
	ShouldRetry bool          `json:"should_retry"`
	RetryCount  int           `json:"retry_count"`
	LastRetry   string        `json:"last_retry_time"`
	Health      *HealthStatus `json:"health,omitempty"` // Spec 013: Health is source of truth
}

// Tool represents a tool from the API
type Tool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Server      string                 `json:"server"`
	InputSchema map[string]interface{} `json:"input_schema,omitempty"`
}

// SearchResult represents a search result from the API
type SearchResult struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Server      string                 `json:"server"`
	Score       float64                `json:"score"`
	InputSchema map[string]interface{} `json:"input_schema,omitempty"`
}

// Response represents the standard API response format
type Response struct {
	Success bool                   `json:"success"`
	Data    map[string]interface{} `json:"data,omitempty"`
	Error   string                 `json:"error,omitempty"`
}

// StatusUpdate represents a status update from SSE
type StatusUpdate struct {
	Running       bool                   `json:"running"`
	ListenAddr    string                 `json:"listen_addr"`
	UpstreamStats map[string]interface{} `json:"upstream_stats"`
	Status        map[string]interface{} `json:"status"`
	Timestamp     int64                  `json:"timestamp"`
}

// DockerStatus represents Docker recovery status from the API
type DockerStatus struct {
	DockerAvailable  bool   `json:"docker_available"`
	RecoveryMode     bool   `json:"recovery_mode"`
	FailureCount     int    `json:"failure_count"`
	AttemptsSinceUp  int    `json:"attempts_since_up"`
	LastAttempt      string `json:"last_attempt"`
	LastError        string `json:"last_error"`
	LastSuccessfulAt string `json:"last_successful_at"`
}

// Client provides access to the mcpproxy API
type Client struct {
	baseURL           string
	apiKey            string
	httpClient        *http.Client
	logger            *zap.SugaredLogger
	statusCh          chan StatusUpdate
	sseCancel         context.CancelFunc
	connectionStateCh chan tray.ConnectionState

	// State tracking to reduce logging noise
	lastServerState string // Hash of server states to detect changes
}

// NewClient creates a new API client with automatic socket/pipe support
func NewClient(endpoint string, logger *zap.SugaredLogger) *Client {
	// Create TLS config that trusts the local CA
	tlsConfig := createTLSConfig(logger)

	// Create custom transport
	transport := &http.Transport{
		TLSClientConfig: tlsConfig,
	}

	// Check if we should use a custom dialer (Unix socket or Windows pipe)
	dialer, baseURL, err := socket.CreateDialer(endpoint)
	if err != nil {
		if logger != nil {
			logger.Warn("Failed to create custom dialer, falling back to TCP",
				"endpoint", endpoint,
				"error", err)
		}
		baseURL = endpoint
		dialer = nil
	}

	// Apply custom dialer if available
	if dialer != nil {
		transport.DialContext = dialer
		if logger != nil {
			logger.Infow("Using socket/pipe connection",
				"endpoint", endpoint,
				"base_url", baseURL)
		}
	} else {
		if logger != nil {
			logger.Infow("Using TCP connection", "endpoint", endpoint)
		}
	}

	return &Client{
		baseURL: strings.TrimSuffix(baseURL, "/"),
		httpClient: &http.Client{
			Timeout:   0,
			Transport: transport,
		},
		logger:            logger,
		statusCh:          make(chan StatusUpdate, 10),
		connectionStateCh: make(chan tray.ConnectionState, 8),
	}
}

// CreateHTTPClient creates an HTTP client with socket/pipe awareness and optional timeout.
// This is used by both the API client and health monitor to ensure consistent behavior.
func CreateHTTPClient(endpoint string, timeout time.Duration, logger *zap.SugaredLogger) *http.Client {
	// Create TLS config that trusts the local CA
	tlsConfig := createTLSConfig(logger)

	// Create custom transport
	transport := &http.Transport{
		TLSClientConfig: tlsConfig,
	}

	// Check if we should use a custom dialer (Unix socket or Windows pipe)
	dialer, _, err := socket.CreateDialer(endpoint)
	if err != nil {
		if logger != nil {
			logger.Debug("Using standard TCP dialer",
				"endpoint", endpoint,
				"error", err)
		}
	}

	// Apply custom dialer if available
	if dialer != nil {
		transport.DialContext = dialer
		if logger != nil {
			logger.Debug("Using socket/pipe dialer for HTTP client",
				"endpoint", endpoint)
		}
	}

	return &http.Client{
		Timeout:   timeout,
		Transport: transport,
	}
}

func (c *Client) buildURL(path string) (string, error) {
	base := strings.TrimSuffix(c.baseURL, "/")
	baseURL, err := url.Parse(base)
	if err != nil {
		return "", fmt.Errorf("invalid base URL %q: %w", c.baseURL, err)
	}

	rel, err := url.Parse(path)
	if err != nil {
		return "", fmt.Errorf("invalid path %q: %w", path, err)
	}

	return baseURL.ResolveReference(rel).String(), nil
}

// SetAPIKey sets the API key for authentication
func (c *Client) SetAPIKey(apiKey string) {
	c.apiKey = apiKey
}

// makeRequest makes an HTTP request to the API with enhanced error handling and retry logic.
// When body is non-nil it is JSON-encoded and sent as the request payload (e.g. PUT bodies);
// nil yields a bodyless request, preserving every existing call site.
func (c *Client) makeRequest(method, path string, body interface{}) (*Response, error) {
	url, err := c.buildURL(path)
	if err != nil {
		return nil, err
	}
	maxRetries := 3
	baseDelay := 1 * time.Second

	var bodyBytes []byte
	if body != nil {
		bodyBytes, err = json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal request body: %w", err)
		}
	}

	for attempt := 1; attempt <= maxRetries; attempt++ {
		// Recreate the reader each attempt so retries resend the full body.
		var bodyReader io.Reader = http.NoBody
		if bodyBytes != nil {
			bodyReader = bytes.NewReader(bodyBytes)
		}
		req, err := http.NewRequest(method, url, bodyReader)
		if err != nil {
			return nil, fmt.Errorf("failed to create request: %w", err)
		}

		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", "mcpproxy-tray/1.0")

		// Add API key header if available
		if c.apiKey != "" {
			req.Header.Set("X-API-Key", c.apiKey)
		}

		// Increased timeout to 15s to allow core to gather status from all servers
		// With 14 servers, some may be connecting/Docker starting which takes time
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel() // Defer cancel to ensure response body is fully read before canceling
		req = req.WithContext(ctx)

		resp, err := c.httpClient.Do(req)

		if err != nil {
			if attempt < maxRetries {
				delay := time.Duration(attempt) * baseDelay
				if c.logger != nil {
					c.logger.Debugw("Request failed, retrying",
						"attempt", attempt,
						"max_retries", maxRetries,
						"delay", delay,
						"error", err)
				}
				time.Sleep(delay)
				continue
			}
			return nil, fmt.Errorf("request failed after %d attempts: %w", maxRetries, err)
		}

		// Process response with proper cleanup
		result, shouldContinue, err := c.processResponse(resp, attempt, maxRetries, baseDelay, path)
		if err != nil {
			return nil, err
		}
		if shouldContinue {
			continue
		}
		return result, nil
	}

	return nil, fmt.Errorf("unexpected error in request retry loop")
}

// processResponse handles response processing with proper cleanup
func (c *Client) processResponse(resp *http.Response, attempt, maxRetries int, baseDelay time.Duration, path string) (*Response, bool, error) {
	defer resp.Body.Close()

	// Handle specific HTTP status codes
	switch resp.StatusCode {
	case 401:
		return nil, false, fmt.Errorf("authentication failed: invalid or missing API key")
	case 403:
		return nil, false, fmt.Errorf("authorization failed: insufficient permissions")
	case 404:
		return nil, false, fmt.Errorf("endpoint not found: %s", path)
	case 429:
		// Rate limited - retry with exponential backoff
		if attempt < maxRetries {
			delay := time.Duration(attempt*attempt) * baseDelay
			if c.logger != nil {
				c.logger.Warnw("Rate limited, retrying",
					"attempt", attempt,
					"delay", delay,
					"status", resp.StatusCode)
			}
			time.Sleep(delay)
			return nil, true, nil
		}
		return nil, false, fmt.Errorf("rate limited after %d attempts", maxRetries)
	case 500, 502, 503, 504:
		// Server errors - retry
		if attempt < maxRetries {
			delay := time.Duration(attempt) * baseDelay
			if c.logger != nil {
				c.logger.Warnw("Server error, retrying",
					"attempt", attempt,
					"status", resp.StatusCode,
					"delay", delay)
			}
			time.Sleep(delay)
			return nil, true, nil
		}
		return nil, false, fmt.Errorf("server error after %d attempts: status %d", maxRetries, resp.StatusCode)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false, fmt.Errorf("API call failed with status %d", resp.StatusCode)
	}

	var apiResp Response
	if err := json.NewDecoder(resp.Body).Decode(&apiResp); err != nil {
		return nil, false, fmt.Errorf("failed to decode response: %w", err)
	}

	return &apiResp, false, nil
}
