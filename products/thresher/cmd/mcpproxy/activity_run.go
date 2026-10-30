package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/logs"
)

// runActivityList implements the activity list command
func runActivityList(cmd *cobra.Command, _ []string) error {
	// Setup logger
	cmdLogLevel, _ := cmd.Flags().GetString("log-level")
	cmdLogToFile, _ := cmd.Flags().GetBool("log-to-file")
	cmdLogDir, _ := cmd.Flags().GetString("log-dir")

	logger, err := logs.SetupCommandLogger(false, cmdLogLevel, cmdLogToFile, cmdLogDir)
	if err != nil {
		return fmt.Errorf("failed to setup logger: %w", err)
	}
	defer func() { _ = logger.Sync() }()

	// Spec 026: Handle sensitive-data flag
	var sensitiveDataPtr *bool
	if cmd.Flags().Changed("sensitive-data") {
		sensitiveDataVal, _ := cmd.Flags().GetBool("sensitive-data")
		sensitiveDataPtr = &sensitiveDataVal
	}

	// Build filter
	filter := &ActivityFilter{
		Type:          activityType,
		Server:        activityServer,
		Tool:          activityTool,
		Status:        activityStatus,
		SessionID:     activitySessionID,
		StartTime:     activityStartTime,
		EndTime:       activityEndTime,
		Limit:         activityLimit,
		Offset:        activityOffset,
		IntentType:    activityIntentType,
		RequestID:     activityRequestID,
		SensitiveData: sensitiveDataPtr,
		DetectionType: activityDetectionType,
		Severity:      activitySeverity,
		AgentName:     activityAgent,
		AuthType:      activityAuthType,
	}

	if err := filter.Validate(); err != nil {
		return outputActivityError(err, "INVALID_FILTER")
	}

	// Create client
	client, err := getActivityClient(logger.Sugar())
	if err != nil {
		return outputActivityError(err, "CONNECTION_ERROR")
	}

	// Fetch activities
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	activities, total, err := client.ListActivities(ctx, filter)
	if err != nil {
		return outputActivityError(err, "FETCH_ERROR")
	}

	// Format output
	outputFormat := ResolveOutputFormat()
	formatter, err := GetOutputFormatter()
	if err != nil {
		return err
	}

	if outputFormat == "json" || outputFormat == "yaml" {
		data := map[string]interface{}{
			"activities": activities,
			"total":      total,
			"limit":      filter.Limit,
			"offset":     filter.Offset,
		}
		result, err := formatter.Format(data)
		if err != nil {
			return err
		}
		fmt.Println(result)
		return nil
	}

	// Table output
	if len(activities) == 0 {
		fmt.Println("No activities found")
		return nil
	}

	// Spec 026: Add SENSITIVE column to indicate activities with sensitive data detected
	headers := []string{"ID", "SRC", "TYPE", "SERVER", "TOOL", "INTENT", "SENSITIVE", "STATUS", "DURATION", "TIME"}
	rows := make([][]string, 0, len(activities))

	for _, act := range activities {
		id := getStringField(act, "id")
		source := getStringField(act, "source")
		actType := getStringField(act, "type")
		server := getStringField(act, "server_name")
		tool := getStringField(act, "tool_name")
		status := getStringField(act, "status")
		durationMs := getIntField(act, "duration_ms")
		timestamp := getStringField(act, "timestamp")

		// Spec 098: a preflight is set-scoped — server_name/tool_name are empty
		// by construction, so the TOOL cell carries the verdict summary instead
		// of rendering an empty row the operator cannot interpret.
		if tool == "" {
			if summary := preflightActivitySummary(act); summary != "" {
				tool = sanitizeCell(summary, maxPreflightSummaryCell)
			}
		}

		// Extract intent from metadata (Spec 018)
		intentStr := formatIntentIndicator(act)

		// Spec 026: Format sensitive data indicator
		sensitiveStr := formatSensitiveDataIndicator(act)

		// Parse and format timestamp
		timeStr := timestamp
		if t, err := time.Parse(time.RFC3339, timestamp); err == nil {
			timeStr = formatRelativeTime(t)
		}

		// Truncate type for display
		if len(actType) > 12 {
			actType = actType[:12]
		}

		// Format source indicator
		sourceIcon := formatSourceIndicator(source)

		rows = append(rows, []string{
			id, // Show full ID so it can be used with 'activity show'
			sourceIcon,
			actType,
			server,
			tool,
			intentStr,
			sensitiveStr, // Spec 026: Show sensitive data indicator
			status,
			formatActivityDuration(int64(durationMs)),
			timeStr,
		})
	}

	result, err := formatter.FormatTable(headers, rows)
	if err != nil {
		return err
	}
	fmt.Print(result)

	// Show pagination info
	fmt.Printf("\nShowing %d of %d records", len(activities), total)
	if filter.Offset > 0 || total > filter.Limit {
		page := (filter.Offset / filter.Limit) + 1
		fmt.Printf(" (page %d)", page)
	}
	fmt.Println()

	return nil
}

// displayActivityEvent formats and displays an SSE activity event
func displayActivityEvent(eventType, eventData, outputFormat string) {
	if outputFormat == "json" {
		// NDJSON output
		fmt.Println(eventData)
		return
	}

	// Parse event data - SSE wraps the actual payload in {"payload": ..., "timestamp": ...}
	var wrapper map[string]interface{}
	if err := json.Unmarshal([]byte(eventData), &wrapper); err != nil {
		return
	}

	// Extract the actual payload from the wrapper
	event, ok := wrapper["payload"].(map[string]interface{})
	if !ok {
		// If no wrapper, use the data directly (for backwards compatibility/testing)
		event = wrapper
	}

	// Determine event category from eventType (e.g., "activity.tool_call.completed" -> "tool_call")
	parts := strings.Split(eventType, ".")
	eventCategory := ""
	if len(parts) >= 2 {
		eventCategory = parts[1]
	}

	// Apply client-side filters
	if activityServer != "" {
		// For tool_call events, check server_name
		// For internal_tool_call events, check target_server
		server := getStringField(event, "server_name")
		if server == "" {
			server = getStringField(event, "target_server")
		}
		if server == "" {
			server = getStringField(event, "affected_entity") // for config_change
		}
		if server != activityServer {
			return
		}
	}
	if activityType != "" {
		if eventCategory != activityType {
			return
		}
	}

	// Skip successful call_tool_* internal tool calls to avoid duplicates
	// These have a corresponding tool_call entry that shows the actual upstream call.
	// Failed call_tool_* calls are shown since they have no corresponding tool_call.
	if eventCategory == "internal_tool_call" {
		internalToolName := getStringField(event, "internal_tool_name")
		status := getStringField(event, "status")
		if status == "success" && strings.HasPrefix(internalToolName, "call_tool_") {
			return
		}
	}

	// Format output based on event type
	timestamp := time.Now().Format("15:04:05")

	var line string
	switch eventCategory {
	case "tool_call":
		line = formatToolCallEvent(event, timestamp)
	case "internal_tool_call":
		line = formatInternalToolCallEvent(event, timestamp)
	case "policy_decision":
		line = formatPolicyDecisionEvent(event, timestamp)
	case "system_start":
		line = formatSystemStartEvent(event, timestamp)
	case "system_stop":
		line = formatSystemStopEvent(event, timestamp)
	case "config_change":
		line = formatConfigChangeEvent(event, timestamp)
	default:
		// Fallback for unknown event types
		line = fmt.Sprintf("[%s] [?] %s", timestamp, eventType)
	}

	fmt.Println(line)
}

// runActivityShow implements the activity show command
func runActivityShow(cmd *cobra.Command, args []string) error {
	activityID := args[0]

	// Setup logger
	cmdLogLevel, _ := cmd.Flags().GetString("log-level")
	cmdLogToFile, _ := cmd.Flags().GetBool("log-to-file")
	cmdLogDir, _ := cmd.Flags().GetString("log-dir")

	logger, err := logs.SetupCommandLogger(false, cmdLogLevel, cmdLogToFile, cmdLogDir)
	if err != nil {
		return fmt.Errorf("failed to setup logger: %w", err)
	}
	defer func() { _ = logger.Sync() }()

	// Create client
	client, err := getActivityClient(logger.Sugar())
	if err != nil {
		return outputActivityError(err, "CONNECTION_ERROR")
	}

	// Fetch activity detail
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	activity, err := client.GetActivityDetail(ctx, activityID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return outputActivityError(fmt.Errorf("activity not found: %s", activityID), "ACTIVITY_NOT_FOUND")
		}
		return outputActivityError(err, "FETCH_ERROR")
	}

	// Format output
	outputFormat := ResolveOutputFormat()
	formatter, err := GetOutputFormatter()
	if err != nil {
		return err
	}

	if outputFormat == "json" || outputFormat == "yaml" {
		result, err := formatter.Format(activity)
		if err != nil {
			return err
		}
		fmt.Println(result)
		return nil
	}

	// Table output - key-value pairs
	fmt.Println("Activity Details")
	fmt.Println("================")
	fmt.Println()

	fmt.Printf("ID:           %s\n", getStringField(activity, "id"))
	fmt.Printf("Type:         %s\n", getStringField(activity, "type"))
	source := getStringField(activity, "source")
	if source == "" {
		source = "mcp" // Default for backwards compatibility
	}
	fmt.Printf("Source:       %s (%s)\n", formatSourceIndicator(source), formatSourceDescription(source))
	fmt.Printf("Server:       %s\n", getStringField(activity, "server_name"))
	fmt.Printf("Tool:         %s\n", getStringField(activity, "tool_name"))
	fmt.Printf("Status:       %s\n", getStringField(activity, "status"))
	fmt.Printf("Duration:     %s\n", formatActivityDuration(int64(getIntField(activity, "duration_ms"))))
	fmt.Printf("Timestamp:    %s\n", getStringField(activity, "timestamp"))

	if sessionID := getStringField(activity, "session_id"); sessionID != "" {
		fmt.Printf("Session ID:   %s\n", sessionID)
	}

	// Spec 098 (SC-005): the request id is how a preflight record is joined to
	// the tool calls of the same workflow (`activity list --request-id <id>`),
	// so the detail view has to show it, not just accept it as a filter.
	if requestID := getStringField(activity, "request_id"); requestID != "" {
		fmt.Printf("Request ID:   %s\n", requestID)
	}

	if errMsg := getStringField(activity, "error_message"); errMsg != "" {
		fmt.Printf("Error:        %s\n", errMsg)
	}

	// Intent information (Spec 018)
	displayIntentSection(activity)

	// Sensitive Data Detection (Spec 026)
	displaySensitiveDataSection(activity)

	// Preflight verdict + per-tool reasons (Spec 098)
	displayPreflightSection(activity)

	// Arguments
	if args, ok := activity["arguments"].(map[string]interface{}); ok && len(args) > 0 {
		fmt.Println()
		fmt.Println("Arguments:")
		argsJSON, _ := json.MarshalIndent(args, "  ", "  ")
		fmt.Printf("  %s\n", string(argsJSON))
	}

	// Response (if included)
	if activityIncludeResponse {
		if response := getStringField(activity, "response"); response != "" {
			fmt.Println()
			fmt.Println("Response:")
			fmt.Printf("  %s\n", response)

			if truncated, ok := activity["response_truncated"].(bool); ok && truncated {
				fmt.Println("  (response was truncated)")
			}
		}
	}

	return nil
}

// runActivitySummary implements the activity summary command
func runActivitySummary(cmd *cobra.Command, _ []string) error {
	// Setup logger
	cmdLogLevel, _ := cmd.Flags().GetString("log-level")
	cmdLogToFile, _ := cmd.Flags().GetBool("log-to-file")
	cmdLogDir, _ := cmd.Flags().GetString("log-dir")

	logger, err := logs.SetupCommandLogger(false, cmdLogLevel, cmdLogToFile, cmdLogDir)
	if err != nil {
		return fmt.Errorf("failed to setup logger: %w", err)
	}
	defer func() { _ = logger.Sync() }()

	// Validate period
	validPeriods := []string{"1h", "24h", "7d", "30d"}
	valid := false
	for _, p := range validPeriods {
		if activityPeriod == p {
			valid = true
			break
		}
	}
	if !valid {
		return outputActivityError(fmt.Errorf("invalid period '%s': must be one of %v", activityPeriod, validPeriods), "INVALID_PERIOD")
	}

	// Create client
	client, err := getActivityClient(logger.Sugar())
	if err != nil {
		return outputActivityError(err, "CONNECTION_ERROR")
	}

	// Fetch summary
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	summary, err := client.GetActivitySummary(ctx, activityPeriod, activityGroupBy)
	if err != nil {
		return outputActivityError(err, "FETCH_ERROR")
	}

	// Format output
	outputFormat := ResolveOutputFormat()
	formatter, err := GetOutputFormatter()
	if err != nil {
		return err
	}

	if outputFormat == "json" || outputFormat == "yaml" {
		result, err := formatter.Format(summary)
		if err != nil {
			return err
		}
		fmt.Println(result)
		return nil
	}

	// Table output
	period := getStringField(summary, "period")
	totalCount := getIntField(summary, "total_count")
	successCount := getIntField(summary, "success_count")
	errorCount := getIntField(summary, "error_count")
	blockedCount := getIntField(summary, "blocked_count")

	fmt.Printf("Activity Summary (last %s)\n", period)
	fmt.Println("===========================")
	fmt.Println()

	// Calculate percentages
	successPct := float64(0)
	errorPct := float64(0)
	blockedPct := float64(0)
	if totalCount > 0 {
		successPct = float64(successCount) / float64(totalCount) * 100
		errorPct = float64(errorCount) / float64(totalCount) * 100
		blockedPct = float64(blockedCount) / float64(totalCount) * 100
	}

	fmt.Printf("%-15s %s\n", "METRIC", "VALUE")
	fmt.Printf("%-15s %s\n", strings.Repeat("-", 15), strings.Repeat("-", 20))
	fmt.Printf("%-15s %d\n", "Total Calls", totalCount)
	fmt.Printf("%-15s %d (%.1f%%)\n", "Successful", successCount, successPct)
	fmt.Printf("%-15s %d (%.1f%%)\n", "Errors", errorCount, errorPct)
	fmt.Printf("%-15s %d (%.1f%%)\n", "Blocked", blockedCount, blockedPct)

	// Top servers
	if topServers, ok := summary["top_servers"].([]interface{}); ok && len(topServers) > 0 {
		fmt.Println()
		fmt.Println("TOP SERVERS")
		fmt.Println(strings.Repeat("-", 30))
		for _, s := range topServers {
			if srv, ok := s.(map[string]interface{}); ok {
				name := getStringField(srv, "name")
				count := getIntField(srv, "count")
				fmt.Printf("%-20s %d calls\n", name, count)
			}
		}
	}

	// Top tools
	if topTools, ok := summary["top_tools"].([]interface{}); ok && len(topTools) > 0 {
		fmt.Println()
		fmt.Println("TOP TOOLS")
		fmt.Println(strings.Repeat("-", 40))
		for _, t := range topTools {
			if tool, ok := t.(map[string]interface{}); ok {
				server := getStringField(tool, "server")
				toolName := getStringField(tool, "tool")
				count := getIntField(tool, "count")
				fmt.Printf("%-30s %d calls\n", server+":"+toolName, count)
			}
		}
	}

	return nil
}

// runActivityExport implements the activity export command
func runActivityExport(cmd *cobra.Command, _ []string) error {
	// Setup logger
	cmdLogLevel, _ := cmd.Flags().GetString("log-level")
	cmdLogToFile, _ := cmd.Flags().GetBool("log-to-file")
	cmdLogDir, _ := cmd.Flags().GetString("log-dir")

	logger, err := logs.SetupCommandLogger(false, cmdLogLevel, cmdLogToFile, cmdLogDir)
	if err != nil {
		return fmt.Errorf("failed to setup logger: %w", err)
	}
	defer func() { _ = logger.Sync() }()

	// Validate format
	if activityExportFormat != "json" && activityExportFormat != "csv" {
		return outputActivityError(fmt.Errorf("invalid format '%s': must be 'json' or 'csv'", activityExportFormat), "INVALID_FORMAT")
	}

	// Load config - use explicit config file if provided via -c flag
	cfg, err := loadActivityConfig()
	if err != nil {
		return outputActivityError(err, "CONFIG_ERROR")
	}

	// Resolve the daemon via the shared detection: socket first, then probed
	// TCP fallback with the env>config API key (QA finding CLI-SOCKET).
	endpoint, apiKey, ok := daemonEndpoint(cfg)
	if !ok {
		return outputActivityError(fmt.Errorf("mcpproxy daemon is not reachable. Start with: mcpproxy serve"), "CONNECTION_ERROR")
	}
	transport, baseURL := activityTransport(endpoint, logger.Sugar())
	exportURL := baseURL + "/api/v1/activity/export"

	q := url.Values{}
	q.Set("format", activityExportFormat)
	if activityType != "" {
		q.Set("type", activityType)
	}
	if activityServer != "" {
		q.Set("server", activityServer)
	}
	if activityTool != "" {
		q.Set("tool", activityTool)
	}
	if activityStatus != "" {
		q.Set("status", activityStatus)
	}
	if activitySessionID != "" {
		q.Set(sessionQueryParam(activitySessionID), activitySessionID)
	}
	if activityStartTime != "" {
		q.Set("start_time", activityStartTime)
	}
	if activityEndTime != "" {
		q.Set("end_time", activityEndTime)
	}
	if activityIncludeBodies {
		q.Set("include_bodies", "true")
	}

	exportURL += "?" + q.Encode()

	// Create HTTP request
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, exportURL, nil)
	if err != nil {
		return outputActivityError(err, "REQUEST_ERROR")
	}

	// Add API key header (empty over socket — OS-level auth)
	if apiKey != "" {
		req.Header.Set("X-API-Key", apiKey)
	}

	client := &http.Client{Transport: transport}
	resp, err := client.Do(req)
	if err != nil {
		return outputActivityError(err, "CONNECTION_ERROR")
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return outputActivityError(fmt.Errorf("server returned %d: %s", resp.StatusCode, string(body)), "EXPORT_ERROR")
	}

	// Determine output destination
	var w io.Writer = os.Stdout
	if activityExportOutput != "" {
		f, err := os.Create(activityExportOutput)
		if err != nil {
			return outputActivityError(fmt.Errorf("failed to create output file: %w", err), "FILE_ERROR")
		}
		defer f.Close()
		w = f
	}

	// Stream response to output
	_, err = io.Copy(w, resp.Body)
	if err != nil {
		return outputActivityError(fmt.Errorf("failed to write output: %w", err), "WRITE_ERROR")
	}

	// Report success for file output
	if activityExportOutput != "" {
		fmt.Fprintf(os.Stderr, "Exported to %s\n", activityExportOutput)
	}

	return nil
}
