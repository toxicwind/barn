package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/tray"
)

// StartSSE starts the Server-Sent Events connection for real-time updates with enhanced retry logic
func (c *Client) StartSSE(ctx context.Context) error {
	c.logger.Info("Starting enhanced SSE connection for real-time updates over socket/pipe transport")

	sseCtx, cancel := context.WithCancel(ctx)
	c.sseCancel = cancel

	go func() {
		defer close(c.statusCh)
		defer close(c.connectionStateCh)

		attemptCount := 0
		maxRetries := 10
		baseDelay := 2 * time.Second
		maxDelay := 30 * time.Second

		for {
			if sseCtx.Err() != nil {
				c.publishConnectionState(tray.ConnectionStateDisconnected)
				return
			}

			attemptCount++

			// Calculate exponential backoff delay
			minVal := attemptCount - 1
			if minVal > 4 {
				minVal = 4
			}
			if minVal < 0 {
				minVal = 0
			}
			backoffFactor := 1 << minVal
			delay := time.Duration(int64(baseDelay) * int64(backoffFactor))
			if delay > maxDelay {
				delay = maxDelay
			}

			if attemptCount > 1 {
				if c.logger != nil {
					c.logger.Infow("SSE reconnection attempt",
						"attempt", attemptCount,
						"max_retries", maxRetries,
						"delay", delay,
						"base_url", c.baseURL)
				}

				// Wait before reconnecting (except first attempt)
				select {
				case <-sseCtx.Done():
					c.publishConnectionState(tray.ConnectionStateDisconnected)
					return
				case <-time.After(delay):
				}
			}

			// Check if we've exceeded max retries
			if attemptCount > maxRetries {
				if c.logger != nil {
					c.logger.Errorw("SSE connection failed after max retries",
						"attempts", attemptCount,
						"max_retries", maxRetries,
						"base_url", c.baseURL)
				}
				c.publishConnectionState(tray.ConnectionStateDisconnected)
				return
			}

			c.publishConnectionState(tray.ConnectionStateConnecting)

			if err := c.connectSSE(sseCtx); err != nil {
				if c.logger != nil {
					c.logger.Errorw("SSE connection error",
						"error", err,
						"attempt", attemptCount,
						"max_retries", maxRetries,
						"base_url", c.baseURL)
				}

				// Check if it's a context cancellation
				if sseCtx.Err() != nil {
					c.publishConnectionState(tray.ConnectionStateDisconnected)
					return
				}

				c.publishConnectionState(tray.ConnectionStateReconnecting)
				continue
			}

			// Successful connection - reset attempt count
			if attemptCount > 1 && c.logger != nil {
				c.logger.Infow("SSE connection established successfully",
					"after_attempts", attemptCount,
					"base_url", c.baseURL)
			}
			attemptCount = 0
		}
	}()

	return nil
}

// StopSSE stops the SSE connection
func (c *Client) StopSSE() {
	if c.sseCancel != nil {
		c.sseCancel()
	}
}

// StatusChannel returns the channel for status updates
func (c *Client) StatusChannel() <-chan StatusUpdate {
	return c.statusCh
}

// ConnectionStateChannel exposes connectivity updates for tray consumers.
func (c *Client) ConnectionStateChannel() <-chan tray.ConnectionState {
	return c.connectionStateCh
}

// connectSSE establishes the SSE connection and processes events
func (c *Client) connectSSE(ctx context.Context) error {
	url, err := c.buildURL("/events")
	if err != nil {
		return err
	}
	if c.apiKey != "" {
		separator := "?"
		if strings.Contains(url, "?") {
			separator = "&"
		}
		url += separator + "apikey=" + c.apiKey
	}

	req, err := http.NewRequestWithContext(ctx, "GET", url, http.NoBody)
	if err != nil {
		return err
	}

	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("SSE connection failed with status: %d", resp.StatusCode)
	}

	c.publishConnectionState(tray.ConnectionStateConnected)

	scanner := bufio.NewScanner(resp.Body)
	var eventType string
	var data strings.Builder

	for scanner.Scan() {
		line := scanner.Text()

		if line == "" {
			// End of event, process it
			if eventType != "" && data.Len() > 0 {
				c.processSSEEvent(eventType, data.String())
				eventType = ""
				data.Reset()
			}
		} else if strings.HasPrefix(line, "event:") {
			eventType = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			dataLine := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			if data.Len() > 0 {
				data.WriteString("\n")
			}
			data.WriteString(dataLine)
		}
	}

	return scanner.Err()
}

// processSSEEvent processes incoming SSE events
func (c *Client) processSSEEvent(eventType, data string) {
	if eventType == "status" {
		var statusUpdate StatusUpdate
		if err := json.Unmarshal([]byte(data), &statusUpdate); err != nil {
			if c.logger != nil {
				c.logger.Errorw("Failed to parse SSE status data", "error", err)
			}
			return
		}

		// Send to status channel (non-blocking)
		select {
		case c.statusCh <- statusUpdate:
		default:
			// Channel full, skip this update
		}
	}
}

// publishConnectionState attempts to deliver a connection state update without blocking the SSE loop.
func (c *Client) publishConnectionState(state tray.ConnectionState) {
	select {
	case c.connectionStateCh <- state:
	default:
		if c.logger != nil {
			c.logger.Debugw("Dropping connection state update", "state", state)
		}
	}
}
