package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
)

// =============================================================================
// Helper Function Tests
// =============================================================================

func TestFormatRelativeTime(t *testing.T) {
	now := time.Now()

	tests := []struct {
		name     string
		time     time.Time
		expected string
	}{
		{
			name:     "just now - 0 seconds ago",
			time:     now,
			expected: "just now",
		},
		{
			name:     "just now - 30 seconds ago",
			time:     now.Add(-30 * time.Second),
			expected: "just now",
		},
		{
			name:     "1 minute ago",
			time:     now.Add(-1 * time.Minute),
			expected: "1 minute ago",
		},
		{
			name:     "5 minutes ago",
			time:     now.Add(-5 * time.Minute),
			expected: "5 minutes ago",
		},
		{
			name:     "1 hour ago",
			time:     now.Add(-1 * time.Hour),
			expected: "1 hour ago",
		},
		{
			name:     "3 hours ago",
			time:     now.Add(-3 * time.Hour),
			expected: "3 hours ago",
		},
		{
			name:     "1 day ago",
			time:     now.Add(-24 * time.Hour),
			expected: "1 day ago",
		},
		{
			name:     "5 days ago",
			time:     now.Add(-5 * 24 * time.Hour),
			expected: "5 days ago",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatRelativeTime(tt.time)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestFormatRelativeTime_OlderDates(t *testing.T) {
	now := time.Now()

	// Test same year but more than 7 days ago
	twoWeeksAgo := now.Add(-14 * 24 * time.Hour)
	result := formatRelativeTime(twoWeeksAgo)
	assert.Contains(t, result, twoWeeksAgo.Format("Jan"))

	// Test different year
	lastYear := now.AddDate(-1, 0, 0)
	result = formatRelativeTime(lastYear)
	assert.Contains(t, result, fmt.Sprintf("%d", lastYear.Year()))
}

func TestFormatActivityDuration(t *testing.T) {
	tests := []struct {
		name     string
		ms       int64
		expected string
	}{
		{
			name:     "0 milliseconds",
			ms:       0,
			expected: "0ms",
		},
		{
			name:     "100 milliseconds",
			ms:       100,
			expected: "100ms",
		},
		{
			name:     "999 milliseconds",
			ms:       999,
			expected: "999ms",
		},
		{
			name:     "1000 milliseconds - 1 second",
			ms:       1000,
			expected: "1.0s",
		},
		{
			name:     "1500 milliseconds",
			ms:       1500,
			expected: "1.5s",
		},
		{
			name:     "12345 milliseconds",
			ms:       12345,
			expected: "12.3s",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := formatActivityDuration(tt.ms)
			assert.Equal(t, tt.expected, result)
		})
	}
}

// =============================================================================
// Output Formatting Tests
// =============================================================================

func TestDisplayActivityEvent_JSONOutput(t *testing.T) {
	// SSE events wrap the payload in {"payload": ..., "timestamp": ...}
	eventData := `{"payload":{"id":"01JFXYZ123ABC","server_name":"github","tool_name":"create_issue","status":"success","duration_ms":245},"timestamp":1234567890}`

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	displayActivityEvent("activity.tool_call.completed", eventData, "json")

	w.Close()
	os.Stdout = oldStdout

	var buf bytes.Buffer
	io.Copy(&buf, r)
	output := buf.String()

	// JSON output should just pass through the event data
	assert.Contains(t, output, eventData)
}

func TestDisplayActivityEvent_TableOutput(t *testing.T) {
	// SSE events wrap the payload in {"payload": ..., "timestamp": ...}
	eventData := `{"payload":{"id":"01JFXYZ123ABC","server_name":"github","tool_name":"create_issue","status":"success","duration_ms":245},"timestamp":1234567890}`

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	displayActivityEvent("activity.tool_call.completed", eventData, "table")

	w.Close()
	os.Stdout = oldStdout

	var buf bytes.Buffer
	io.Copy(&buf, r)
	output := buf.String()

	// Table output should contain server:tool and status indicator
	assert.Contains(t, output, "github:create_issue")
	assert.Contains(t, output, "245ms")
}

func TestDisplayActivityEvent_FilteredByServer(t *testing.T) {
	// SSE events wrap the payload in {"payload": ..., "timestamp": ...}
	eventData := `{"payload":{"id":"01JFXYZ123ABC","server_name":"filesystem","tool_name":"read_file","status":"success","duration_ms":100},"timestamp":1234567890}`

	// Set server filter
	oldServer := activityServer
	activityServer = "github" // Filter for github only
	defer func() { activityServer = oldServer }()

	// Capture stdout
	oldStdout := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w

	displayActivityEvent("activity.tool_call.completed", eventData, "table")

	w.Close()
	os.Stdout = oldStdout

	var buf bytes.Buffer
	io.Copy(&buf, r)
	output := buf.String()

	// Event should be filtered out (no output)
	assert.Empty(t, strings.TrimSpace(output))
}

// =============================================================================
// Error Message Tests
// =============================================================================

func TestOutputActivityError_TableFormat(t *testing.T) {
	// Capture stderr
	oldStderr := os.Stderr
	r, w, _ := os.Pipe()
	os.Stderr = w

	err := fmt.Errorf("test error message")
	outputActivityError(err, "TEST_ERROR")

	w.Close()
	os.Stderr = oldStderr

	var buf bytes.Buffer
	io.Copy(&buf, r)
	output := buf.String()

	assert.Contains(t, output, "Error: test error message")
	assert.Contains(t, output, "Hint:")
}

// =============================================================================
// Sensitive Data Detection Tests (Spec 026)
// =============================================================================

func TestFormatSensitiveDataIndicator(t *testing.T) {
	tests := []struct {
		name     string
		activity map[string]interface{}
		noIcons  bool
		expected string
	}{
		{
			name:     "no metadata",
			activity: map[string]interface{}{},
			expected: "-",
		},
		{
			name: "no sensitive_data_detection in metadata",
			activity: map[string]interface{}{
				"metadata": map[string]interface{}{},
			},
			expected: "-",
		},
		{
			name: "detected is false",
			activity: map[string]interface{}{
				"metadata": map[string]interface{}{
					"sensitive_data_detection": map[string]interface{}{
						"detected": false,
					},
				},
			},
			expected: "-",
		},
		{
			name: "detected is true - with icons",
			activity: map[string]interface{}{
				"metadata": map[string]interface{}{
					"sensitive_data_detection": map[string]interface{}{
						"detected": true,
					},
				},
			},
			noIcons:  false,
			expected: "⚠️",
		},
		{
			name: "detected is true - no icons",
			activity: map[string]interface{}{
				"metadata": map[string]interface{}{
					"sensitive_data_detection": map[string]interface{}{
						"detected": true,
					},
				},
			},
			noIcons:  true,
			expected: "SENSITIVE",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set the no-icons flag
			oldNoIcons := activityNoIcons
			activityNoIcons = tt.noIcons
			defer func() { activityNoIcons = oldNoIcons }()

			result := formatSensitiveDataIndicator(tt.activity)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestGetSensitiveDataDetection(t *testing.T) {
	tests := []struct {
		name     string
		activity map[string]interface{}
		hasData  bool
	}{
		{
			name:     "no metadata",
			activity: map[string]interface{}{},
			hasData:  false,
		},
		{
			name: "no sensitive_data_detection",
			activity: map[string]interface{}{
				"metadata": map[string]interface{}{},
			},
			hasData: false,
		},
		{
			name: "has sensitive_data_detection",
			activity: map[string]interface{}{
				"metadata": map[string]interface{}{
					"sensitive_data_detection": map[string]interface{}{
						"detected":   true,
						"detections": []interface{}{},
					},
				},
			},
			hasData: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := getSensitiveDataDetection(tt.activity)
			if tt.hasData {
				assert.NotNil(t, result)
			} else {
				assert.Nil(t, result)
			}
		})
	}
}

func TestGetMaxSeverity(t *testing.T) {
	tests := []struct {
		name       string
		detections []interface{}
		expected   string
	}{
		{
			name:       "empty detections",
			detections: []interface{}{},
			expected:   "",
		},
		{
			name: "single detection",
			detections: []interface{}{
				map[string]interface{}{"severity": "high"},
			},
			expected: "high",
		},
		{
			name: "critical is highest",
			detections: []interface{}{
				map[string]interface{}{"severity": "low"},
				map[string]interface{}{"severity": "critical"},
				map[string]interface{}{"severity": "high"},
			},
			expected: "critical",
		},
		{
			name: "high is higher than medium",
			detections: []interface{}{
				map[string]interface{}{"severity": "medium"},
				map[string]interface{}{"severity": "high"},
				map[string]interface{}{"severity": "low"},
			},
			expected: "high",
		},
		{
			name: "all low",
			detections: []interface{}{
				map[string]interface{}{"severity": "low"},
				map[string]interface{}{"severity": "low"},
			},
			expected: "low",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := getMaxSeverity(tt.detections)
			assert.Equal(t, tt.expected, result)
		})
	}
}

func TestFormatSeverityWithColor(t *testing.T) {
	tests := []struct {
		name     string
		severity string
		noIcons  bool
		contains string
	}{
		{
			name:     "critical with icons",
			severity: "critical",
			noIcons:  false,
			contains: "critical",
		},
		{
			name:     "high with icons",
			severity: "high",
			noIcons:  false,
			contains: "high",
		},
		{
			name:     "medium with icons",
			severity: "medium",
			noIcons:  false,
			contains: "medium",
		},
		{
			name:     "low with icons",
			severity: "low",
			noIcons:  false,
			contains: "low",
		},
		{
			name:     "critical no icons",
			severity: "critical",
			noIcons:  true,
			contains: "critical",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			oldNoIcons := activityNoIcons
			activityNoIcons = tt.noIcons
			defer func() { activityNoIcons = oldNoIcons }()

			result := formatSeverityWithColor(tt.severity)
			assert.Contains(t, result, tt.contains)
		})
	}
}
