package main

import (
	"time"

	"github.com/spf13/cobra"
)

var (
	toolsCmd = &cobra.Command{
		Use:   "tools",
		Short: "Tools management commands",
		Long:  "Commands for managing and debugging MCP tools from upstream servers",
	}

	toolsListCmd = &cobra.Command{
		Use:   "list",
		Short: "List tools from upstream servers",
		Long: `List all available tools. Without --server, lists every tool across all
configured servers from the running daemon (global view). With --server,
lists tools from that specific server only.

Examples:
  mcpproxy tools list                            # global list, all servers
  mcpproxy tools list -o json                    # JSON output
  mcpproxy tools list --status disabled          # only disabled/config-denied
  mcpproxy tools list --risk read                # read-only tools
  mcpproxy tools list --approval pending         # tools pending approval
  mcpproxy tools list --server=github-server     # server-scoped (debug mode)
  mcpproxy tools list --server=github-server --log-level=trace`,
		RunE: runToolsList,
	}

	toolsEnableCmd = &cobra.Command{
		Use:   "enable <server:tool> [<server:tool>...]",
		Short: "Enable one or more tools",
		Long: `Enable one or more tools by their server:tool identifier.

Multiple targets are processed independently. If any target fails, the
command exits non-zero but all other targets are still attempted.

Examples:
  mcpproxy tools enable github:create_issue
  mcpproxy tools enable github:create_issue github:list_repos`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runToolsSetEnabled(args, true)
		},
	}

	toolsDisableCmd = &cobra.Command{
		Use:   "disable <server:tool> [<server:tool>...]",
		Short: "Disable one or more tools",
		Long: `Disable one or more tools by their server:tool identifier.

Multiple targets are processed independently. If any target fails, the
command exits non-zero but all other targets are still attempted.

Examples:
  mcpproxy tools disable github:create_issue
  mcpproxy tools disable github:create_issue memory:foo`,
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runToolsSetEnabled(args, false)
		},
	}

	// Command flags
	serverName     string
	toolsLogLevel  string
	configPath     string
	timeout        time.Duration
	traceTransport bool // Enable HTTP/SSE frame-by-frame tracing

	// Global list filter flags (T019)
	toolsStatusFilter   string // enabled | disabled | config-denied
	toolsRiskFilter     string // read | write | destructive
	toolsApprovalFilter string // approved | pending | changed
)

// GetToolsCommand returns the tools command for adding to the root command
func GetToolsCommand() *cobra.Command {
	return toolsCmd
}

func init() {
	// toolsCmd will be added to rootCmd in main.go
	toolsCmd.AddCommand(toolsListCmd)
	toolsCmd.AddCommand(toolsEnableCmd)
	toolsCmd.AddCommand(toolsDisableCmd)
	toolsCmd.AddCommand(newToolsApproveCmd())
	toolsCmd.AddCommand(newToolsRejectCmd())
	toolsCmd.AddCommand(newToolsPreflightCmd())

	initToolsFlags()
}

// initToolsFlags registers flags on toolsListCmd. Extracted so tests can call
// it independently of init().
func initToolsFlags() {
	// Define flags for tools list command — reset to avoid double-registration
	// in tests that call this function more than once.
	toolsListCmd.ResetFlags()

	toolsListCmd.Flags().StringVarP(&serverName, "server", "s", "", "Name of the upstream server to query (optional; omit for global list)")
	toolsListCmd.Flags().StringVarP(&toolsLogLevel, "log-level", "l", "info", "Log level (trace, debug, info, warn, error)")
	toolsListCmd.Flags().StringVarP(&configPath, "config", "c", "", "Path to MCP configuration file (default: ~/.mcpproxy/mcp_config.json)")
	toolsListCmd.Flags().DurationVarP(&timeout, "timeout", "t", 30*time.Second, "Connection timeout")
	toolsListCmd.Flags().BoolVar(&traceTransport, "trace-transport", false, "Enable detailed HTTP/SSE frame-by-frame tracing")

	// Global-list filter flags (T019)
	toolsListCmd.Flags().StringVar(&toolsStatusFilter, "status", "", "Filter by state: enabled, disabled, config-denied")
	toolsListCmd.Flags().StringVar(&toolsRiskFilter, "risk", "", "Filter by risk: read, write, destructive")
	toolsListCmd.Flags().StringVar(&toolsApprovalFilter, "approval", "", "Filter by approval: approved, pending, changed")

	// Note: -o/--output flag is inherited from root command via globalOutputFormat
	// Note: --server is NOT marked required — global list works without it.

	toolsListCmd.Example = `  # Global list (all servers) — requires daemon
  mcpproxy tools list
  mcpproxy tools list -o json | jq '.[0]'
  mcpproxy tools list --status disabled

  # Server-scoped list (standalone or daemon)
  mcpproxy tools list --server=github-server --log-level=trace

  # Use custom config file
  mcpproxy tools list --server=local-script --config=/path/to/config.json

  # Set custom timeout
  mcpproxy tools list --server=slow-server --timeout=60s`
}
