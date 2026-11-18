package main

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cli/output"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/health"
)

func runUpstreamList(_ *cobra.Command, _ []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Load configuration
	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeConfigNotFound, err.Error()).
			WithGuidance("Check that your config file exists and is valid").
			WithRecoveryCommand("mcpproxy doctor"), output.ErrCodeConfigNotFound)
	}

	// Create logger
	logger, err := createUpstreamLogger(upstreamLogLevel)
	if err != nil {
		return outputError(err, output.ErrCodeOperationFailed)
	}

	// Check if daemon is running (socket first, then TCP fallback)
	if client, ok := newDaemonClient(globalConfig, logger.Sugar()); ok {
		logger.Info("Detected running daemon, using client mode")
		return runUpstreamListClientMode(ctx, client, logger)
	}

	// No daemon - load from config file
	logger.Info("No daemon detected, reading from config file")
	return runUpstreamListFromConfig(globalConfig)
}

func runUpstreamListClientMode(ctx context.Context, client *cliclient.Client, _ *zap.Logger) error {
	// Call GET /api/v1/servers
	servers, err := client.GetServers(ctx)
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeConnectionFailed, err.Error()).
			WithGuidance("Ensure the mcpproxy daemon is running").
			WithRecoveryCommand("mcpproxy serve"), output.ErrCodeConnectionFailed)
	}

	return outputServers(servers)
}

func runUpstreamListFromConfig(globalConfig *config.Config) error {
	// Convert config servers to output format
	servers := make([]map[string]interface{}, len(globalConfig.Servers))
	for i, srv := range globalConfig.Servers {
		// I-003: Use health.CalculateHealth() instead of inline logic for DRY principle
		healthInput := health.HealthCalculatorInput{
			Name:        srv.Name,
			Enabled:     srv.Enabled,
			Quarantined: srv.Quarantined,
			State:       "disconnected", // Daemon not running
			Connected:   false,
			ToolCount:   0,
		}
		healthStatus := health.CalculateHealth(healthInput, health.DefaultHealthConfig())

		// Override summary for config-only mode to indicate daemon status
		summary := healthStatus.Summary
		if healthStatus.AdminState == health.StateEnabled {
			summary = "Daemon not running"
		}

		servers[i] = map[string]interface{}{
			"name":       srv.Name,
			"enabled":    srv.Enabled,
			"protocol":   srv.Protocol,
			"connected":  false,
			"tool_count": 0,
			"status":     summary,
			"health": map[string]interface{}{
				"level":       healthStatus.Level,
				"admin_state": healthStatus.AdminState,
				"summary":     summary,
				"detail":      healthStatus.Detail,
				"action":      healthStatus.Action,
			},
		}

		// Spec 086: surface the per-server trust tier in the daemon-less path
		// too, so `mcpproxy upstream list -o json` reads back the same field
		// whether or not the daemon is up. Omitted when never configured.
		if srv.TrustMode != "" {
			servers[i]["trust_mode"] = srv.TrustMode
		}
	}

	return outputServers(servers)
}

func outputServers(servers []map[string]interface{}) error {
	// Sort servers alphabetically by name for consistent output
	sort.Slice(servers, func(i, j int) bool {
		nameI := getStringField(servers[i], "name")
		nameJ := getStringField(servers[j], "name")
		return nameI < nameJ
	})

	// Get the output formatter based on global flags
	formatter, err := GetOutputFormatter()
	if err != nil {
		return output.NewStructuredError(output.ErrCodeInvalidOutputFormat, err.Error()).
			WithGuidance("Use -o table, -o json, or -o yaml")
	}

	outputFormat := ResolveOutputFormat()

	// For structured formats (json, yaml), output raw data
	if outputFormat == "json" || outputFormat == "yaml" {
		result, err := formatter.Format(servers)
		if err != nil {
			return fmt.Errorf("failed to format output: %w", err)
		}
		fmt.Println(result)
		return nil
	}

	// For table format, build headers and rows with formatted data
	headers := []string{"", "NAME", "PROTOCOL", "TOOLS", "STATUS", "ACTION"}
	rows := upstreamServerRows(servers)

	result, err := formatter.FormatTable(headers, rows)
	if err != nil {
		return fmt.Errorf("failed to format table: %w", err)
	}
	fmt.Print(result)
	return nil
}

// serverHoldSummary reports whether any of a server's tools need human review
// (count > 0 is the trigger — a record can be both blocked and pending, so the
// number is not an exact tool total) plus a short label naming the breakdown.
//
// GH #938 finding 3: the quarantine counts have always been in the
// GET /api/v1/servers payload (contracts.QuarantineStats) but `upstream list`
// dropped them, so a server whose only tool was held by the scan gate still
// rendered a green "✅ Connected (1 tool)". Blocked (disabled) tools are
// included because they are equally invisible in the connected/tool-count view.
func serverHoldSummary(srv map[string]interface{}) (count int, label string) {
	q, ok := srv["quarantine"].(map[string]interface{})
	if !ok {
		return 0, ""
	}
	pending := getIntField(q, "pending_count")
	changed := getIntField(q, "changed_count")
	blocked := getIntField(q, "blocked_count")

	var parts []string
	if pending > 0 {
		parts = append(parts, fmt.Sprintf("%d pending", pending))
	}
	if changed > 0 {
		parts = append(parts, fmt.Sprintf("%d changed", changed))
	}
	if blocked > 0 {
		parts = append(parts, fmt.Sprintf("%d blocked", blocked))
	}
	if len(parts) == 0 {
		return 0, ""
	}
	return pending + changed + blocked, strings.Join(parts, ", ")
}

// upstreamServerRows builds the `mcpproxy upstream list` table rows.
func upstreamServerRows(servers []map[string]interface{}) [][]string {
	rows := make([][]string, 0, len(servers))

	for _, srv := range servers {
		name := getStringField(srv, "name")
		protocol := getStringField(srv, "protocol")
		toolCount := getIntField(srv, "tool_count")

		// Extract unified health status
		healthData, _ := srv["health"].(map[string]interface{})
		healthLevel := "unknown"
		healthAdminState := "enabled"
		healthSummary := getStringField(srv, "status") // fallback to old status
		healthAction := ""
		healthDetail := ""

		if healthData != nil {
			healthLevel = getStringField(healthData, "level")
			healthAdminState = getStringField(healthData, "admin_state")
			healthSummary = getStringField(healthData, "summary")
			healthAction = getStringField(healthData, "action")
			healthDetail = getStringField(healthData, "detail")
		}

		// Status emoji based on health level and admin state
		statusEmoji := "⚪" // unknown
		switch healthAdminState {
		case "disabled":
			statusEmoji = "⏸️ " // paused
		case "quarantined":
			statusEmoji = "🔒" // locked
		default:
			switch healthLevel {
			case "healthy":
				statusEmoji = "✅"
			case "degraded":
				statusEmoji = "⚠️ "
			case "unhealthy":
				statusEmoji = "❌"
			}
		}

		// Format action as CLI command hint
		actionHint := "-"
		switch healthAction {
		case "login":
			actionHint = fmt.Sprintf("auth login --server=%s", name)
		case "restart":
			actionHint = fmt.Sprintf("upstream restart %s", name)
		case "enable":
			actionHint = fmt.Sprintf("upstream enable %s", name)
		case "approve":
			actionHint = "Approve in Web UI"
		case "view_logs":
			actionHint = fmt.Sprintf("upstream logs %s", name)
		case health.ActionSetSecret:
			if healthDetail != "" {
				actionHint = fmt.Sprintf("Set %s", healthDetail)
			} else {
				actionHint = "Set secret in config"
			}
		case health.ActionConfigure:
			actionHint = "Edit config"
		}

		// GH #938 finding 3: a tool held by the scan gate (or awaiting approval,
		// or blocked) must not hide behind a green "Connected (N tools)". Name
		// the hold in STATUS, downgrade the all-clear emoji, and point the
		// operator at the view that carries the hold evidence.
		if holds, holdLabel := serverHoldSummary(srv); holds > 0 {
			healthSummary = fmt.Sprintf("%s · %s held", healthSummary, holdLabel)
			if statusEmoji == "✅" {
				statusEmoji = "⚠️ "
			}
			if actionHint == "-" {
				actionHint = fmt.Sprintf("tools list --server=%s", name)
			}
		}

		rows = append(rows, []string{
			statusEmoji,
			name,
			protocol,
			fmt.Sprintf("%d", toolCount),
			healthSummary,
			actionHint,
		})
	}

	return rows
}
