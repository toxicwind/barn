package main

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// =============================================================================
// ActivityFilter Tests
// =============================================================================

func TestActivityFilter_Validate_ValidInputs(t *testing.T) {
	tests := []struct {
		name   string
		filter ActivityFilter
	}{
		{
			name:   "empty filter",
			filter: ActivityFilter{},
		},
		{
			name: "valid type - tool_call",
			filter: ActivityFilter{
				Type: "tool_call",
			},
		},
		{
			name: "valid type - policy_decision",
			filter: ActivityFilter{
				Type: "policy_decision",
			},
		},
		{
			name: "valid type - quarantine_change",
			filter: ActivityFilter{
				Type: "quarantine_change",
			},
		},
		{
			name: "valid type - server_change",
			filter: ActivityFilter{
				Type: "server_change",
			},
		},
		{
			name: "valid status - success",
			filter: ActivityFilter{
				Status: "success",
			},
		},
		{
			name: "valid status - error",
			filter: ActivityFilter{
				Status: "error",
			},
		},
		{
			name: "valid status - blocked",
			filter: ActivityFilter{
				Status: "blocked",
			},
		},
		{
			name: "valid time format - RFC3339",
			filter: ActivityFilter{
				StartTime: "2025-01-01T00:00:00Z",
				EndTime:   "2025-01-31T23:59:59Z",
			},
		},
		{
			name: "valid limit - within range",
			filter: ActivityFilter{
				Limit: 50,
			},
		},
		{
			name: "all filters combined",
			filter: ActivityFilter{
				Type:      "tool_call",
				Server:    "github",
				Tool:      "create_issue",
				Status:    "success",
				SessionID: "session-123",
				StartTime: "2025-01-01T00:00:00Z",
				EndTime:   "2025-01-31T23:59:59Z",
				Limit:     25,
				Offset:    10,
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.filter.Validate()
			assert.NoError(t, err)
		})
	}
}

func TestActivityFilter_Validate_InvalidInputs(t *testing.T) {
	tests := []struct {
		name        string
		filter      ActivityFilter
		errContains string
	}{
		{
			name: "invalid type",
			filter: ActivityFilter{
				Type: "invalid_type",
			},
			errContains: "invalid type 'invalid_type'",
		},
		{
			name: "invalid status",
			filter: ActivityFilter{
				Status: "unknown",
			},
			errContains: "invalid status 'unknown'",
		},
		{
			name: "invalid start_time format",
			filter: ActivityFilter{
				StartTime: "2025-01-01",
			},
			errContains: "invalid start-time format",
		},
		{
			name: "invalid end_time format",
			filter: ActivityFilter{
				EndTime: "not-a-date",
			},
			errContains: "invalid end-time format",
		},
		{
			name: "invalid start_time - wrong timezone format",
			filter: ActivityFilter{
				StartTime: "2025-01-01T00:00:00",
			},
			errContains: "invalid start-time format",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.filter.Validate()
			assert.Error(t, err)
			assert.Contains(t, err.Error(), tt.errContains)
		})
	}
}

func TestActivityFilter_Validate_LimitClamping(t *testing.T) {
	tests := []struct {
		name          string
		inputLimit    int
		expectedLimit int
	}{
		{
			name:          "limit too low - clamped to default",
			inputLimit:    0,
			expectedLimit: 50,
		},
		{
			name:          "limit negative - clamped to default",
			inputLimit:    -10,
			expectedLimit: 50,
		},
		{
			name:          "limit too high - clamped to max",
			inputLimit:    200,
			expectedLimit: 100,
		},
		{
			name:          "limit at max",
			inputLimit:    100,
			expectedLimit: 100,
		},
		{
			name:          "limit within range",
			inputLimit:    50,
			expectedLimit: 50,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			filter := &ActivityFilter{Limit: tt.inputLimit}
			err := filter.Validate()
			assert.NoError(t, err)
			assert.Equal(t, tt.expectedLimit, filter.Limit)
		})
	}
}

func TestActivityFilter_ToQueryParams(t *testing.T) {
	tests := []struct {
		name           string
		filter         ActivityFilter
		expectedParams map[string]string
	}{
		{
			name:           "empty filter",
			filter:         ActivityFilter{},
			expectedParams: map[string]string{},
		},
		{
			name: "type only",
			filter: ActivityFilter{
				Type: "tool_call",
			},
			expectedParams: map[string]string{
				"type": "tool_call",
			},
		},
		{
			name: "server only",
			filter: ActivityFilter{
				Server: "github",
			},
			expectedParams: map[string]string{
				"server": "github",
			},
		},
		{
			name: "all filters",
			filter: ActivityFilter{
				Type:      "tool_call",
				Server:    "github",
				Tool:      "create_issue",
				Status:    "success",
				SessionID: "sess-123",
				StartTime: "2025-01-01T00:00:00Z",
				EndTime:   "2025-01-31T23:59:59Z",
				Limit:     25,
				Offset:    10,
			},
			expectedParams: map[string]string{
				"type":       "tool_call",
				"server":     "github",
				"tool":       "create_issue",
				"status":     "success",
				"session_id": "sess-123",
				"start_time": "2025-01-01T00:00:00Z",
				"end_time":   "2025-01-31T23:59:59Z",
				"limit":      "25",
				"offset":     "10",
			},
		},
		{
			name: "zero limit excluded",
			filter: ActivityFilter{
				Type:  "tool_call",
				Limit: 0,
			},
			expectedParams: map[string]string{
				"type": "tool_call",
			},
		},
		{
			name: "zero offset excluded",
			filter: ActivityFilter{
				Type:   "tool_call",
				Offset: 0,
			},
			expectedParams: map[string]string{
				"type": "tool_call",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := tt.filter.ToQueryParams()

			for key, expectedValue := range tt.expectedParams {
				assert.Equal(t, expectedValue, params.Get(key), "param %s", key)
			}

			// Check no extra params
			for key := range params {
				_, expected := tt.expectedParams[key]
				assert.True(t, expected, "unexpected param: %s", key)
			}
		})
	}
}

func TestActivityFilter_ToQueryParams_SensitiveDataFilters(t *testing.T) {
	tests := []struct {
		name           string
		filter         ActivityFilter
		expectedParams map[string]string
	}{
		{
			name: "sensitive_data true",
			filter: ActivityFilter{
				SensitiveData: boolPtr(true),
			},
			expectedParams: map[string]string{
				"sensitive_data": "true",
			},
		},
		{
			name: "sensitive_data false",
			filter: ActivityFilter{
				SensitiveData: boolPtr(false),
			},
			expectedParams: map[string]string{
				"sensitive_data": "false",
			},
		},
		{
			name: "detection_type only",
			filter: ActivityFilter{
				DetectionType: "aws_access_key",
			},
			expectedParams: map[string]string{
				"detection_type": "aws_access_key",
			},
		},
		{
			name: "severity only",
			filter: ActivityFilter{
				Severity: "critical",
			},
			expectedParams: map[string]string{
				"severity": "critical",
			},
		},
		{
			name: "all sensitive data filters",
			filter: ActivityFilter{
				SensitiveData: boolPtr(true),
				DetectionType: "stripe_key",
				Severity:      "high",
			},
			expectedParams: map[string]string{
				"sensitive_data": "true",
				"detection_type": "stripe_key",
				"severity":       "high",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			params := tt.filter.ToQueryParams()

			for key, expectedValue := range tt.expectedParams {
				assert.Equal(t, expectedValue, params.Get(key), "param %s", key)
			}
		})
	}
}

func TestActivityFilter_Validate_SeverityValidation(t *testing.T) {
	tests := []struct {
		name        string
		severity    string
		shouldError bool
	}{
		{"critical is valid", "critical", false},
		{"high is valid", "high", false},
		{"medium is valid", "medium", false},
		{"low is valid", "low", false},
		{"empty is valid", "", false},
		{"invalid severity", "extreme", true},
		{"unknown severity", "unknown", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			filter := &ActivityFilter{Severity: tt.severity}
			err := filter.Validate()
			if tt.shouldError {
				assert.Error(t, err)
				assert.Contains(t, err.Error(), "invalid severity")
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

// =============================================================================
// Period Validation Tests (Summary Command)
// =============================================================================

func TestSummaryPeriodValidation(t *testing.T) {
	validPeriods := []string{"1h", "24h", "7d", "30d"}

	tests := []struct {
		period  string
		isValid bool
	}{
		{"1h", true},
		{"24h", true},
		{"7d", true},
		{"30d", true},
		{"1d", false},
		{"12h", false},
		{"1w", false},
		{"", false},
		{"invalid", false},
	}

	for _, tt := range tests {
		t.Run(tt.period, func(t *testing.T) {
			valid := false
			for _, p := range validPeriods {
				if tt.period == p {
					valid = true
					break
				}
			}
			assert.Equal(t, tt.isValid, valid)
		})
	}
}

// =============================================================================
// Export Format Tests
// =============================================================================

func TestExportFormatValidation(t *testing.T) {
	validFormats := []string{"json", "csv"}

	tests := []struct {
		format  string
		isValid bool
	}{
		{"json", true},
		{"csv", true},
		{"jsonl", false},
		{"xml", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.format, func(t *testing.T) {
			valid := false
			for _, f := range validFormats {
				if tt.format == f {
					valid = true
					break
				}
			}
			assert.Equal(t, tt.isValid, valid)
		})
	}
}

// Helper function to create bool pointer
func boolPtr(b bool) *bool {
	return &b
}
