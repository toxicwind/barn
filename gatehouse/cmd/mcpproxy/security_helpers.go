package main

import (
	"encoding/json"
	"fmt"
	"time"
)

// extractAPIErrorMsg extracts the error message from an API error response body.
func extractAPIErrorMsg(body []byte) string {
	var errResp map[string]interface{}
	if err := json.Unmarshal(body, &errResp); err == nil {
		if msg, ok := errResp["error"].(string); ok {
			return msg
		}
	}
	return string(body)
}

// getMapFloat returns a float64 value from a map, defaulting to 0.
func getMapFloat(m map[string]interface{}, key string) float64 {
	if v, ok := m[key].(float64); ok {
		return v
	}
	return 0
}

// scannerDurationMs returns a scanner_statuses entry's wall-clock duration in
// milliseconds. It prefers the explicit duration_ms field and falls back to
// computing it from started_at/completed_at so reports produced before
// duration_ms was recorded still render a timing value.
func scannerDurationMs(ss map[string]interface{}) float64 {
	if ms := getMapFloat(ss, "duration_ms"); ms > 0 {
		return ms
	}
	start := getMapString(ss, "started_at")
	end := getMapString(ss, "completed_at")
	if start == "" || end == "" {
		return 0
	}
	st, err1 := time.Parse(time.RFC3339Nano, start)
	et, err2 := time.Parse(time.RFC3339Nano, end)
	if err1 != nil || err2 != nil || et.Before(st) {
		return 0
	}
	return float64(et.Sub(st).Milliseconds())
}

// formatScannerDurationMs renders a per-scanner duration for human-readable
// output: sub-second values in milliseconds, larger values as a compact "X.Ys",
// and missing/zero timing as a dash.
func formatScannerDurationMs(ms float64) string {
	if ms <= 0 {
		return "-"
	}
	if ms < 1000 {
		return fmt.Sprintf("%dms", int(ms))
	}
	return fmt.Sprintf("%.1fs", ms/1000)
}
