package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cli/output"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
)

// formatRelativeTime formats a timestamp as relative time for recent events
func formatRelativeTime(t time.Time) string {
	now := time.Now()
	diff := now.Sub(t)

	switch {
	case diff < time.Minute:
		return "just now"
	case diff < time.Hour:
		mins := int(diff.Minutes())
		if mins == 1 {
			return "1 minute ago"
		}
		return fmt.Sprintf("%d minutes ago", mins)
	case diff < 24*time.Hour:
		hours := int(diff.Hours())
		if hours == 1 {
			return "1 hour ago"
		}
		return fmt.Sprintf("%d hours ago", hours)
	case diff < 7*24*time.Hour:
		days := int(diff.Hours() / 24)
		if days == 1 {
			return "1 day ago"
		}
		return fmt.Sprintf("%d days ago", days)
	case t.Year() == now.Year():
		return t.Format("Jan 02")
	default:
		return t.Format("Jan 02, 2006")
	}
}

// formatActivityDuration formats duration in milliseconds to human-readable
func formatActivityDuration(ms int64) string {
	if ms < 1000 {
		return fmt.Sprintf("%dms", ms)
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}

// formatSourceIndicator returns an icon/abbreviation for the activity source
func formatSourceIndicator(source string) string {
	switch source {
	case "mcp":
		return "MCP" // AI agent via MCP protocol
	case "cli":
		return "CLI" // Direct CLI command
	case "api":
		return "API" // REST API call
	default:
		return "MCP" // Default to MCP for backwards compatibility
	}
}

// formatSourceDescription returns a human-readable description for the activity source
func formatSourceDescription(source string) string {
	switch source {
	case "mcp":
		return "AI agent via MCP protocol"
	case "cli":
		return "CLI command"
	case "api":
		return "REST API"
	default:
		return "AI agent via MCP protocol"
	}
}

// formatIntentIndicator extracts intent from activity metadata and returns visual indicator
// Returns emoji indicators: 📖 read, ✏️ write, ⚠️ destructive, or "-" if no intent
func formatIntentIndicator(activity map[string]interface{}) string {
	// Extract metadata from activity
	metadata := getMapField(activity, "metadata")
	if metadata == nil {
		return "-"
	}

	// Extract intent from metadata
	intent := getMapField(metadata, "intent")
	if intent == nil {
		// Check for tool_variant as fallback
		if toolVariant := getStringField(metadata, "tool_variant"); toolVariant != "" {
			return formatOperationIcon(toolVariantToOperationType(toolVariant))
		}
		return "-"
	}

	// Get operation_type from intent
	opType := getStringField(intent, "operation_type")
	if opType == "" {
		return "-"
	}

	return formatOperationIcon(opType)
}

// formatOperationIcon returns the visual indicator for an operation type
// If activityNoIcons is true, returns text instead of emoji
func formatOperationIcon(opType string) string {
	if activityNoIcons {
		// Text-only output
		switch opType {
		case "read":
			return "read"
		case "write":
			return "write"
		case "destructive":
			return "destructive"
		default:
			return "-"
		}
	}
	// Emoji output
	switch opType {
	case "read":
		return "📖" // Read operation
	case "write":
		return "✏️" // Write operation
	case "destructive":
		return "⚠️" // Destructive operation
	default:
		return "-"
	}
}

// formatSensitiveDataIndicator returns a visual indicator if sensitive data was detected
// Returns "⚠️" (or "SENSITIVE" if no-icons) if detected, "-" otherwise
func formatSensitiveDataIndicator(activity map[string]interface{}) string {
	metadata := getMapField(activity, "metadata")
	if metadata == nil {
		return "-"
	}

	detection := getMapField(metadata, "sensitive_data_detection")
	if detection == nil {
		return "-"
	}

	detected, ok := detection["detected"].(bool)
	if !ok || !detected {
		return "-"
	}

	if activityNoIcons {
		return "SENSITIVE"
	}
	return "⚠️"
}

// getSensitiveDataDetection extracts the sensitive data detection result from activity metadata
func getSensitiveDataDetection(activity map[string]interface{}) map[string]interface{} {
	metadata := getMapField(activity, "metadata")
	if metadata == nil {
		return nil
	}
	return getMapField(metadata, "sensitive_data_detection")
}

// getMaxSeverity returns the highest severity level from detections
func getMaxSeverity(detections []interface{}) string {
	severityOrder := map[string]int{
		"critical": 4,
		"high":     3,
		"medium":   2,
		"low":      1,
	}

	maxSeverity := ""
	maxOrder := 0

	for _, d := range detections {
		if detection, ok := d.(map[string]interface{}); ok {
			severity := getStringField(detection, "severity")
			if order, exists := severityOrder[severity]; exists && order > maxOrder {
				maxOrder = order
				maxSeverity = severity
			}
		}
	}

	return maxSeverity
}

// toolVariantToOperationType converts tool variant name to operation type
func toolVariantToOperationType(variant string) string {
	switch variant {
	case "call_tool_read":
		return "read"
	case "call_tool_write":
		return "write"
	case "call_tool_destructive":
		return "destructive"
	default:
		return ""
	}
}

// displayIntentSection displays intent information for activity show command
func displayIntentSection(activity map[string]interface{}) {
	// Extract metadata from activity
	metadata := getMapField(activity, "metadata")
	if metadata == nil {
		return
	}

	// Check if there's any intent-related data
	toolVariant := getStringField(metadata, "tool_variant")
	intent := getMapField(metadata, "intent")

	if toolVariant == "" && intent == nil {
		return
	}

	fmt.Println()
	fmt.Println("Intent Declaration:")

	// Display tool variant if present
	if toolVariant != "" {
		opType := toolVariantToOperationType(toolVariant)
		fmt.Printf("  Tool Variant:      %s\n", toolVariant)
		if opType != "" {
			fmt.Printf("  Operation Type:    %s %s\n", formatOperationIcon(opType), opType)
		}
	}

	// Display intent details if present
	if intent != nil {
		if opType := getStringField(intent, "operation_type"); opType != "" && toolVariant == "" {
			fmt.Printf("  Operation Type:    %s %s\n", formatOperationIcon(opType), opType)
		}
		if sensitivity := getStringField(intent, "data_sensitivity"); sensitivity != "" {
			fmt.Printf("  Data Sensitivity:  %s\n", sensitivity)
		}
		if reason := getStringField(intent, "reason"); reason != "" {
			fmt.Printf("  Reason:            %s\n", reason)
		}
		if reversible, ok := intent["reversible"].(bool); ok {
			reversibleStr := "no"
			if reversible {
				reversibleStr = "yes"
			}
			fmt.Printf("  Reversible:        %s\n", reversibleStr)
		}
	}
}

// displaySensitiveDataSection displays sensitive data detection information for activity show command (Spec 026)
func displaySensitiveDataSection(activity map[string]interface{}) {
	detection := getSensitiveDataDetection(activity)
	if detection == nil {
		return
	}

	detected, ok := detection["detected"].(bool)
	if !ok {
		return
	}

	fmt.Println()
	fmt.Println("Sensitive Data Detection:")

	// Show detection status
	if detected {
		if activityNoIcons {
			fmt.Println("  Status:            DETECTED")
		} else {
			fmt.Println("  Status:            \u26a0 DETECTED")
		}
	} else {
		fmt.Println("  Status:            No sensitive data detected")
		return
	}

	// Show scan duration if available
	if scanMs, ok := detection["scan_duration_ms"].(float64); ok {
		fmt.Printf("  Scan Duration:     %dms\n", int64(scanMs))
	}

	// Show if truncated
	if truncated, ok := detection["truncated"].(bool); ok && truncated {
		fmt.Println("  Note:              Payload was truncated for scanning")
	}

	// Show detections
	if detections, ok := detection["detections"].([]interface{}); ok && len(detections) > 0 {
		fmt.Println()
		fmt.Println("  Detections:")

		for i, d := range detections {
			if det, ok := d.(map[string]interface{}); ok {
				detType := getStringField(det, "type")
				category := getStringField(det, "category")
				severity := getStringField(det, "severity")
				location := getStringField(det, "location")
				isExample, _ := det["is_likely_example"].(bool)

				fmt.Printf("    [%d] Type:        %s\n", i+1, detType)
				fmt.Printf("        Category:    %s\n", category)
				fmt.Printf("        Severity:    %s\n", formatSeverityWithColor(severity))
				if location != "" {
					fmt.Printf("        Location:    %s\n", location)
				}
				if isExample {
					fmt.Printf("        Note:        Likely an example/test value\n")
				}
				fmt.Println()
			}
		}
	}
}

// formatSeverityWithColor returns a severity string with visual indicator
func formatSeverityWithColor(severity string) string {
	if activityNoIcons {
		return severity
	}
	switch severity {
	case "critical":
		return "\u2622 " + severity // radioactive symbol for critical
	case "high":
		return "\u26a0 " + severity // warning sign for high
	case "medium":
		return "\u26a1 " + severity // lightning for medium
	case "low":
		return "\u2139 " + severity // info for low
	default:
		return severity
	}
}

// outputActivityError outputs an error in the appropriate format
func outputActivityError(err error, code string) error {
	outputFormat := ResolveOutputFormat()
	formatter, fmtErr := GetOutputFormatter()
	if fmtErr != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		return err
	}

	// T026: Extract request_id from APIError if available
	var requestID string
	var apiErr *cliclient.APIError
	if errors.As(err, &apiErr) && apiErr.HasRequestID() {
		requestID = apiErr.RequestID
	}

	if outputFormat == "json" || outputFormat == "yaml" {
		structErr := output.NewStructuredError(code, err.Error()).
			WithGuidance("Use 'mcpproxy activity list' to view recent activities").
			WithRecoveryCommand("mcpproxy activity list --limit 10")
		// T026: Add request_id to StructuredError if available
		if requestID != "" {
			structErr = structErr.WithRequestID(requestID)
		}
		result, _ := formatter.FormatError(structErr)
		fmt.Println(result)
	} else {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		// T026: Include request ID with log retrieval suggestion if available
		if requestID != "" {
			fmt.Fprintf(os.Stderr, "\nRequest ID: %s\n", requestID)
			fmt.Fprintf(os.Stderr, "Use 'mcpproxy activity list --request-id %s' to find related logs.\n", requestID)
		}
		fmt.Fprintf(os.Stderr, "Hint: Use 'mcpproxy activity list' to view recent activities\n")
	}
	return err
}

// formatToolCallEvent formats a tool_call event for display
func formatToolCallEvent(event map[string]interface{}, timestamp string) string {
	source := getStringField(event, "source")
	server := getStringField(event, "server_name")
	tool := getStringField(event, "tool_name")
	status := getStringField(event, "status")
	durationMs := getIntField(event, "duration_ms")
	errMsg := getStringField(event, "error_message")

	sourceIcon := formatSourceIndicator(source)
	statusIcon := formatStatusIcon(status)

	line := fmt.Sprintf("[%s] [%s] %s:%s %s %s", timestamp, sourceIcon, server, tool, statusIcon, formatActivityDuration(int64(durationMs)))
	if errMsg != "" {
		line += " " + errMsg
	}
	switch status {
	case "blocked":
		line += " BLOCKED"
	case "rejected":
		line += " REJECTED (concurrency limit)"
	}
	return line
}

// formatInternalToolCallEvent formats an internal_tool_call event for display
func formatInternalToolCallEvent(event map[string]interface{}, timestamp string) string {
	internalTool := getStringField(event, "internal_tool_name")
	targetServer := getStringField(event, "target_server")
	targetTool := getStringField(event, "target_tool")
	status := getStringField(event, "status")
	durationMs := getIntField(event, "duration_ms")
	errMsg := getStringField(event, "error_message")

	statusIcon := formatStatusIcon(status)

	// Format: [HH:MM:SS] [INT] internal_tool -> target_server:target_tool status duration
	target := ""
	if targetServer != "" && targetTool != "" {
		target = fmt.Sprintf(" -> %s:%s", targetServer, targetTool)
	} else if targetServer != "" {
		target = fmt.Sprintf(" -> %s", targetServer)
	}

	line := fmt.Sprintf("[%s] [INT] %s%s %s %s", timestamp, internalTool, target, statusIcon, formatActivityDuration(int64(durationMs)))
	if errMsg != "" {
		line += " " + errMsg
	}
	return line
}

// formatPolicyDecisionEvent formats a policy_decision event for display
func formatPolicyDecisionEvent(event map[string]interface{}, timestamp string) string {
	server := getStringField(event, "server_name")
	tool := getStringField(event, "tool_name")
	decision := getStringField(event, "decision")
	reason := getStringField(event, "reason")

	statusIcon := "\u2298" // circle with slash for blocked
	if decision == "allowed" {
		statusIcon = "\u2713"
	}

	line := fmt.Sprintf("[%s] [POL] %s:%s %s", timestamp, server, tool, statusIcon)
	if reason != "" {
		line += " " + reason
	}
	return line
}

// formatSystemStartEvent formats a system_start event for display
func formatSystemStartEvent(event map[string]interface{}, timestamp string) string {
	version := getStringField(event, "version")
	listenAddr := getStringField(event, "listen_address")
	startupMs := getIntField(event, "startup_duration_ms")

	return fmt.Sprintf("[%s] [SYS] \u25B6 Started v%s on %s (%s)", timestamp, version, listenAddr, formatActivityDuration(int64(startupMs)))
}

// formatSystemStopEvent formats a system_stop event for display
func formatSystemStopEvent(event map[string]interface{}, timestamp string) string {
	reason := getStringField(event, "reason")
	signal := getStringField(event, "signal")
	uptimeSec := getIntField(event, "uptime_seconds")
	errMsg := getStringField(event, "error_message")

	line := fmt.Sprintf("[%s] [SYS] \u25A0 Stopped: %s", timestamp, reason)
	if signal != "" {
		line += fmt.Sprintf(" (signal: %s)", signal)
	}
	if uptimeSec > 0 {
		line += fmt.Sprintf(" uptime: %ds", uptimeSec)
	}
	if errMsg != "" {
		line += " error: " + errMsg
	}
	return line
}

// formatConfigChangeEvent formats a config_change event for display
func formatConfigChangeEvent(event map[string]interface{}, timestamp string) string {
	action := getStringField(event, "action")
	entity := getStringField(event, "affected_entity")
	source := getStringField(event, "source")

	sourceIcon := formatSourceIndicator(source)

	return fmt.Sprintf("[%s] [%s] \u2699 Config: %s %s", timestamp, sourceIcon, action, entity)
}

// formatStatusIcon returns a status icon for the given status
func formatStatusIcon(status string) string {
	switch status {
	case "success":
		return "\u2713" // checkmark
	case "error":
		return "\u2717" // X
	case "blocked":
		return "\u2298" // circle with slash
	case "rejected":
		// Spec 093: shed by a concurrency limit — backpressure, not a failure.
		return "\u23f8" // pause
	default:
		return "?"
	}
}

// sessionQueryParam picks the right filter for a --session value.
//
// Spec 082: the user-facing "session" is a WORK session (one client, one
// project, across reconnects) and its ids are prefixed "ws-". Raw MCP transport
// session ids are still accepted, so existing scripts keep working.
func sessionQueryParam(v string) string {
	if strings.HasPrefix(v, "ws-") {
		return "work_session_id"
	}
	return "session_id"
}
