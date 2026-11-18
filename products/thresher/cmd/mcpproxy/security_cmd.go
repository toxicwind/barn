package main

import (
	"fmt"

	"github.com/spf13/cobra"
	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
)

var (
	// security scan flags
	secScanAsync  bool
	secScanDryRun bool
	secScanners   string
	secScanAll    bool

	// security approve flags
	secApproveForce bool

	// security configure flags
	secConfigEnv []string
)

// GetSecurityCommand returns the security parent command.
func GetSecurityCommand() *cobra.Command {
	securityCmd := &cobra.Command{
		Use:   "security",
		Short: "Security scanner management and server scanning",
		Long: `Commands for managing security scanners, scanning MCP servers,
and reviewing scan results.

Security scanners run as Docker containers and analyze upstream MCP servers
for vulnerabilities, tool poisoning attacks, and other security issues.

Examples:
  mcpproxy security scanners
  mcpproxy security enable mcp-scan
  mcpproxy security disable mcp-scan
  mcpproxy security scan github-server
  mcpproxy security report github-server
  mcpproxy security overview`,
	}

	securityCmd.AddCommand(newSecurityScannersCmd())
	securityCmd.AddCommand(newSecurityEnableCmd())
	securityCmd.AddCommand(newSecurityDisableCmd())
	// Keep old names as hidden aliases for backwards compatibility
	securityCmd.AddCommand(newSecurityInstallCmd())
	securityCmd.AddCommand(newSecurityRemoveCmd())
	securityCmd.AddCommand(newSecurityConfigureCmd())
	securityCmd.AddCommand(newSecurityScanCmd())
	securityCmd.AddCommand(newSecurityStatusCmd())
	securityCmd.AddCommand(newSecurityReportCmd())
	securityCmd.AddCommand(newSecurityApproveCmd())
	securityCmd.AddCommand(newSecurityRejectCmd())
	securityCmd.AddCommand(newSecurityRescanCmd())
	securityCmd.AddCommand(newSecurityOverviewCmd())
	securityCmd.AddCommand(newSecurityIntegrityCmd())
	securityCmd.AddCommand(newSecurityCancelAllCmd())

	return securityCmd
}

// newSecurityCLIClient creates a cliclient.Client connected to the running MCPProxy.
//
// Honors the package-level --config and --data-dir flags from main.go so that
// `mcpproxy security ...` commands behave consistently with `mcpproxy serve`,
// `mcpproxy status`, and `mcpproxy upstream ...`.
func newSecurityCLIClient() (*cliclient.Client, *config.Config, error) {
	cfg, err := loadSecurityConfig()
	if err != nil {
		return nil, nil, fmt.Errorf("failed to load config: %w", err)
	}

	logger, _ := zap.NewProduction()
	defer func() { _ = logger.Sync() }()

	// Socket first, then TCP fallback. Never generate an API key here —
	// a fabricated key cannot match the running daemon's.
	client, ok := newDaemonClient(cfg, logger.Sugar())
	if !ok {
		return nil, nil, fmt.Errorf("mcpproxy daemon is not reachable. Start with: mcpproxy serve")
	}

	return client, cfg, nil
}

func newSecurityScannersCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "scanners",
		Short: "List available and installed scanners",
		Long: `List all security scanners from the registry and their current status.

Examples:
  mcpproxy security scanners
  mcpproxy security scanners -o json`,
		RunE: runSecurityScanners,
	}
}

func newSecurityEnableCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "enable <scanner-id>",
		Short: "Enable a security scanner",
		Long: `Enable a security scanner by pulling its Docker image.

Docker-based scanners belong to the opt-in deep-scan layer (Spec 077): they
only run during scans when security.deep_scan.enabled=true in mcp_config.json.
Enabling one here while deep scan is off prints a reminder.

Examples:
  mcpproxy security enable mcp-scan
  mcpproxy security enable cisco-mcp-scanner`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityInstall,
	}
}

func newSecurityDisableCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "disable <scanner-id>",
		Short: "Disable a security scanner",
		Long: `Disable a security scanner and clean up its Docker image.

Examples:
  mcpproxy security disable mcp-scan`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityRemove,
	}
}

func newSecurityInstallCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:    "install <scanner-id>",
		Short:  "Install a security scanner (alias for enable)",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		RunE:   runSecurityInstall,
	}
	return cmd
}

func newSecurityRemoveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:    "remove <scanner-id>",
		Short:  "Remove an installed scanner (alias for disable)",
		Hidden: true,
		Args:   cobra.ExactArgs(1),
		RunE:   runSecurityRemove,
	}
	return cmd
}

func newSecurityConfigureCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "configure <scanner-id>",
		Short: "Configure scanner environment variables",
		Long: `Set API keys and other environment variables for a scanner.

Use --env KEY=VALUE (repeatable) to set one or more environment variables.

Examples:
  mcpproxy security configure mcp-scan --env OPENAI_API_KEY=sk-xxx
  mcpproxy security configure cisco-mcp-scanner --env API_KEY=xxx --env API_SECRET=yyy`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityConfigure,
	}

	cmd.Flags().StringArrayVar(&secConfigEnv, "env", nil, "Environment variable in KEY=VALUE format (repeatable)")
	_ = cmd.MarkFlagRequired("env")

	return cmd
}

func newSecurityScanCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "scan [server]",
		Short: "Scan a server with security scanners",
		Long: `Start a security scan on an upstream MCP server.

By default, blocks until the scan completes and shows a summary.
Use --async to start the scan and return immediately.
Use --all to scan all servers at once with a progress table.

Examples:
  mcpproxy security scan github-server
  mcpproxy security scan github-server --async
  mcpproxy security scan github-server --dry-run
  mcpproxy security scan github-server --scanners mcp-scan,cisco-mcp-scanner
  mcpproxy security scan --all
  mcpproxy security scan --all --scanners mcp-scan`,
		Args: cobra.MaximumNArgs(1),
		RunE: runSecurityScan,
	}

	cmd.Flags().BoolVar(&secScanAll, "all", false, "Scan all servers (shows progress table)")
	cmd.Flags().BoolVar(&secScanAsync, "async", false, "Start scan and return immediately without waiting")
	cmd.Flags().BoolVar(&secScanDryRun, "dry-run", false, "Simulate scan without executing")
	cmd.Flags().StringVar(&secScanners, "scanners", "", "Comma-separated scanner IDs to use (default: all installed)")

	return cmd
}

func newSecurityStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status <server>",
		Short: "Show current scan status for a server",
		Long: `Display the current or most recent scan status for a server.

Examples:
  mcpproxy security status github-server
  mcpproxy security status github-server -o json`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityStatus,
	}
}

func newSecurityReportCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "report <server>",
		Short: "View the latest scan report for a server",
		Long: `Display the latest security scan report for a server.

Supports multiple output formats:
  -o table  Human-readable summary (default)
  -o json   Full JSON report
  -o yaml   Full YAML report
  -o sarif  Raw SARIF output from scanners

Examples:
  mcpproxy security report github-server
  mcpproxy security report github-server -o json
  mcpproxy security report github-server -o sarif`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityReport,
	}
}

func newSecurityApproveCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "approve <server>",
		Short: "Approve a server after security scan",
		Long: `Approve a server's security posture based on scan results.
Use --force to approve even if findings exist.

Examples:
  mcpproxy security approve github-server
  mcpproxy security approve github-server --force`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityApprove,
	}

	cmd.Flags().BoolVar(&secApproveForce, "force", false, "Force approval even with findings")

	return cmd
}

func newSecurityRejectCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "reject <server>",
		Short: "Reject a server and quarantine it",
		Long: `Reject a server's security posture and quarantine it.

Examples:
  mcpproxy security reject github-server`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityReject,
	}
}

func newSecurityRescanCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "rescan <server>",
		Short: "Re-run security scanners on a server",
		Long: `Re-run all installed security scanners on a server.
This is equivalent to running 'security scan' again.

Examples:
  mcpproxy security rescan github-server
  mcpproxy security rescan github-server --async`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityScan, // Reuses scan logic
	}

	cmd.Flags().BoolVar(&secScanAsync, "async", false, "Start scan and return immediately without waiting")
	cmd.Flags().BoolVar(&secScanDryRun, "dry-run", false, "Simulate scan without executing")
	cmd.Flags().StringVar(&secScanners, "scanners", "", "Comma-separated scanner IDs to use (default: all installed)")

	return cmd
}

func newSecurityOverviewCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "overview",
		Short: "Show security dashboard summary",
		Long: `Display an aggregate security overview including scanner counts,
scan statistics, and finding summaries.

Examples:
  mcpproxy security overview
  mcpproxy security overview -o json`,
		RunE: runSecurityOverview,
	}
}

func newSecurityIntegrityCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "integrity <server>",
		Short: "Check runtime integrity of a server",
		Long: `Verify the runtime integrity of a server against its approved baseline.
Checks for changes to tool descriptions, Docker images, and source hashes.

Examples:
  mcpproxy security integrity github-server
  mcpproxy security integrity github-server -o json`,
		Args: cobra.ExactArgs(1),
		RunE: runSecurityIntegrity,
	}
}

func newSecurityCancelAllCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "cancel-all",
		Short: "Cancel a running batch scan",
		Long: `Cancel the current batch security scan in progress.
Any pending server scans will be skipped. Running scans may complete.

Examples:
  mcpproxy security cancel-all`,
		RunE: runSecurityCancelAll,
	}
}
