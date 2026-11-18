package main

import (
	"github.com/spf13/cobra"
)

var (
	upstreamCmd = &cobra.Command{
		Use:   "upstream",
		Short: "Manage upstream MCP servers",
		Long:  "Commands for managing and monitoring upstream MCP servers",
	}

	upstreamListCmd = &cobra.Command{
		Use:   "list",
		Short: "List all upstream servers with status",
		Long: `List all configured upstream MCP servers with connection status, tool counts, and errors.

Examples:
  mcpproxy upstream list
  mcpproxy upstream list --output=json
  mcpproxy upstream list --log-level=debug`,
		RunE: runUpstreamList,
	}

	upstreamLogsCmd = &cobra.Command{
		Use:   "logs [server-name]",
		Short: "Show logs for a specific server",
		Long: `Display recent log entries from a specific upstream server.

Examples:
  mcpproxy upstream logs --server github-server
  mcpproxy upstream logs --server github-server --tail=100
  mcpproxy upstream logs weather-api --follow`,
		Args: cobra.MaximumNArgs(1),
		RunE: runUpstreamLogs,
	}

	upstreamEnableCmd = &cobra.Command{
		Use:   "enable [server-name]",
		Short: "Enable a server",
		Args:  cobra.MaximumNArgs(1),
		RunE:  runUpstreamEnable,
	}

	upstreamDisableCmd = &cobra.Command{
		Use:   "disable [server-name]",
		Short: "Disable a server",
		Args:  cobra.MaximumNArgs(1),
		RunE:  runUpstreamDisable,
	}

	upstreamRestartCmd = &cobra.Command{
		Use:   "restart [server-name]",
		Short: "Restart a server",
		Args:  cobra.MaximumNArgs(1),
		RunE:  runUpstreamRestart,
	}

	upstreamAddCmd = &cobra.Command{
		Use:   "add <name> [url] [-- command args...]",
		Short: "Add an upstream MCP server",
		Long: `Add a new upstream MCP server to the configuration.

For HTTP-based servers:
  mcpproxy upstream add notion https://mcp.notion.com/sse
  mcpproxy upstream add weather https://api.weather.com/mcp --header "Authorization: Bearer token"

For stdio-based servers (use -- to separate command):
  mcpproxy upstream add fs -- npx -y @anthropic/mcp-server-filesystem /path/to/dir
  mcpproxy upstream add sqlite -- uvx mcp-server-sqlite --db mydb.db

New servers are quarantined by default for security. Use the web UI to approve them.`,
		RunE: runUpstreamAdd,
	}

	upstreamRemoveCmd = &cobra.Command{
		Use:   "remove <name>",
		Short: "Remove an upstream MCP server",
		Long: `Remove an upstream MCP server from the configuration.

Examples:
  mcpproxy upstream remove notion
  mcpproxy upstream remove fs --yes  # Skip confirmation`,
		Args: cobra.ExactArgs(1),
		RunE: runUpstreamRemove,
	}

	upstreamAddJSONCmd = &cobra.Command{
		Use:   "add-json <name> <json>",
		Short: "Add an upstream server using JSON configuration",
		Long: `Add a new upstream MCP server using a JSON configuration object.

Examples:
  mcpproxy upstream add-json weather '{"url":"https://api.weather.com/mcp","headers":{"Authorization":"Bearer token"}}'
  mcpproxy upstream add-json sqlite '{"command":"uvx","args":["mcp-server-sqlite","--db","mydb.db"]}'`,
		Args: cobra.ExactArgs(2),
		RunE: runUpstreamAddJSON,
	}

	upstreamPatchCmd = &cobra.Command{
		Use:   "patch <name>",
		Short: "Update headers / env on an existing upstream server",
		Long: `Update HTTP headers and stdio environment variables on an existing upstream server.

The PATCH endpoint uses JSON Merge Patch semantics: keys you specify are
upserted, keys you delete with -remove flags are explicitly removed, and
every other key on the stored config is preserved. So you can safely
rotate a single header without seeing or touching the rest — including
sensitive values the backend redacts from list / inspect responses.

Examples:
  # rotate the Authorization header on the synapbus server
  mcpproxy upstream patch synapbus --header "Authorization: Bearer new-token"

  # add a custom header without disturbing existing ones
  mcpproxy upstream patch synapbus --header "X-Trace: on"

  # remove a header
  mcpproxy upstream patch synapbus --header-remove "X-Stale"

  # set + remove in a single round-trip
  mcpproxy upstream patch synapbus --header "X-New: v" --header-remove "X-Old"

  # update env vars on a stdio server
  mcpproxy upstream patch obsidian-pilot --env "LOG_LEVEL=debug" --env-remove "OLD_VAR"

Flags are repeatable. The corresponding null in the JSON Merge Patch body
is constructed automatically — you never have to think about wire format.`,
		Args: cobra.ExactArgs(1),
		RunE: runUpstreamPatch,
	}

	upstreamInspectCmd = &cobra.Command{
		Use:   "inspect <server-name>",
		Short: "Inspect tool approval status for a server",
		Long: `Show tool-level quarantine status for all tools on a server.
Displays approval status, hashes, and any detected description/schema changes.

Examples:
  mcpproxy upstream inspect github
  mcpproxy upstream inspect github --output=json
  mcpproxy upstream inspect github --tool create_issue`,
		Args: cobra.ExactArgs(1),
		RunE: runUpstreamInspect,
	}

	upstreamApproveCmd = &cobra.Command{
		Use:   "approve <server-name> [tool-names...]",
		Short: "Approve quarantined tools for a server",
		Long: `Approve pending or changed tools so they can be used by AI agents.
Without specific tool names, approves all pending/changed tools.

Examples:
  mcpproxy upstream approve github                      # Approve all tools
  mcpproxy upstream approve github create_issue list_repos  # Approve specific tools`,
		Args: cobra.MinimumNArgs(1),
		RunE: runUpstreamApprove,
	}

	// Per-tool enable/disable. The "tools" subcommand groups the four
	// operations so the surface mirrors the server-level
	// "upstream enable/disable" + "upstream enable --all/--all" without
	// shadowing those flags.
	upstreamToolsCmd = &cobra.Command{
		Use:   "tools",
		Short: "Manage per-tool enable/disable state for a server",
		Long: `Enable or disable individual tools (or all tools) of an upstream server.

Disabled tools are filtered out of retrieve_tools results and rejected on
direct call_tool_* invocations. Use this to suppress noisy or unused tools
without removing the whole server.`,
	}

	upstreamToolsEnableCmd = &cobra.Command{
		Use:   "enable <server-name> <tool-name>",
		Short: "Enable a tool for a server",
		Args:  cobra.ExactArgs(2),
		RunE:  func(_ *cobra.Command, args []string) error { return runUpstreamToolAction(args[0], args[1], true) },
	}

	upstreamToolsDisableCmd = &cobra.Command{
		Use:   "disable <server-name> <tool-name>",
		Short: "Disable a tool for a server",
		Args:  cobra.ExactArgs(2),
		RunE:  func(_ *cobra.Command, args []string) error { return runUpstreamToolAction(args[0], args[1], false) },
	}

	upstreamToolsEnableAllCmd = &cobra.Command{
		Use:   "enable-all <server-name>",
		Short: "Enable every tool for a server",
		Args:  cobra.ExactArgs(1),
		RunE:  func(_ *cobra.Command, args []string) error { return runUpstreamToolBulkAction(args[0], true) },
	}

	upstreamToolsDisableAllCmd = &cobra.Command{
		Use:   "disable-all <server-name>",
		Short: "Disable every tool for a server",
		Args:  cobra.ExactArgs(1),
		RunE:  func(_ *cobra.Command, args []string) error { return runUpstreamToolBulkAction(args[0], false) },
	}

	upstreamImportCmd = &cobra.Command{
		Use:   "import <path>",
		Short: "Import servers from external configuration file",
		Long: `Import MCP server configurations from Claude Desktop, Claude Code, Cursor IDE, Codex CLI, or Gemini CLI.

Supported formats:
  - Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json
  - Claude Code: .claude/settings.json or .claude.json
  - Cursor IDE: ~/.cursor/mcp.json
  - Codex CLI: ~/.codex/config.toml
  - Gemini CLI: ~/.gemini/settings.json

The format is auto-detected from file content. Imported servers are quarantined by default.
Use --no-quarantine to skip quarantine for trusted configs.

Examples:
  # Import all servers from Claude Desktop config
  mcpproxy upstream import ~/Library/Application\ Support/Claude/claude_desktop_config.json

  # Preview import without making changes
  mcpproxy upstream import --dry-run ~/Library/Application\ Support/Claude/claude_desktop_config.json

  # Import specific server by name
  mcpproxy upstream import --server github ~/.cursor/mcp.json

  # Force format detection
  mcpproxy upstream import --format claude-desktop config.json

  # Import without quarantine (trusted configs)
  mcpproxy upstream import --no-quarantine ~/Library/Application\ Support/Claude/claude_desktop_config.json`,
		Args: cobra.ExactArgs(1),
		RunE: runUpstreamImport,
	}

	// Command flags
	upstreamLogLevel   string
	upstreamConfigPath string
	upstreamLogsTail   int
	upstreamLogsFollow bool
	upstreamAll        bool
	upstreamForce      bool
	upstreamServerName string

	// Add command flags
	upstreamAddHeaders      []string
	upstreamAddEnvs         []string
	upstreamAddWorkingDir   string
	upstreamAddTransport    string
	upstreamAddIfNotExists  bool
	upstreamAddNoQuarantine bool
	upstreamAddTrustMode    string

	// Remove command flags
	upstreamRemoveYes      bool
	upstreamRemoveIfExists bool

	// Inspect command flags
	upstreamInspectTool string

	// Patch command flags
	upstreamPatchHeaders      []string
	upstreamPatchHeaderRemove []string
	upstreamPatchEnvs         []string
	upstreamPatchEnvRemove    []string
	upstreamPatchInitTimeout  string

	// Import command flags
	upstreamImportServer       string
	upstreamImportFormat       string
	upstreamImportDryRun       bool
	upstreamImportNoQuarantine bool
)

// GetUpstreamCommand returns the upstream command for adding to the root command.
// The upstream command provides subcommands for managing and monitoring upstream
// MCP servers, including list, logs, enable/disable, and restart operations.
func GetUpstreamCommand() *cobra.Command {
	return upstreamCmd
}

func init() {
	// Add subcommands
	upstreamCmd.AddCommand(upstreamListCmd)
	upstreamCmd.AddCommand(upstreamLogsCmd)
	upstreamCmd.AddCommand(upstreamEnableCmd)
	upstreamCmd.AddCommand(upstreamDisableCmd)
	upstreamCmd.AddCommand(upstreamRestartCmd)
	upstreamCmd.AddCommand(upstreamAddCmd)
	upstreamCmd.AddCommand(upstreamRemoveCmd)
	upstreamCmd.AddCommand(upstreamAddJSONCmd)
	upstreamCmd.AddCommand(upstreamPatchCmd)
	upstreamCmd.AddCommand(upstreamInspectCmd)
	upstreamCmd.AddCommand(upstreamApproveCmd)
	upstreamCmd.AddCommand(upstreamImportCmd)
	upstreamCmd.AddCommand(upstreamToolsCmd)
	upstreamToolsCmd.AddCommand(upstreamToolsEnableCmd)
	upstreamToolsCmd.AddCommand(upstreamToolsDisableCmd)
	upstreamToolsCmd.AddCommand(upstreamToolsEnableAllCmd)
	upstreamToolsCmd.AddCommand(upstreamToolsDisableAllCmd)

	// Define flags (note: output format handled by global --output/-o flag from root command)
	upstreamListCmd.Flags().StringVarP(&upstreamLogLevel, "log-level", "l", "warn", "Log level (trace, debug, info, warn, error)")
	upstreamListCmd.Flags().StringVarP(&upstreamConfigPath, "config", "c", "", "Path to MCP configuration file")

	upstreamLogsCmd.Flags().IntVarP(&upstreamLogsTail, "tail", "n", 50, "Number of log lines to show")
	upstreamLogsCmd.Flags().BoolVarP(&upstreamLogsFollow, "follow", "f", false, "Follow log output (requires daemon)")
	upstreamLogsCmd.Flags().StringVarP(&upstreamLogLevel, "log-level", "l", "warn", "Log level")
	upstreamLogsCmd.Flags().StringVarP(&upstreamConfigPath, "config", "c", "", "Path to config file")
	upstreamLogsCmd.Flags().StringVarP(&upstreamServerName, "server", "s", "", "Name of the upstream server")

	// Add --all and --force flags to enable/disable/restart
	upstreamEnableCmd.Flags().BoolVar(&upstreamAll, "all", false, "Enable all servers")
	upstreamEnableCmd.Flags().BoolVar(&upstreamForce, "force", false, "Skip confirmation prompt")
	upstreamEnableCmd.Flags().StringVarP(&upstreamServerName, "server", "s", "", "Name of the upstream server (required unless --all)")

	upstreamDisableCmd.Flags().BoolVar(&upstreamAll, "all", false, "Disable all servers")
	upstreamDisableCmd.Flags().BoolVar(&upstreamForce, "force", false, "Skip confirmation prompt")
	upstreamDisableCmd.Flags().StringVarP(&upstreamServerName, "server", "s", "", "Name of the upstream server (required unless --all)")

	upstreamRestartCmd.Flags().BoolVar(&upstreamAll, "all", false, "Restart all servers")
	upstreamRestartCmd.Flags().StringVarP(&upstreamServerName, "server", "s", "", "Name of the upstream server (required unless --all)")

	// Add command flags
	upstreamAddCmd.Flags().StringArrayVar(&upstreamAddHeaders, "header", nil, "HTTP header in 'Name: value' format (repeatable)")
	upstreamAddCmd.Flags().StringArrayVar(&upstreamAddEnvs, "env", nil, "Environment variable in KEY=value format (repeatable)")
	upstreamAddCmd.Flags().StringVar(&upstreamAddWorkingDir, "working-dir", "", "Working directory for stdio commands")
	upstreamAddCmd.Flags().StringVar(&upstreamAddTransport, "transport", "", "Transport type: http or stdio (auto-detected if not specified)")
	upstreamAddCmd.Flags().BoolVar(&upstreamAddIfNotExists, "if-not-exists", false, "Don't error if server already exists")
	upstreamAddCmd.Flags().BoolVar(&upstreamAddNoQuarantine, "no-quarantine", false, "Don't quarantine the new server (use with caution)")
	upstreamAddCmd.Flags().StringVar(&upstreamAddTrustMode, "trust-mode", "", "Per-server trust tier governing admission AND tool-change approval: auto (approve without scanning), scan (auto-approve only when the offline TPA scan is green), manual (human reviews every change). Unset inherits the default (manual)")

	// Remove command flags
	upstreamRemoveCmd.Flags().BoolVar(&upstreamRemoveYes, "yes", false, "Skip confirmation prompt")
	upstreamRemoveCmd.Flags().BoolVarP(&upstreamRemoveYes, "y", "y", false, "Skip confirmation prompt (short form)")
	upstreamRemoveCmd.Flags().BoolVar(&upstreamRemoveIfExists, "if-exists", false, "Don't error if server doesn't exist")

	// Patch command flags
	upstreamPatchCmd.Flags().StringArrayVar(&upstreamPatchHeaders, "header", nil, "HTTP header to upsert in 'Name: value' format (repeatable)")
	upstreamPatchCmd.Flags().StringArrayVar(&upstreamPatchHeaderRemove, "header-remove", nil, "HTTP header name to delete (repeatable)")
	upstreamPatchCmd.Flags().StringArrayVar(&upstreamPatchEnvs, "env", nil, "Environment variable to upsert in KEY=value format (repeatable)")
	upstreamPatchCmd.Flags().StringArrayVar(&upstreamPatchEnvRemove, "env-remove", nil, "Environment variable name to delete (repeatable)")
	upstreamPatchCmd.Flags().StringVar(&upstreamPatchInitTimeout, "init-timeout", "", "MCP initialize handshake deadline as a duration (e.g. '120s', '3m'); raise for upstreams that warm up before responding to initialize")

	// Inspect command flags
	upstreamInspectCmd.Flags().StringVar(&upstreamInspectTool, "tool", "", "Show details for a specific tool")

	// Import command flags
	upstreamImportCmd.Flags().StringVarP(&upstreamImportServer, "server", "s", "", "Import only a specific server by name")
	upstreamImportCmd.Flags().StringVar(&upstreamImportFormat, "format", "", "Force format (claude-desktop, claude-code, cursor, codex, gemini)")
	upstreamImportCmd.Flags().BoolVar(&upstreamImportDryRun, "dry-run", false, "Preview import without making changes")
	upstreamImportCmd.Flags().BoolVar(&upstreamImportNoQuarantine, "no-quarantine", false, "Don't quarantine imported servers (use with caution)")
}
