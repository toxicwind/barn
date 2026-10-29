package api

import (
	"crypto/sha256"
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// GetServers fetches the list of servers from the API
func (c *Client) GetServers() ([]Server, error) {
	resp, err := c.makeRequest("GET", "/api/v1/servers", nil)
	if err != nil {
		if c.logger != nil {
			c.logger.Warnw("Failed to fetch upstream servers", "error", err)
		}
		return nil, err
	}

	if !resp.Success {
		if c.logger != nil {
			c.logger.Warnw("API reported failure while fetching servers", "error", resp.Error)
		}
		return nil, fmt.Errorf("API error: %s", resp.Error)
	}

	servers, ok := resp.Data["servers"].([]interface{})
	if !ok {
		if c.logger != nil {
			c.logger.Warnw("Unexpected server list payload shape", "data_keys", keys(resp.Data))
		}
		return nil, fmt.Errorf("unexpected response format")
	}

	var result []Server
	for _, serverData := range servers {
		serverMap, ok := serverData.(map[string]interface{})
		if !ok {
			continue
		}

		server := Server{
			Name:        getString(serverMap, "name"),
			Connected:   getBool(serverMap, "connected"),
			Connecting:  getBool(serverMap, "connecting"),
			Enabled:     getBool(serverMap, "enabled"),
			Quarantined: getBool(serverMap, "quarantined"),
			Protocol:    getString(serverMap, "protocol"),
			URL:         getString(serverMap, "url"),
			Command:     getString(serverMap, "command"),
			ToolCount:   getInt(serverMap, "tool_count"),
			LastError:   getString(serverMap, "last_error"),
			Status:      getString(serverMap, "status"),
			ShouldRetry: getBool(serverMap, "should_retry"),
			RetryCount:  getInt(serverMap, "retry_count"),
			LastRetry:   getString(serverMap, "last_retry_time"),
		}

		// Extract health status (Spec 013: Health is source of truth)
		healthRaw := serverMap["health"]
		if healthMap, ok := healthRaw.(map[string]interface{}); ok && healthMap != nil {
			server.Health = &HealthStatus{
				Level:      getString(healthMap, "level"),
				AdminState: getString(healthMap, "admin_state"),
				Summary:    getString(healthMap, "summary"),
				Detail:     getString(healthMap, "detail"),
				Action:     getString(healthMap, "action"),
			}
			if c.logger != nil && server.Health.Level != "" {
				c.logger.Debugw("Health extracted",
					"server", server.Name,
					"level", server.Health.Level,
					"summary", server.Health.Summary)
			}
		} else if healthRaw != nil && c.logger != nil {
			// Health field exists but wasn't a map - log for debugging
			c.logger.Warnw("Health field present but wrong type",
				"server", server.Name,
				"health_type", fmt.Sprintf("%T", healthRaw))
		}

		result = append(result, server)
	}

	// Compute state hash to detect changes and reduce logging noise
	stateHash := c.computeServerStateHash(result)
	stateChanged := stateHash != c.lastServerState

	if c.logger != nil {
		// Count servers with health for debugging
		healthyCount := 0
		withHealthCount := 0
		for _, s := range result {
			if s.Health != nil {
				withHealthCount++
				if s.Health.Level == "healthy" {
					healthyCount++
				}
			}
		}

		if stateChanged {
			if len(result) == 0 {
				c.logger.Warnw("API returned zero upstream servers",
					"base_url", c.baseURL)
			} else {
				// Only log when server states actually change
				c.logger.Debugw("Server state changed",
					"count", len(result),
					"connected", countConnected(result),
					"with_health", withHealthCount,
					"healthy", healthyCount,
					"quarantined", countQuarantined(result))
			}
			c.lastServerState = stateHash
		}
		// Silent when no changes - reduces log noise from frequent polling
	}

	return result, nil
}

// EnableServer enables or disables a server
func (c *Client) EnableServer(serverName string, enabled bool) error {
	var endpoint string
	if enabled {
		endpoint = fmt.Sprintf("/api/v1/servers/%s/enable", serverName)
	} else {
		endpoint = fmt.Sprintf("/api/v1/servers/%s/disable", serverName)
	}

	resp, err := c.makeRequest("POST", endpoint, nil)
	if err != nil {
		return err
	}

	if !resp.Success {
		return fmt.Errorf("API error: %s", resp.Error)
	}

	return nil
}

// RestartServer restarts a server
func (c *Client) RestartServer(serverName string) error {
	endpoint := fmt.Sprintf("/api/v1/servers/%s/restart", serverName)

	resp, err := c.makeRequest("POST", endpoint, nil)
	if err != nil {
		return err
	}

	if !resp.Success {
		return fmt.Errorf("API error: %s", resp.Error)
	}

	return nil
}

// ForceReconnectAllServers triggers reconnection attempts for all upstream servers
func (c *Client) ForceReconnectAllServers(reason string) error {
	endpoint := "/api/v1/servers/reconnect"
	if reason != "" {
		endpoint = endpoint + "?reason=" + url.QueryEscape(reason)
	}

	resp, err := c.makeRequest("POST", endpoint, nil)
	if err != nil {
		return err
	}

	if !resp.Success {
		return fmt.Errorf("API error: %s", resp.Error)
	}

	return nil
}

// TriggerOAuthLogin triggers OAuth login for a server
func (c *Client) TriggerOAuthLogin(serverName string) error {
	endpoint := fmt.Sprintf("/api/v1/servers/%s/login", serverName)

	resp, err := c.makeRequest("POST", endpoint, nil)
	if err != nil {
		return err
	}

	if !resp.Success {
		return fmt.Errorf("API error: %s", resp.Error)
	}

	return nil
}

// GetServerTools gets tools for a specific server
func (c *Client) GetServerTools(serverName string) ([]Tool, error) {
	endpoint := fmt.Sprintf("/api/v1/servers/%s/tools", serverName)

	resp, err := c.makeRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}

	if !resp.Success {
		return nil, fmt.Errorf("API error: %s", resp.Error)
	}

	tools, ok := resp.Data["tools"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected response format")
	}

	var result []Tool
	for _, toolData := range tools {
		toolMap, ok := toolData.(map[string]interface{})
		if !ok {
			continue
		}

		tool := Tool{
			Name:        getString(toolMap, "name"),
			Description: getString(toolMap, "description"),
			Server:      getString(toolMap, "server"),
		}

		if schema, ok := toolMap["input_schema"].(map[string]interface{}); ok {
			tool.InputSchema = schema
		}

		result = append(result, tool)
	}

	return result, nil
}

// QuarantineServer places a server in quarantine
func (c *Client) QuarantineServer(serverName string) error {
	endpoint := fmt.Sprintf("/api/v1/servers/%s/quarantine", serverName)

	resp, err := c.makeRequest("POST", endpoint, nil)
	if err != nil {
		return err
	}

	if !resp.Success {
		return fmt.Errorf("API error: %s", resp.Error)
	}

	return nil
}

// UnquarantineServer removes a server from quarantine
func (c *Client) UnquarantineServer(serverName string) error {
	endpoint := fmt.Sprintf("/api/v1/servers/%s/unquarantine", serverName)

	resp, err := c.makeRequest("POST", endpoint, nil)
	if err != nil {
		return err
	}

	if !resp.Success {
		return fmt.Errorf("API error: %s", resp.Error)
	}

	return nil
}

// computeServerStateHash generates a hash of server states to detect changes
func (c *Client) computeServerStateHash(servers []Server) string {
	// Build a deterministic string representation of server states
	var parts []string
	for _, s := range servers {
		// Include relevant state fields that matter for logging changes
		state := fmt.Sprintf("%s:%t:%t:%t:%d:%s",
			s.Name, s.Connected, s.Enabled, s.Quarantined, s.ToolCount, s.Status)
		parts = append(parts, state)
	}
	sort.Strings(parts) // Sort for consistency

	// Hash the combined state
	combined := strings.Join(parts, "|")
	hash := sha256.Sum256([]byte(combined))
	return fmt.Sprintf("%x", hash[:8]) // Use first 8 bytes for compact representation
}

// countConnected returns the number of connected servers
func countConnected(servers []Server) int {
	count := 0
	for _, s := range servers {
		if s.Connected {
			count++
		}
	}
	return count
}

// countQuarantined returns the number of quarantined servers
func countQuarantined(servers []Server) int {
	count := 0
	for _, s := range servers {
		if s.Quarantined {
			count++
		}
	}
	return count
}
