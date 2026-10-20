package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
)

// ============================================================================
// T016-T017: Add HTTP Server Tests (Config Mode)
// ============================================================================

func TestAddHTTPServerConfigMode(t *testing.T) {
	t.Run("adds HTTP server with URL", func(t *testing.T) {
		// T016: Unit test: add HTTP server with URL
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json") // Must match config.ConfigFileName

		// Create initial config
		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": []
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		// Create request
		req := &cliclient.AddServerRequest{
			Name:     "notion",
			URL:      "https://mcp.notion.com/sse",
			Protocol: "streamable-http",
		}

		// Load config
		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}

		// Override config path for saving
		cfg.DataDir = tmpDir

		// Capture output
		oldStdout := os.Stdout
		r, w, _ := os.Pipe()
		os.Stdout = w

		err = runUpstreamAddConfigMode(req, cfg)

		w.Close()
		os.Stdout = oldStdout
		var buf bytes.Buffer
		buf.ReadFrom(r)
		output := buf.String()

		if err != nil {
			t.Errorf("runUpstreamAddConfigMode() error = %v", err)
		}

		// Verify output
		if !strings.Contains(output, "Added server") {
			t.Error("Expected success message")
		}
		if !strings.Contains(output, "notion") {
			t.Error("Expected server name in output")
		}

		// Verify config was updated
		updatedCfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load updated config: %v", err)
		}
		if len(updatedCfg.Servers) != 1 {
			t.Errorf("Expected 1 server, got %d", len(updatedCfg.Servers))
		}
		if updatedCfg.Servers[0].Name != "notion" {
			t.Errorf("Expected server name 'notion', got %s", updatedCfg.Servers[0].Name)
		}
		if updatedCfg.Servers[0].URL != "https://mcp.notion.com/sse" {
			t.Errorf("Expected URL 'https://mcp.notion.com/sse', got %s", updatedCfg.Servers[0].URL)
		}
	})

	t.Run("adds HTTP server with headers", func(t *testing.T) {
		// T017: Unit test: add HTTP server with headers
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		// Create initial config
		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": []
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		// Create request with headers
		req := &cliclient.AddServerRequest{
			Name:     "weather",
			URL:      "https://api.weather.com/mcp",
			Protocol: "streamable-http",
			Headers: map[string]string{
				"Authorization": "Bearer secret-token",
				"X-Custom":      "value",
			},
		}

		// Load config
		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		// Capture output
		oldStdout := os.Stdout
		_, w, _ := os.Pipe()
		os.Stdout = w

		err = runUpstreamAddConfigMode(req, cfg)

		w.Close()
		os.Stdout = oldStdout

		if err != nil {
			t.Errorf("runUpstreamAddConfigMode() error = %v", err)
		}

		// Verify config was updated with headers
		updatedCfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load updated config: %v", err)
		}
		if len(updatedCfg.Servers) != 1 {
			t.Errorf("Expected 1 server, got %d", len(updatedCfg.Servers))
		}
		if updatedCfg.Servers[0].Headers["Authorization"] != "Bearer secret-token" {
			t.Errorf("Expected Authorization header, got %v", updatedCfg.Servers[0].Headers)
		}
		if updatedCfg.Servers[0].Headers["X-Custom"] != "value" {
			t.Errorf("Expected X-Custom header, got %v", updatedCfg.Servers[0].Headers)
		}
	})

	t.Run("rejects duplicate server", func(t *testing.T) {
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		// Create config with existing server
		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": [{"name": "existing", "url": "https://example.com"}]
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		req := &cliclient.AddServerRequest{
			Name:     "existing",
			URL:      "https://other.com",
			Protocol: "http",
		}

		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		err = runUpstreamAddConfigMode(req, cfg)

		if err == nil {
			t.Error("Expected error for duplicate server")
		}
		if !strings.Contains(err.Error(), "already exists") {
			t.Errorf("Expected 'already exists' error, got: %v", err)
		}
	})

	t.Run("if-not-exists skips duplicate silently", func(t *testing.T) {
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		// Create config with existing server
		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": [{"name": "existing", "url": "https://example.com"}]
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		req := &cliclient.AddServerRequest{
			Name:     "existing",
			URL:      "https://other.com",
			Protocol: "http",
		}

		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		// Set if-not-exists flag
		oldIfNotExists := upstreamAddIfNotExists
		upstreamAddIfNotExists = true
		defer func() { upstreamAddIfNotExists = oldIfNotExists }()

		// Pin table format so the structured skip payload is not emitted.
		oldFormat := globalOutputFormat
		oldJSON := globalJSONOutput
		globalOutputFormat = "table"
		globalJSONOutput = false
		defer func() {
			globalOutputFormat = oldFormat
			globalJSONOutput = oldJSON
		}()

		// Capture output. Since the CLI-JSON fix, the human skip notice goes
		// to stderr so machine formats keep stdout parseable.
		oldStdout := os.Stdout
		oldStderr := os.Stderr
		rOut, wOut, _ := os.Pipe()
		rErr, wErr, _ := os.Pipe()
		os.Stdout = wOut
		os.Stderr = wErr

		err = runUpstreamAddConfigMode(req, cfg)

		wOut.Close()
		wErr.Close()
		os.Stdout = oldStdout
		os.Stderr = oldStderr
		var bufOut, bufErr bytes.Buffer
		bufOut.ReadFrom(rOut)
		bufErr.ReadFrom(rErr)

		if err != nil {
			t.Errorf("Expected no error with --if-not-exists, got: %v", err)
		}
		if !strings.Contains(bufErr.String(), "already exists") || !strings.Contains(bufErr.String(), "skipped") {
			t.Error("Expected skip message on stderr for existing server")
		}
		if bufOut.String() != "" {
			t.Errorf("Expected empty stdout in table mode, got %q", bufOut.String())
		}
	})
}

// ============================================================================
// T024-T025: Add Stdio Server Tests (Config Mode)
// ============================================================================

func TestAddStdioServerConfigMode(t *testing.T) {
	t.Run("adds stdio server with command", func(t *testing.T) {
		// T024: Unit test: add stdio server with command
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": []
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		req := &cliclient.AddServerRequest{
			Name:     "fs",
			Command:  "npx",
			Args:     []string{"-y", "@anthropic/mcp-server-filesystem", "/home/user"},
			Protocol: "stdio",
		}

		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		// Capture output
		oldStdout := os.Stdout
		_, w, _ := os.Pipe()
		os.Stdout = w

		err = runUpstreamAddConfigMode(req, cfg)

		w.Close()
		os.Stdout = oldStdout

		if err != nil {
			t.Errorf("runUpstreamAddConfigMode() error = %v", err)
		}

		// Verify config
		updatedCfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load updated config: %v", err)
		}
		if len(updatedCfg.Servers) != 1 {
			t.Fatalf("Expected 1 server, got %d", len(updatedCfg.Servers))
		}
		srv := updatedCfg.Servers[0]
		if srv.Name != "fs" {
			t.Errorf("Expected name 'fs', got %s", srv.Name)
		}
		if srv.Command != "npx" {
			t.Errorf("Expected command 'npx', got %s", srv.Command)
		}
		if len(srv.Args) != 3 {
			t.Errorf("Expected 3 args, got %d", len(srv.Args))
		}
		if srv.Protocol != "stdio" {
			t.Errorf("Expected protocol 'stdio', got %s", srv.Protocol)
		}
	})

	t.Run("adds stdio server with env and working-dir", func(t *testing.T) {
		// T025: Unit test: add stdio server with env and working-dir
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		// Create a working directory for the test
		workingDir := filepath.Join(tmpDir, "projects")
		err := os.MkdirAll(workingDir, 0755)
		if err != nil {
			t.Fatalf("Failed to create working directory: %v", err)
		}

		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": []
		}`
		err = os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		req := &cliclient.AddServerRequest{
			Name:       "project-tools",
			Command:    "uvx",
			Args:       []string{"mcp-server-project"},
			Protocol:   "stdio",
			WorkingDir: workingDir,
			Env: map[string]string{
				"PROJECT_ROOT": workingDir,
				"DEBUG":        "true",
			},
		}

		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		// Capture output
		oldStdout := os.Stdout
		_, w, _ := os.Pipe()
		os.Stdout = w

		err = runUpstreamAddConfigMode(req, cfg)

		w.Close()
		os.Stdout = oldStdout

		if err != nil {
			t.Errorf("runUpstreamAddConfigMode() error = %v", err)
		}

		// Verify config
		updatedCfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load updated config: %v", err)
		}
		if len(updatedCfg.Servers) != 1 {
			t.Fatalf("Expected 1 server, got %d", len(updatedCfg.Servers))
		}
		srv := updatedCfg.Servers[0]
		if srv.WorkingDir != workingDir {
			t.Errorf("Expected working_dir '%s', got %s", workingDir, srv.WorkingDir)
		}
		if srv.Env["PROJECT_ROOT"] != workingDir {
			t.Errorf("Expected PROJECT_ROOT env '%s', got %v", workingDir, srv.Env)
		}
		if srv.Env["DEBUG"] != "true" {
			t.Errorf("Expected DEBUG env, got %v", srv.Env)
		}
	})
}

// ============================================================================
// T032-T034: Remove Server Tests (Config Mode)
// ============================================================================

func TestRemoveServerConfigMode(t *testing.T) {
	t.Run("removes server successfully", func(t *testing.T) {
		// T032/T033: Remove server (confirmation bypassed in config mode tests)
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		// Create config with server
		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": [
				{"name": "github", "url": "https://api.github.com/mcp"},
				{"name": "notion", "url": "https://mcp.notion.com/sse"}
			]
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		// Capture output
		oldStdout := os.Stdout
		r, w, _ := os.Pipe()
		os.Stdout = w

		err = runUpstreamRemoveConfigMode("github", cfg)

		w.Close()
		os.Stdout = oldStdout
		var buf bytes.Buffer
		buf.ReadFrom(r)
		output := buf.String()

		if err != nil {
			t.Errorf("runUpstreamRemoveConfigMode() error = %v", err)
		}

		// Verify output
		if !strings.Contains(output, "Removed server") {
			t.Error("Expected success message")
		}
		if !strings.Contains(output, "github") {
			t.Error("Expected server name in output")
		}

		// Verify config was updated
		updatedCfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load updated config: %v", err)
		}
		if len(updatedCfg.Servers) != 1 {
			t.Errorf("Expected 1 server remaining, got %d", len(updatedCfg.Servers))
		}
		if updatedCfg.Servers[0].Name != "notion" {
			t.Errorf("Expected 'notion' to remain, got %s", updatedCfg.Servers[0].Name)
		}
	})

	t.Run("returns error for non-existent server", func(t *testing.T) {
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": [{"name": "existing", "url": "https://example.com"}]
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		err = runUpstreamRemoveConfigMode("nonexistent", cfg)

		if err == nil {
			t.Error("Expected error for non-existent server")
		}
		if !strings.Contains(err.Error(), "not found") {
			t.Errorf("Expected 'not found' error, got: %v", err)
		}
	})

	t.Run("if-exists skips non-existent server silently", func(t *testing.T) {
		// T034: Unit test: remove non-existent server with --if-exists
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": [{"name": "existing", "url": "https://example.com"}]
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		// Set if-exists flag
		oldIfExists := upstreamRemoveIfExists
		upstreamRemoveIfExists = true
		defer func() { upstreamRemoveIfExists = oldIfExists }()

		// Pin table format so the structured skip payload is not emitted.
		oldFormat := globalOutputFormat
		oldJSON := globalJSONOutput
		globalOutputFormat = "table"
		globalJSONOutput = false
		defer func() {
			globalOutputFormat = oldFormat
			globalJSONOutput = oldJSON
		}()

		// Capture output. Since the CLI-JSON fix, the human skip notice goes
		// to stderr so machine formats keep stdout parseable.
		oldStdout := os.Stdout
		oldStderr := os.Stderr
		rOut, wOut, _ := os.Pipe()
		rErr, wErr, _ := os.Pipe()
		os.Stdout = wOut
		os.Stderr = wErr

		err = runUpstreamRemoveConfigMode("nonexistent", cfg)

		wOut.Close()
		wErr.Close()
		os.Stdout = oldStdout
		os.Stderr = oldStderr
		var bufOut, bufErr bytes.Buffer
		bufOut.ReadFrom(rOut)
		bufErr.ReadFrom(rErr)

		if err != nil {
			t.Errorf("Expected no error with --if-exists, got: %v", err)
		}
		if !strings.Contains(bufErr.String(), "not found") || !strings.Contains(bufErr.String(), "skipped") {
			t.Error("Expected skip message on stderr for non-existent server")
		}
		if bufOut.String() != "" {
			t.Errorf("Expected empty stdout in table mode, got %q", bufOut.String())
		}
	})
}

// ============================================================================
// T040-T041: Add-JSON Tests
// ============================================================================

func TestAddJSONParsing(t *testing.T) {
	t.Run("parses valid HTTP JSON config", func(t *testing.T) {
		// T040: Unit test: add-json with valid JSON
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": []
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		// Simulate the JSON parsing logic from runUpstreamAddJSON
		jsonStr := `{"url":"https://api.weather.com/mcp","headers":{"Authorization":"Bearer token"}}`

		var jsonConfig struct {
			URL        string            `json:"url"`
			Command    string            `json:"command"`
			Args       []string          `json:"args"`
			Env        map[string]string `json:"env"`
			Headers    map[string]string `json:"headers"`
			WorkingDir string            `json:"working_dir"`
			Protocol   string            `json:"protocol"`
		}

		err = json.Unmarshal([]byte(jsonStr), &jsonConfig)
		if err != nil {
			t.Errorf("Failed to parse JSON: %v", err)
		}

		// Verify parsed values
		if jsonConfig.URL != "https://api.weather.com/mcp" {
			t.Errorf("Expected URL 'https://api.weather.com/mcp', got %s", jsonConfig.URL)
		}
		if jsonConfig.Headers["Authorization"] != "Bearer token" {
			t.Errorf("Expected Authorization header, got %v", jsonConfig.Headers)
		}

		// Test auto-detect protocol
		protocol := jsonConfig.Protocol
		if protocol == "" {
			if jsonConfig.URL != "" {
				protocol = "streamable-http"
			}
		}
		if protocol != "streamable-http" {
			t.Errorf("Expected auto-detected protocol 'streamable-http', got %s", protocol)
		}
	})

	t.Run("parses valid stdio JSON config", func(t *testing.T) {
		jsonStr := `{"command":"uvx","args":["mcp-server-sqlite","--db","mydb.db"],"env":{"DEBUG":"1"}}`

		var jsonConfig struct {
			URL        string            `json:"url"`
			Command    string            `json:"command"`
			Args       []string          `json:"args"`
			Env        map[string]string `json:"env"`
			Headers    map[string]string `json:"headers"`
			WorkingDir string            `json:"working_dir"`
			Protocol   string            `json:"protocol"`
		}

		err := json.Unmarshal([]byte(jsonStr), &jsonConfig)
		if err != nil {
			t.Errorf("Failed to parse JSON: %v", err)
		}

		if jsonConfig.Command != "uvx" {
			t.Errorf("Expected command 'uvx', got %s", jsonConfig.Command)
		}
		if len(jsonConfig.Args) != 3 {
			t.Errorf("Expected 3 args, got %d", len(jsonConfig.Args))
		}
		if jsonConfig.Env["DEBUG"] != "1" {
			t.Errorf("Expected DEBUG env, got %v", jsonConfig.Env)
		}

		// Test auto-detect protocol
		protocol := jsonConfig.Protocol
		if protocol == "" {
			if jsonConfig.Command != "" {
				protocol = "stdio"
			}
		}
		if protocol != "stdio" {
			t.Errorf("Expected auto-detected protocol 'stdio', got %s", protocol)
		}
	})

	t.Run("rejects invalid JSON", func(t *testing.T) {
		// T041: Unit test: add-json with invalid JSON returns error
		invalidJSONs := []struct {
			name     string
			jsonStr  string
			errMatch string
		}{
			{"malformed", `{invalid json}`, "invalid character"},
			{"unclosed brace", `{"url": "test"`, "unexpected end"},
			{"not an object", `["array", "not", "object"]`, "cannot unmarshal"},
		}

		for _, tc := range invalidJSONs {
			t.Run(tc.name, func(t *testing.T) {
				var jsonConfig struct {
					URL     string `json:"url"`
					Command string `json:"command"`
				}

				err := json.Unmarshal([]byte(tc.jsonStr), &jsonConfig)
				if err == nil {
					t.Errorf("Expected error for invalid JSON: %s", tc.jsonStr)
				}
				if !strings.Contains(err.Error(), tc.errMatch) {
					t.Errorf("Expected error containing '%s', got: %v", tc.errMatch, err)
				}
			})
		}
	})

	t.Run("rejects JSON without url or command", func(t *testing.T) {
		jsonStr := `{"headers":{"X-Key":"value"}}`

		var jsonConfig struct {
			URL     string `json:"url"`
			Command string `json:"command"`
		}

		err := json.Unmarshal([]byte(jsonStr), &jsonConfig)
		if err != nil {
			t.Fatalf("Failed to parse JSON: %v", err)
		}

		// Validate that either url or command is required
		if jsonConfig.URL == "" && jsonConfig.Command == "" {
			// This is the expected validation error
			return
		}
		t.Error("Expected validation to require either 'url' or 'command'")
	})
}

// ============================================================================
// Confirmation Prompt Tests (for documentation)
// ============================================================================

func TestConfirmationPromptBehavior(t *testing.T) {
	// The promptConfirmation function reads from stdin, which is difficult to test directly.
	// These tests document the expected behavior.

	t.Run("yes flag skips confirmation", func(t *testing.T) {
		// When --yes flag is set, confirmation prompt should not appear
		// Tested via integration with upstreamRemoveYes flag
		// The upstreamRemoveYes flag defaults to false
		_ = upstreamRemoveYes // Reference to avoid unused warning; value is checked by cobra integration
	})

	t.Run("y flag also skips confirmation", func(t *testing.T) {
		// -y should work the same as --yes
		// Both set upstreamRemoveYes to true
		// This is tested via cobra flag binding
	})
}

// ============================================================================
// Server Quarantine Tests
// ============================================================================

func TestNewServerQuarantineDefault(t *testing.T) {
	t.Run("new server is quarantined by default", func(t *testing.T) {
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "mcp_config.json")

		initialConfig := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "` + jsonEscapePath(tmpDir) + `",
			"mcpServers": []
		}`
		err := os.WriteFile(configPath, []byte(initialConfig), 0644)
		if err != nil {
			t.Fatalf("Failed to write initial config: %v", err)
		}

		req := &cliclient.AddServerRequest{
			Name:     "new-server",
			URL:      "https://example.com/mcp",
			Protocol: "http",
		}

		cfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load config: %v", err)
		}
		cfg.DataDir = tmpDir

		// Capture output
		oldStdout := os.Stdout
		r, w, _ := os.Pipe()
		os.Stdout = w

		err = runUpstreamAddConfigMode(req, cfg)

		w.Close()
		os.Stdout = oldStdout
		var buf bytes.Buffer
		buf.ReadFrom(r)
		output := buf.String()

		if err != nil {
			t.Fatalf("runUpstreamAddConfigMode() error = %v", err)
		}

		// Verify quarantine message appears
		if !strings.Contains(output, "quarantined") {
			t.Error("Expected quarantine warning in output")
		}

		// Verify config
		updatedCfg, err := config.LoadFromFile(configPath)
		if err != nil {
			t.Fatalf("Failed to load updated config: %v", err)
		}
		if len(updatedCfg.Servers) != 1 {
			t.Fatalf("Expected 1 server, got %d", len(updatedCfg.Servers))
		}
		if !updatedCfg.Servers[0].Quarantined {
			t.Error("New server should be quarantined by default")
		}
	})
}
