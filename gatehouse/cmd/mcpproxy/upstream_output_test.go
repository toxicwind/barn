package main

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
)

func TestOutputServers_TableFormat(t *testing.T) {
	servers := []map[string]interface{}{
		{
			"name":       "github-server",
			"enabled":    true,
			"protocol":   "http",
			"connected":  true,
			"tool_count": 15,
			"status":     "connected",
		},
		{
			"name":       "ast-grep",
			"enabled":    false,
			"protocol":   "stdio",
			"connected":  false,
			"tool_count": 0,
			"status":     "disabled",
		},
	}

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	// Use global output format (default is "table")
	globalOutputFormat = "table"
	globalJSONOutput = false
	err := outputServers(servers)

	w.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r)
	output := buf.String()

	if err != nil {
		t.Errorf("outputServers() returned error: %v", err)
	}

	// Verify table headers (new unified health status format)
	if !strings.Contains(output, "NAME") {
		t.Error("Table output missing NAME header")
	}
	if !strings.Contains(output, "PROTOCOL") {
		t.Error("Table output missing PROTOCOL header")
	}
	if !strings.Contains(output, "TOOLS") {
		t.Error("Table output missing TOOLS header")
	}
	if !strings.Contains(output, "STATUS") {
		t.Error("Table output missing STATUS header")
	}
	if !strings.Contains(output, "ACTION") {
		t.Error("Table output missing ACTION header")
	}

	// Verify server data
	if !strings.Contains(output, "github-server") {
		t.Error("Table output missing server name: github-server")
	}
	if !strings.Contains(output, "ast-grep") {
		t.Error("Table output missing server name: ast-grep")
	}
}

func TestOutputServers_JSONFormat(t *testing.T) {
	servers := []map[string]interface{}{
		{
			"name":       "test-server",
			"enabled":    true,
			"protocol":   "stdio",
			"connected":  false,
			"tool_count": 5,
			"status":     "disconnected",
		},
	}

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	// Use global output format for JSON
	globalOutputFormat = "json"
	globalJSONOutput = false
	err := outputServers(servers)

	w.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r)
	output := buf.String()

	if err != nil {
		t.Errorf("outputServers() returned error: %v", err)
	}

	// Verify valid JSON
	var parsed []map[string]interface{}
	if err := json.Unmarshal([]byte(output), &parsed); err != nil {
		t.Errorf("JSON output is invalid: %v", err)
	}

	// Verify data
	if len(parsed) != 1 {
		t.Errorf("Expected 1 server in JSON output, got %d", len(parsed))
	}
	if parsed[0]["name"] != "test-server" {
		t.Errorf("Expected server name 'test-server', got %v", parsed[0]["name"])
	}
}

func TestOutputServers_InvalidFormat(t *testing.T) {
	servers := []map[string]interface{}{
		{"name": "test"},
	}

	// Use global output format for invalid format test
	globalOutputFormat = "invalid-format"
	globalJSONOutput = false
	err := outputServers(servers)

	if err == nil {
		t.Error("outputServers() should return error for invalid format")
	}
	if !strings.Contains(err.Error(), "unknown output format") {
		t.Errorf("Expected error about unknown format, got: %v", err)
	}
}

func TestOutputServers_Sorting(t *testing.T) {
	servers := []map[string]interface{}{
		{"name": "zebra-server", "enabled": true, "protocol": "http", "connected": true, "tool_count": 1, "status": "ok"},
		{"name": "alpha-server", "enabled": true, "protocol": "http", "connected": true, "tool_count": 1, "status": "ok"},
		{"name": "beta-server", "enabled": true, "protocol": "http", "connected": true, "tool_count": 1, "status": "ok"},
	}

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	// Use global output format for JSON
	globalOutputFormat = "json"
	globalJSONOutput = false
	err := outputServers(servers)

	w.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r)
	output := buf.String()

	if err != nil {
		t.Errorf("outputServers() returned error: %v", err)
	}

	// Parse JSON to verify order
	var parsed []map[string]interface{}
	if err := json.Unmarshal([]byte(output), &parsed); err != nil {
		t.Errorf("Failed to parse JSON: %v", err)
	}

	// Verify alphabetical order
	if len(parsed) != 3 {
		t.Fatalf("Expected 3 servers, got %d", len(parsed))
	}
	if parsed[0]["name"] != "alpha-server" {
		t.Errorf("Expected first server to be 'alpha-server', got %v", parsed[0]["name"])
	}
	if parsed[1]["name"] != "beta-server" {
		t.Errorf("Expected second server to be 'beta-server', got %v", parsed[1]["name"])
	}
	if parsed[2]["name"] != "zebra-server" {
		t.Errorf("Expected third server to be 'zebra-server', got %v", parsed[2]["name"])
	}
}

func TestOutputServers_EmptyList(t *testing.T) {
	servers := []map[string]interface{}{}

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	// Use global output format (default is "table")
	globalOutputFormat = "table"
	globalJSONOutput = false
	err := outputServers(servers)

	w.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r)
	output := buf.String()

	if err != nil {
		t.Errorf("outputServers() returned error: %v", err)
	}

	// With new unified formatter, empty tables show "No results found" message
	if !strings.Contains(output, "No results found") {
		t.Error("Empty table should show 'No results found' message")
	}
}

func TestOutputServers_BooleanFields(t *testing.T) {
	// Test that unified health status is displayed correctly based on server state
	tests := []struct {
		name          string
		healthLevel   string
		adminState    string
		expectedEmoji string
	}{
		{"healthy enabled", "healthy", "enabled", "✅"},
		{"disabled", "healthy", "disabled", "⏸️"},
		{"quarantined", "healthy", "quarantined", "🔒"},
		{"unhealthy", "unhealthy", "enabled", "❌"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			servers := []map[string]interface{}{
				{
					"name":       "test-server",
					"protocol":   "stdio",
					"tool_count": 0,
					"health": map[string]interface{}{
						"level":       tt.healthLevel,
						"admin_state": tt.adminState,
						"summary":     "Test status",
						"action":      "",
					},
				},
			}

			// Capture stdout
			oldStdout := os.Stdout
			r, w, _ := os.Pipe()
			os.Stdout = w
			defer func() { os.Stdout = oldStdout }()

			// Use global output format for table
			globalOutputFormat = "table"
			globalJSONOutput = false
			err := outputServers(servers)

			w.Close()
			var buf bytes.Buffer
			buf.ReadFrom(r)
			output := buf.String()

			if err != nil {
				t.Errorf("outputServers() returned error: %v", err)
			}

			// Verify health status emoji is displayed
			if !strings.Contains(output, tt.expectedEmoji) {
				t.Errorf("Expected emoji '%s' for %s, output: %s", tt.expectedEmoji, tt.name, output)
			}
		})
	}
}

func TestOutputServers_IntegerFields(t *testing.T) {
	servers := []map[string]interface{}{
		{
			"name":       "server-zero",
			"enabled":    true,
			"protocol":   "http",
			"connected":  true,
			"tool_count": 0,
			"status":     "ok",
		},
		{
			"name":       "server-many",
			"enabled":    true,
			"protocol":   "http",
			"connected":  true,
			"tool_count": 42,
			"status":     "ok",
		},
	}

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	// Use global output format (default is "table")
	globalOutputFormat = "table"
	globalJSONOutput = false
	err := outputServers(servers)

	w.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r)
	output := buf.String()

	if err != nil {
		t.Errorf("outputServers() returned error: %v", err)
	}

	// Verify tool counts appear in output
	if !strings.Contains(output, "0") {
		t.Error("Output should contain tool count 0")
	}
	if !strings.Contains(output, "42") {
		t.Error("Output should contain tool count 42")
	}
}

func TestOutputServers_StatusMessages(t *testing.T) {
	servers := []map[string]interface{}{
		{
			"name":       "server1",
			"enabled":    true,
			"protocol":   "http",
			"connected":  false,
			"tool_count": 0,
			"status":     "connection failed: timeout",
		},
		{
			"name":       "server2",
			"enabled":    false,
			"protocol":   "stdio",
			"connected":  false,
			"tool_count": 0,
			"status":     "disabled by user",
		},
	}

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	defer func() { os.Stdout = oldStdout }()

	// Use global output format (default is "table")
	globalOutputFormat = "table"
	globalJSONOutput = false
	err := outputServers(servers)

	w.Close()
	var buf bytes.Buffer
	buf.ReadFrom(r)
	output := buf.String()

	if err != nil {
		t.Errorf("outputServers() returned error: %v", err)
	}

	// Verify status messages appear
	if !strings.Contains(output, "connection failed") {
		t.Error("Output should contain status message")
	}
	if !strings.Contains(output, "disabled") {
		t.Error("Output should contain disabled status")
	}
}

// T021: Test that CLI prints request_id on error
func TestOutputError_WithRequestID(t *testing.T) {
	t.Run("prints request_id when APIError has one", func(t *testing.T) {
		// Capture stderr
		oldStderr := os.Stderr
		r, w, _ := os.Pipe()
		os.Stderr = w
		defer func() { os.Stderr = oldStderr }()

		// Set table format (human-readable output)
		globalOutputFormat = "table"
		globalJSONOutput = false

		// Create an APIError with request_id
		apiErr := &cliclient.APIError{
			Message:   "server not found",
			RequestID: "test-request-id-12345",
		}

		// Call outputError
		_ = outputError(apiErr, "SERVER_NOT_FOUND")

		w.Close()
		var buf bytes.Buffer
		buf.ReadFrom(r)
		output := buf.String()

		// Verify request_id is printed
		if !strings.Contains(output, "test-request-id-12345") {
			t.Errorf("Expected output to contain request_id 'test-request-id-12345', got: %s", output)
		}

		// Verify suggestion to use activity list
		if !strings.Contains(output, "mcpproxy activity list --request-id") {
			t.Errorf("Expected output to contain activity list suggestion, got: %s", output)
		}
	})

	t.Run("JSON output includes request_id field", func(t *testing.T) {
		// Capture stdout (JSON/YAML goes to stdout)
		oldStdout := os.Stdout
		r, w, _ := os.Pipe()
		os.Stdout = w
		defer func() { os.Stdout = oldStdout }()

		// Set JSON format
		globalOutputFormat = "json"
		globalJSONOutput = true

		// Create an APIError with request_id
		apiErr := &cliclient.APIError{
			Message:   "server not found",
			RequestID: "json-request-id-67890",
		}

		// Call outputError
		_ = outputError(apiErr, "SERVER_NOT_FOUND")

		w.Close()
		var buf bytes.Buffer
		buf.ReadFrom(r)
		output := buf.String()

		// Verify JSON output contains request_id
		var jsonOutput map[string]interface{}
		if err := json.Unmarshal([]byte(output), &jsonOutput); err != nil {
			t.Fatalf("Failed to parse JSON output: %v (output was: %s)", err, output)
		}

		requestID, ok := jsonOutput["request_id"].(string)
		if !ok {
			t.Errorf("Expected JSON to contain request_id field, got: %v", jsonOutput)
		}
		if requestID != "json-request-id-67890" {
			t.Errorf("Expected request_id 'json-request-id-67890', got: %s", requestID)
		}
	})
}

// T022: Test that CLI does NOT print request_id on success
func TestOutputError_WithoutRequestID(t *testing.T) {
	t.Run("does not print request_id when APIError has none", func(t *testing.T) {
		// Capture stderr
		oldStderr := os.Stderr
		r, w, _ := os.Pipe()
		os.Stderr = w
		defer func() { os.Stderr = oldStderr }()

		// Set table format
		globalOutputFormat = "table"
		globalJSONOutput = false

		// Create an APIError without request_id
		apiErr := &cliclient.APIError{
			Message:   "server not found",
			RequestID: "", // Empty request_id
		}

		// Call outputError
		_ = outputError(apiErr, "SERVER_NOT_FOUND")

		w.Close()
		var buf bytes.Buffer
		buf.ReadFrom(r)
		output := buf.String()

		// Verify "Request ID:" is NOT printed
		if strings.Contains(output, "Request ID:") {
			t.Errorf("Expected output to NOT contain 'Request ID:' when request_id is empty, got: %s", output)
		}

		// Verify error message is still printed
		if !strings.Contains(output, "server not found") {
			t.Errorf("Expected output to contain error message, got: %s", output)
		}
	})

	t.Run("does not print request_id for regular errors", func(t *testing.T) {
		// Capture stderr
		oldStderr := os.Stderr
		r, w, _ := os.Pipe()
		os.Stderr = w
		defer func() { os.Stderr = oldStderr }()

		// Set table format
		globalOutputFormat = "table"
		globalJSONOutput = false

		// Create a regular error (not APIError)
		regularErr := os.ErrNotExist

		// Call outputError
		_ = outputError(regularErr, "FILE_NOT_FOUND")

		w.Close()
		var buf bytes.Buffer
		buf.ReadFrom(r)
		output := buf.String()

		// Verify "Request ID:" is NOT printed
		if strings.Contains(output, "Request ID:") {
			t.Errorf("Expected output to NOT contain 'Request ID:' for regular errors, got: %s", output)
		}
	})
}

// TestOutputSkipNotice verifies the CLI-JSON contract for --if-not-exists /
// --if-exists skip paths: the human notice goes to stderr, and in json mode
// stdout carries a structured skip object (parseable by jq); in table mode
// stdout stays empty.
func TestOutputSkipNotice(t *testing.T) {
	capture := func(t *testing.T, format string) (stdoutStr, stderrStr string) {
		t.Helper()
		oldStdout := os.Stdout
		oldStderr := os.Stderr
		rOut, wOut, _ := os.Pipe()
		rErr, wErr, _ := os.Pipe()
		os.Stdout = wOut
		os.Stderr = wErr

		oldFormat := globalOutputFormat
		oldJSON := globalJSONOutput
		globalOutputFormat = format
		globalJSONOutput = false
		t.Cleanup(func() {
			globalOutputFormat = oldFormat
			globalJSONOutput = oldJSON
		})

		err := outputSkipNotice("Server 'foo' already exists (skipped)", map[string]interface{}{
			"name":    "foo",
			"skipped": true,
		})

		wOut.Close()
		wErr.Close()
		os.Stdout = oldStdout
		os.Stderr = oldStderr

		if err != nil {
			t.Fatalf("outputSkipNotice returned error: %v", err)
		}

		var bufOut, bufErr bytes.Buffer
		bufOut.ReadFrom(rOut)
		bufErr.ReadFrom(rErr)
		return bufOut.String(), bufErr.String()
	}

	t.Run("json mode emits structured object on stdout, notice on stderr", func(t *testing.T) {
		stdoutStr, stderrStr := capture(t, "json")

		var parsed map[string]interface{}
		if err := json.Unmarshal([]byte(stdoutStr), &parsed); err != nil {
			t.Fatalf("stdout must be valid JSON, got %q: %v", stdoutStr, err)
		}
		if parsed["name"] != "foo" || parsed["skipped"] != true {
			t.Errorf("unexpected skip payload: %v", parsed)
		}
		if !strings.Contains(stderrStr, "already exists (skipped)") {
			t.Errorf("human notice must be on stderr, got %q", stderrStr)
		}
	})

	t.Run("table mode keeps stdout empty, notice on stderr", func(t *testing.T) {
		stdoutStr, stderrStr := capture(t, "table")

		if stdoutStr != "" {
			t.Errorf("table-mode skip must not write to stdout, got %q", stdoutStr)
		}
		if !strings.Contains(stderrStr, "already exists (skipped)") {
			t.Errorf("human notice must be on stderr, got %q", stderrStr)
		}
	})
}
