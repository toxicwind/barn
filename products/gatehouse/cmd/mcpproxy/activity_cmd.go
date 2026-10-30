package main

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/storage"
)

// Activity command flags
var (
	// Shared filter flags
	activityType          string
	activityServer        string
	activityTool          string
	activityStatus        string
	activitySessionID     string
	activityStartTime     string
	activityEndTime       string
	activityLimit         int
	activityOffset        int
	activityIntentType    string // Spec 018: Filter by operation type (read, write, destructive)
	activityRequestID     string // Spec 021: Filter by HTTP request ID for correlation
	activityNoIcons       bool   // Disable emoji icons in output
	activityDetectionType string // Spec 026: Filter by detection type (e.g., "aws_access_key")
	activitySeverity      string // Spec 026: Filter by severity level (critical, high, medium, low)
	activityAgent         string // Spec 028: Filter by agent token name
	activityAuthType      string // Spec 028: Filter by auth type (admin, agent)

	// Show command flags
	activityIncludeResponse bool

	// Summary command flags
	activityPeriod  string
	activityGroupBy string

	// Export command flags
	activityExportOutput  string
	activityExportFormat  string
	activityIncludeBodies bool
)

// ActivityFilter contains options for filtering activity records
type ActivityFilter struct {
	Type          string
	Server        string
	Tool          string
	Status        string
	SessionID     string
	StartTime     string
	EndTime       string
	Limit         int
	Offset        int
	IntentType    string // Spec 018: Filter by operation type (read, write, destructive)
	RequestID     string // Spec 021: Filter by HTTP request ID for correlation
	SensitiveData *bool  // Spec 026: Filter by sensitive data detection
	DetectionType string // Spec 026: Filter by detection type
	Severity      string // Spec 026: Filter by severity level
	AgentName     string // Spec 028: Filter by agent token name
	AuthType      string // Spec 028: Filter by auth type (admin, agent)
}

// Validate validates the filter options
func (f *ActivityFilter) Validate() error {
	// Validate type(s) - supports comma-separated values (Spec 024)
	if f.Type != "" {
		validTypes := []string{
			"tool_call", "policy_decision", "quarantine_change", "server_change",
			"system_start", "system_stop", "internal_tool_call", "config_change", // Spec 024: new types
			string(storage.ActivityTypePreflight), // Spec 098: required-tools preflight
			string(storage.ActivityTypePromptGet), // Finding F10: prompts/get activity
		}
		// Split by comma for multi-type support
		types := strings.Split(f.Type, ",")
		for _, t := range types {
			t = strings.TrimSpace(t)
			valid := false
			for _, vt := range validTypes {
				if t == vt {
					valid = true
					break
				}
			}
			if !valid {
				return fmt.Errorf("invalid type '%s': must be one of %v", t, validTypes)
			}
		}
	}

	// Validate status
	if f.Status != "" {
		// Spec 093 added "rejected" (shed by a concurrency limit) to the closed
		// activity status vocabulary; the CLI filter must accept it.
		validStatuses := []string{"success", "error", "blocked", "rejected"}
		valid := false
		for _, s := range validStatuses {
			if f.Status == s {
				valid = true
				break
			}
		}
		if !valid {
			return fmt.Errorf("invalid status '%s': must be one of %v", f.Status, validStatuses)
		}
	}

	// Validate intent_type (Spec 018)
	if f.IntentType != "" {
		validIntentTypes := []string{"read", "write", "destructive"}
		valid := false
		for _, it := range validIntentTypes {
			if f.IntentType == it {
				valid = true
				break
			}
		}
		if !valid {
			return fmt.Errorf("invalid intent-type '%s': must be one of %v", f.IntentType, validIntentTypes)
		}
	}

	// Validate severity (Spec 026)
	if f.Severity != "" {
		validSeverities := []string{"critical", "high", "medium", "low"}
		valid := false
		for _, s := range validSeverities {
			if f.Severity == s {
				valid = true
				break
			}
		}
		if !valid {
			return fmt.Errorf("invalid severity '%s': must be one of %v", f.Severity, validSeverities)
		}
	}

	// Validate auth_type (Spec 028)
	if f.AuthType != "" {
		validAuthTypes := []string{"admin", "agent"}
		valid := false
		for _, at := range validAuthTypes {
			if f.AuthType == at {
				valid = true
				break
			}
		}
		if !valid {
			return fmt.Errorf("invalid auth-type '%s': must be one of %v", f.AuthType, validAuthTypes)
		}
	}

	// Validate time formats
	if f.StartTime != "" {
		if _, err := time.Parse(time.RFC3339, f.StartTime); err != nil {
			return fmt.Errorf("invalid start-time format: must be RFC3339 (e.g., 2025-01-01T00:00:00Z)")
		}
	}
	if f.EndTime != "" {
		if _, err := time.Parse(time.RFC3339, f.EndTime); err != nil {
			return fmt.Errorf("invalid end-time format: must be RFC3339 (e.g., 2025-01-01T00:00:00Z)")
		}
	}

	// Clamp limit
	if f.Limit < 1 {
		f.Limit = 50
	} else if f.Limit > 100 {
		f.Limit = 100
	}

	return nil
}

// ToQueryParams converts filter to URL query parameters
func (f *ActivityFilter) ToQueryParams() url.Values {
	q := url.Values{}
	if f.Type != "" {
		q.Set("type", f.Type)
	}
	if f.Server != "" {
		q.Set("server", f.Server)
	}
	if f.Tool != "" {
		q.Set("tool", f.Tool)
	}
	if f.Status != "" {
		q.Set("status", f.Status)
	}
	if f.SessionID != "" {
		q.Set(sessionQueryParam(f.SessionID), f.SessionID)
	}
	if f.StartTime != "" {
		q.Set("start_time", f.StartTime)
	}
	if f.EndTime != "" {
		q.Set("end_time", f.EndTime)
	}
	if f.Limit > 0 {
		q.Set("limit", fmt.Sprintf("%d", f.Limit))
	}
	if f.Offset > 0 {
		q.Set("offset", fmt.Sprintf("%d", f.Offset))
	}
	if f.IntentType != "" {
		q.Set("intent_type", f.IntentType)
	}
	// Spec 021: Add request_id filter for log correlation
	if f.RequestID != "" {
		q.Set("request_id", f.RequestID)
	}
	// Spec 026: Add sensitive data filters
	if f.SensitiveData != nil {
		q.Set("sensitive_data", fmt.Sprintf("%t", *f.SensitiveData))
	}
	if f.DetectionType != "" {
		q.Set("detection_type", f.DetectionType)
	}
	if f.Severity != "" {
		q.Set("severity", f.Severity)
	}
	// Spec 028: Agent token identity filters
	if f.AgentName != "" {
		q.Set("agent", f.AgentName)
	}
	if f.AuthType != "" {
		q.Set("auth_type", f.AuthType)
	}
	return q
}

// Activity command definitions
var (
	activityCmd = &cobra.Command{
		Use:   "activity",
		Short: "Query and monitor activity logs",
		Long:  "Commands for listing, watching, and exporting activity logs from the MCPProxy daemon",
	}

	activityListCmd = &cobra.Command{
		Use:   "list",
		Short: "List activity records with filtering",
		Long: `List activity records with optional filtering and pagination.

Examples:
  # List recent activity
  mcpproxy activity list

  # List last 10 tool calls
  mcpproxy activity list --type tool_call --limit 10

  # List errors from github server
  mcpproxy activity list --server github --status error

  # List activity by request ID (for error correlation)
  mcpproxy activity list --request-id abc123-def456

  # List only activities with sensitive data detected
  mcpproxy activity list --sensitive-data

  # Filter by detection type
  mcpproxy activity list --detection-type aws_access_key

  # Filter by severity level
  mcpproxy activity list --severity critical

  # List activity as JSON
  mcpproxy activity list -o json`,
		RunE: runActivityList,
	}

	activityWatchCmd = &cobra.Command{
		Use:   "watch",
		Short: "Watch activity stream in real-time",
		Long: `Watch activity events in real-time via SSE stream.

Examples:
  # Watch all activity
  mcpproxy activity watch

  # Watch only tool calls from github
  mcpproxy activity watch --type tool_call --server github

  # Watch with JSON output
  mcpproxy activity watch -o json`,
		RunE: runActivityWatch,
	}

	activityShowCmd = &cobra.Command{
		Use:   "show <id>",
		Short: "Show activity details",
		Long: `Show full details of a specific activity record.

Examples:
  # Show activity details
  mcpproxy activity show 01JFXYZ123ABC

  # Show with full response body
  mcpproxy activity show 01JFXYZ123ABC --include-response`,
		Args: cobra.ExactArgs(1),
		RunE: runActivityShow,
	}

	activitySummaryCmd = &cobra.Command{
		Use:   "summary",
		Short: "Show activity statistics",
		Long: `Show aggregated activity statistics for a time period.

Examples:
  # Show 24-hour summary
  mcpproxy activity summary

  # Show weekly summary
  mcpproxy activity summary --period 7d

  # Show summary grouped by server
  mcpproxy activity summary --by server`,
		RunE: runActivitySummary,
	}

	activityExportCmd = &cobra.Command{
		Use:   "export",
		Short: "Export activity records",
		Long: `Export activity records for compliance and auditing.

Examples:
  # Export all activity as JSON Lines to file
  mcpproxy activity export --output activity.jsonl

  # Export as CSV
  mcpproxy activity export --format csv --output activity.csv

  # Export to stdout for piping
  mcpproxy activity export --format csv | gzip > activity.csv.gz`,
		RunE: runActivityExport,
	}
)

// GetActivityCommand returns the activity command for registration
func GetActivityCommand() *cobra.Command {
	return activityCmd
}

func init() {
	// Add subcommands
	activityCmd.AddCommand(activityListCmd)
	activityCmd.AddCommand(activityWatchCmd)
	activityCmd.AddCommand(activityShowCmd)
	activityCmd.AddCommand(activitySummaryCmd)
	activityCmd.AddCommand(activityExportCmd)

	// List command flags
	activityListCmd.Flags().StringVarP(&activityType, "type", "t", "", "Filter by type (comma-separated for multiple): tool_call, system_start, system_stop, internal_tool_call, config_change, policy_decision, quarantine_change, server_change, preflight")
	activityListCmd.Flags().StringVarP(&activityServer, "server", "s", "", "Filter by server name")
	activityListCmd.Flags().StringVar(&activityTool, "tool", "", "Filter by tool name")
	activityListCmd.Flags().StringVar(&activityStatus, "status", "", "Filter by status: success, error, blocked, rejected")
	activityListCmd.Flags().StringVar(&activitySessionID, "session", "", "Filter by session — a work session id (ws-...) or a raw MCP transport session id")
	activityListCmd.Flags().StringVar(&activityStartTime, "start-time", "", "Filter records after this time (RFC3339)")
	activityListCmd.Flags().StringVar(&activityEndTime, "end-time", "", "Filter records before this time (RFC3339)")
	activityListCmd.Flags().IntVarP(&activityLimit, "limit", "n", 50, "Max records to return (1-100)")
	activityListCmd.Flags().IntVar(&activityOffset, "offset", 0, "Pagination offset")
	activityListCmd.Flags().StringVar(&activityIntentType, "intent-type", "", "Filter by intent operation type: read, write, destructive")
	activityListCmd.Flags().StringVar(&activityRequestID, "request-id", "", "Filter by HTTP request ID for log correlation")
	activityListCmd.Flags().BoolVar(&activityNoIcons, "no-icons", false, "Disable emoji icons in output (use text instead)")
	// Spec 026: Sensitive data detection filters
	activityListCmd.Flags().Bool("sensitive-data", false, "Filter to show only activities with sensitive data detected")
	activityListCmd.Flags().StringVar(&activityDetectionType, "detection-type", "", "Filter by detection type (e.g., aws_access_key, stripe_key)")
	activityListCmd.Flags().StringVar(&activitySeverity, "severity", "", "Filter by severity level: critical, high, medium, low")
	// Spec 028: Agent token identity filters
	activityListCmd.Flags().StringVar(&activityAgent, "agent", "", "Filter by agent token name")
	activityListCmd.Flags().StringVar(&activityAuthType, "auth-type", "", "Filter by auth type: admin, agent")

	// Watch command flags
	activityWatchCmd.Flags().StringVarP(&activityType, "type", "t", "", "Filter by type (comma-separated): tool_call, system_start, system_stop, internal_tool_call, config_change, policy_decision, quarantine_change, server_change, preflight")
	activityWatchCmd.Flags().StringVarP(&activityServer, "server", "s", "", "Filter by server name")

	// Show command flags
	activityShowCmd.Flags().BoolVar(&activityIncludeResponse, "include-response", false, "Show full response (may be large)")
	activityShowCmd.Flags().BoolVar(&activityNoIcons, "no-icons", false, "Disable emoji icons in output (use text instead)")

	// Summary command flags
	activitySummaryCmd.Flags().StringVarP(&activityPeriod, "period", "p", "24h", "Time period: 1h, 24h, 7d, 30d")
	activitySummaryCmd.Flags().StringVar(&activityGroupBy, "by", "", "Group by: server, tool, status")

	// Export command flags
	activityExportCmd.Flags().StringVar(&activityExportOutput, "output", "", "Output file path (stdout if not specified)")
	activityExportCmd.Flags().StringVarP(&activityExportFormat, "format", "f", "json", "Export format: json, csv")
	activityExportCmd.Flags().BoolVar(&activityIncludeBodies, "include-bodies", false, "Include full request/response bodies")
	// Reuse list filter flags for export
	activityExportCmd.Flags().StringVarP(&activityType, "type", "t", "", "Filter by type (comma-separated): tool_call, system_start, system_stop, internal_tool_call, config_change, policy_decision, quarantine_change, server_change, preflight")
	activityExportCmd.Flags().StringVarP(&activityServer, "server", "s", "", "Filter by server name")
	activityExportCmd.Flags().StringVar(&activityTool, "tool", "", "Filter by tool name")
	activityExportCmd.Flags().StringVar(&activityStatus, "status", "", "Filter by status: success, error, blocked, rejected")
	activityExportCmd.Flags().StringVar(&activitySessionID, "session", "", "Filter by session — a work session id (ws-...) or a raw MCP transport session id")
	activityExportCmd.Flags().StringVar(&activityStartTime, "start-time", "", "Filter after this time (RFC3339)")
	activityExportCmd.Flags().StringVar(&activityEndTime, "end-time", "", "Filter before this time (RFC3339)")
}

// getActivityClient creates an HTTP client for the daemon
func getActivityClient(logger *zap.SugaredLogger) (*cliclient.Client, error) {
	cfg, err := loadActivityConfig()
	if err != nil {
		return nil, fmt.Errorf("failed to load config: %w", err)
	}

	// Try socket first, then TCP fallback (cfg.Listen + API key)
	client, ok := newDaemonClient(cfg, logger)
	if !ok {
		return nil, fmt.Errorf("mcpproxy daemon is not reachable. Start with: mcpproxy serve")
	}
	return client, nil
}
