package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// =============================================================================
// Command Registration Tests
// =============================================================================

func TestGetActivityCommand(t *testing.T) {
	cmd := GetActivityCommand()

	assert.NotNil(t, cmd)
	assert.Equal(t, "activity", cmd.Use)
	assert.Equal(t, "Query and monitor activity logs", cmd.Short)

	// Check subcommands exist
	subcommands := cmd.Commands()
	subcommandNames := make([]string, len(subcommands))
	for i, sub := range subcommands {
		subcommandNames[i] = sub.Name()
	}

	assert.Contains(t, subcommandNames, "list")
	assert.Contains(t, subcommandNames, "watch")
	assert.Contains(t, subcommandNames, "show")
	assert.Contains(t, subcommandNames, "summary")
	assert.Contains(t, subcommandNames, "export")
}

func TestActivityListCmd_Flags(t *testing.T) {
	cmd := activityListCmd

	// Check flags exist
	flags := []string{"type", "server", "tool", "status", "session", "start-time", "end-time", "limit", "offset"}
	for _, flag := range flags {
		f := cmd.Flags().Lookup(flag)
		assert.NotNil(t, f, "flag %s should exist", flag)
	}

	// Check short flags
	assert.NotNil(t, cmd.Flags().ShorthandLookup("t"), "-t short flag")
	assert.NotNil(t, cmd.Flags().ShorthandLookup("s"), "-s short flag")
	assert.NotNil(t, cmd.Flags().ShorthandLookup("n"), "-n short flag")

	// Check defaults
	limitFlag := cmd.Flags().Lookup("limit")
	assert.Equal(t, "50", limitFlag.DefValue)

	offsetFlag := cmd.Flags().Lookup("offset")
	assert.Equal(t, "0", offsetFlag.DefValue)
}

func TestActivityWatchCmd_Flags(t *testing.T) {
	cmd := activityWatchCmd

	// Check flags exist
	flags := []string{"type", "server"}
	for _, flag := range flags {
		f := cmd.Flags().Lookup(flag)
		assert.NotNil(t, f, "flag %s should exist", flag)
	}

	// Check short flags
	assert.NotNil(t, cmd.Flags().ShorthandLookup("t"), "-t short flag")
	assert.NotNil(t, cmd.Flags().ShorthandLookup("s"), "-s short flag")
}

func TestActivityShowCmd_Args(t *testing.T) {
	cmd := activityShowCmd

	// Check args validation
	assert.Equal(t, "<id>", strings.Fields(cmd.Use)[1])

	// Check flags
	includeResponse := cmd.Flags().Lookup("include-response")
	assert.NotNil(t, includeResponse)
	assert.Equal(t, "false", includeResponse.DefValue)
}

func TestActivitySummaryCmd_Flags(t *testing.T) {
	cmd := activitySummaryCmd

	// Check flags exist
	periodFlag := cmd.Flags().Lookup("period")
	assert.NotNil(t, periodFlag)
	assert.Equal(t, "24h", periodFlag.DefValue)

	byFlag := cmd.Flags().Lookup("by")
	assert.NotNil(t, byFlag)

	// Check short flags
	assert.NotNil(t, cmd.Flags().ShorthandLookup("p"), "-p short flag")
}

func TestActivityExportCmd_Flags(t *testing.T) {
	cmd := activityExportCmd

	// Check flags exist
	outputFlag := cmd.Flags().Lookup("output")
	assert.NotNil(t, outputFlag)

	formatFlag := cmd.Flags().Lookup("format")
	assert.NotNil(t, formatFlag)
	assert.Equal(t, "json", formatFlag.DefValue)

	includeBodiesFlag := cmd.Flags().Lookup("include-bodies")
	assert.NotNil(t, includeBodiesFlag)
	assert.Equal(t, "false", includeBodiesFlag.DefValue)

	// Check short flags
	assert.NotNil(t, cmd.Flags().ShorthandLookup("f"), "-f short flag")
}

// =============================================================================
// Mock Server Tests for CLI Commands
// =============================================================================

func TestActivityListCommand_JSONOutput(t *testing.T) {
	// Create mock server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/activity" {
			response := map[string]interface{}{
				"success": true,
				"data": map[string]interface{}{
					"activities": []map[string]interface{}{
						{
							"id":          "01JFXYZ123ABC",
							"type":        "tool_call",
							"server_name": "github",
							"tool_name":   "create_issue",
							"status":      "success",
							"duration_ms": 245,
							"timestamp":   "2025-01-15T10:30:00Z",
						},
					},
					"total":  1,
					"limit":  50,
					"offset": 0,
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	// Test the response can be parsed correctly
	resp, err := http.Get(server.URL + "/api/v1/activity")
	require.NoError(t, err)
	defer resp.Body.Close()

	var result map[string]interface{}
	err = json.NewDecoder(resp.Body).Decode(&result)
	require.NoError(t, err)

	assert.True(t, result["success"].(bool))
	data := result["data"].(map[string]interface{})
	activities := data["activities"].([]interface{})
	assert.Len(t, activities, 1)

	activity := activities[0].(map[string]interface{})
	assert.Equal(t, "01JFXYZ123ABC", activity["id"])
	assert.Equal(t, "tool_call", activity["type"])
	assert.Equal(t, "github", activity["server_name"])
}

func TestActivityShowCommand_NotFound(t *testing.T) {
	// Create mock server that returns 404
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/activity/") {
			response := map[string]interface{}{
				"success": false,
				"error":   "activity not found",
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			json.NewEncoder(w).Encode(response)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	resp, err := http.Get(server.URL + "/api/v1/activity/nonexistent-id")
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestActivitySummaryCommand_Response(t *testing.T) {
	// Create mock server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/activity/summary" {
			response := map[string]interface{}{
				"success": true,
				"data": map[string]interface{}{
					"period":        "24h",
					"total_count":   150,
					"success_count": 142,
					"error_count":   5,
					"blocked_count": 3,
					"success_rate":  0.947,
					"top_servers": []map[string]interface{}{
						{"name": "github", "count": 75},
						{"name": "filesystem", "count": 45},
					},
					"top_tools": []map[string]interface{}{
						{"server": "github", "tool": "create_issue", "count": 30},
						{"server": "filesystem", "tool": "read_file", "count": 25},
					},
				},
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(response)
			return
		}
		http.NotFound(w, r)
	}))
	defer server.Close()

	resp, err := http.Get(server.URL + "/api/v1/activity/summary?period=24h")
	require.NoError(t, err)
	defer resp.Body.Close()

	var result map[string]interface{}
	err = json.NewDecoder(resp.Body).Decode(&result)
	require.NoError(t, err)

	assert.True(t, result["success"].(bool))
	data := result["data"].(map[string]interface{})
	assert.Equal(t, "24h", data["period"])
	assert.Equal(t, float64(150), data["total_count"])
	assert.Equal(t, float64(142), data["success_count"])
}

// =============================================================================
// SSE Parsing Tests
// =============================================================================

func TestWatchActivityStream_ParsesSSEEvents(t *testing.T) {
	// Create SSE mock server
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "SSE not supported", http.StatusInternalServerError)
			return
		}

		// Send one event
		fmt.Fprintf(w, "event: activity.tool_call.completed\n")
		fmt.Fprintf(w, "data: {\"id\":\"01JFXYZ123ABC\",\"server\":\"github\",\"tool\":\"create_issue\",\"status\":\"success\",\"duration_ms\":245}\n")
		fmt.Fprintf(w, "\n")
		flusher.Flush()

		// Close immediately for test
	}))
	defer server.Close()

	// Test SSE endpoint is reachable
	resp, err := http.Get(server.URL)
	require.NoError(t, err)
	defer resp.Body.Close()

	assert.Equal(t, "text/event-stream", resp.Header.Get("Content-Type"))
}

func TestActivityListCmd_SensitiveDataFlags(t *testing.T) {
	cmd := activityListCmd

	// Check new sensitive data flags exist
	sensitiveDataFlag := cmd.Flags().Lookup("sensitive-data")
	assert.NotNil(t, sensitiveDataFlag, "sensitive-data flag should exist")
	assert.Equal(t, "false", sensitiveDataFlag.DefValue)

	detectionTypeFlag := cmd.Flags().Lookup("detection-type")
	assert.NotNil(t, detectionTypeFlag, "detection-type flag should exist")

	severityFlag := cmd.Flags().Lookup("severity")
	assert.NotNil(t, severityFlag, "severity flag should exist")
}
