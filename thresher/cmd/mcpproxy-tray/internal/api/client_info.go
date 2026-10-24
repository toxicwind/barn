package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os/exec"
	"runtime"
	"strings"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/tray"
)

// GetReady checks if the core API is ready to serve requests
func (c *Client) GetReady(ctx context.Context) error {
	url, err := c.buildURL("/ready")
	if err != nil {
		return fmt.Errorf("failed to build ready URL: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, "GET", url, http.NoBody)
	if err != nil {
		return fmt.Errorf("failed to create ready request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("ready request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("ready endpoint returned status %d", resp.StatusCode)
	}

	return nil
}

// GetProfiles fetches the configured profiles (Profiles v2 T5) from
// GET /api/v1/profiles for the tray profile switcher.
func (c *Client) GetProfiles() ([]tray.ProfileInfo, error) {
	resp, err := c.makeRequest("GET", "/api/v1/profiles", nil)
	if err != nil {
		return nil, err
	}
	if !resp.Success {
		return nil, fmt.Errorf("API error: %s", resp.Error)
	}

	raw, ok := resp.Data["profiles"].([]interface{})
	if !ok {
		// No profiles configured is a valid, empty result.
		return nil, nil
	}

	var result []tray.ProfileInfo
	for _, p := range raw {
		pm, ok := p.(map[string]interface{})
		if !ok {
			continue
		}
		result = append(result, tray.ProfileInfo{
			Name:      getString(pm, "name"),
			ToolCount: getInt(pm, "tool_count"),
		})
	}
	return result, nil
}

// GetActiveProfile fetches the server-level default active profile from
// GET /api/v1/profiles/active. An empty string means "all servers".
func (c *Client) GetActiveProfile() (string, error) {
	resp, err := c.makeRequest("GET", "/api/v1/profiles/active", nil)
	if err != nil {
		return "", err
	}
	if !resp.Success {
		return "", fmt.Errorf("API error: %s", resp.Error)
	}
	return getString(resp.Data, "active_profile"), nil
}

// SetActiveProfile sets the server-level default active profile via
// PUT /api/v1/profiles/active. An empty name clears the selection (all servers).
func (c *Client) SetActiveProfile(name string) error {
	resp, err := c.makeRequest("PUT", "/api/v1/profiles/active", map[string]string{"profile": name})
	if err != nil {
		return err
	}
	if !resp.Success {
		return fmt.Errorf("API error: %s", resp.Error)
	}
	return nil
}

// SearchTools searches for tools
// GetInfo fetches server information from /api/v1/info endpoint
func (c *Client) GetInfo() (map[string]interface{}, error) {
	resp, err := c.makeRequest("GET", "/api/v1/info", nil)
	if err != nil {
		return nil, err
	}

	if !resp.Success {
		return nil, fmt.Errorf("API error: %s", resp.Error)
	}

	// Return the full response including the "data" field
	result := map[string]interface{}{
		"success": resp.Success,
		"data":    resp.Data,
	}

	return result, nil
}

// GetStatus fetches the current status snapshot from /api/v1/status
func (c *Client) GetStatus() (map[string]interface{}, error) {
	resp, err := c.makeRequest("GET", "/api/v1/status", nil)
	if err != nil {
		return nil, err
	}

	if !resp.Success {
		return nil, fmt.Errorf("API error: %s", resp.Error)
	}

	status, ok := resp.Data["status"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected status payload")
	}

	return status, nil
}

// GetDockerStatus retrieves the current Docker recovery status
func (c *Client) GetDockerStatus() (*DockerStatus, error) {
	resp, err := c.makeRequest("GET", "/api/v1/docker/status", nil)
	if err != nil {
		return nil, err
	}

	if !resp.Success {
		return nil, fmt.Errorf("API error: %s", resp.Error)
	}

	// Parse the data field into DockerStatus
	var status DockerStatus
	if resp.Data != nil {
		// Convert map to JSON and back to struct for proper type conversion
		jsonData, err := json.Marshal(resp.Data)
		if err != nil {
			return nil, fmt.Errorf("failed to marshal Docker status: %w", err)
		}
		if err := json.Unmarshal(jsonData, &status); err != nil {
			return nil, fmt.Errorf("failed to unmarshal Docker status: %w", err)
		}
	}

	return &status, nil
}

func (c *Client) SearchTools(query string, limit int) ([]SearchResult, error) {
	endpoint := fmt.Sprintf("/api/v1/index/search?q=%s&limit=%d", query, limit)

	resp, err := c.makeRequest("GET", endpoint, nil)
	if err != nil {
		return nil, err
	}

	if !resp.Success {
		return nil, fmt.Errorf("API error: %s", resp.Error)
	}

	results, ok := resp.Data["results"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("unexpected response format")
	}

	var searchResults []SearchResult
	for _, resultData := range results {
		resultMap, ok := resultData.(map[string]interface{})
		if !ok {
			continue
		}

		result := SearchResult{
			Name:        getString(resultMap, "name"),
			Description: getString(resultMap, "description"),
			Server:      getString(resultMap, "server"),
			Score:       getFloat64(resultMap, "score"),
		}

		if schema, ok := resultMap["input_schema"].(map[string]interface{}); ok {
			result.InputSchema = schema
		}

		searchResults = append(searchResults, result)
	}

	return searchResults, nil
}

// OpenWebUI opens the web control panel in the default browser
func (c *Client) OpenWebUI() error {
	// Get the actual web UI URL from the /api/v1/info endpoint
	// This ensures we use the correct HTTP URL even when connected via socket
	resp, err := c.makeRequest("GET", "/api/v1/info", nil)
	if err != nil {
		if c.logger != nil {
			c.logger.Errorw("Failed to get server info", "error", err)
		}
		return fmt.Errorf("failed to get server info: %w", err)
	}

	// Extract web_ui_url from response
	if resp.Data == nil {
		return fmt.Errorf("no data in response from /api/v1/info")
	}

	webUIURL, ok := resp.Data["web_ui_url"].(string)
	if !ok || webUIURL == "" {
		return fmt.Errorf("web_ui_url not found in server info")
	}

	// Add API key if not using socket communication
	url := webUIURL
	if c.apiKey != "" && !strings.HasPrefix(c.baseURL, "unix://") && !strings.HasPrefix(c.baseURL, "npipe://") {
		separator := "?"
		if strings.Contains(url, "?") {
			separator = "&"
		}
		url += separator + "apikey=" + c.apiKey
	}

	displayURL := url
	if c.apiKey != "" {
		displayURL = strings.ReplaceAll(url, c.apiKey, maskForLog(c.apiKey))
	}
	if c.logger != nil {
		c.logger.Infow("Opening web control panel", "url", displayURL)
	}

	switch runtime.GOOS {
	case "darwin":
		cmd := exec.Command("open", url)
		if err := cmd.Run(); err != nil {
			if c.logger != nil {
				c.logger.Errorw("Failed to open web control panel", "url", displayURL, "error", err)
			}
			return fmt.Errorf("failed to open web control panel: %w", err)
		}
		return nil
	case "windows":
		// Try rundll32 first
		if err := exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Run(); err == nil {
			return nil
		}
		// Fallback to cmd start
		if err := exec.Command("cmd", "/c", "start", "", url).Run(); err != nil {
			if c.logger != nil {
				c.logger.Errorw("Failed to open web control panel", "url", displayURL, "error", err)
			}
			return fmt.Errorf("failed to open web control panel: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unsupported OS for OpenWebUI: %s", runtime.GOOS)
	}
}
