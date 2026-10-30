package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/reqcontext"
)

func runUpstreamEnable(cmd *cobra.Command, args []string) error {
	if upstreamAll {
		if upstreamServerName != "" || len(args) > 0 {
			return fmt.Errorf("do not combine --all with a specific server")
		}
		return runUpstreamBulkAction("enable", upstreamForce)
	}
	serverName, err := resolveServerName(args, true)
	if err != nil {
		return err
	}
	return runUpstreamAction(serverName, "enable")
}

func runUpstreamDisable(cmd *cobra.Command, args []string) error {
	if upstreamAll {
		if upstreamServerName != "" || len(args) > 0 {
			return fmt.Errorf("do not combine --all with a specific server")
		}
		return runUpstreamBulkAction("disable", upstreamForce)
	}
	serverName, err := resolveServerName(args, true)
	if err != nil {
		return err
	}
	return runUpstreamAction(serverName, "disable")
}

func runUpstreamRestart(cmd *cobra.Command, args []string) error {
	if upstreamAll {
		if upstreamServerName != "" || len(args) > 0 {
			return fmt.Errorf("do not combine --all with a specific server")
		}
		return runUpstreamBulkAction("restart", false) // restart doesn't need confirmation
	}
	serverName, err := resolveServerName(args, true)
	if err != nil {
		return err
	}
	return runUpstreamAction(serverName, "restart")
}

func resolveServerName(args []string, allowAll bool) (string, error) {
	// Prefer --server, but allow positional for parity with other commands
	if upstreamServerName != "" && len(args) > 0 {
		if args[0] != upstreamServerName {
			return "", fmt.Errorf("specify server once, either as positional or with --server")
		}
	}

	if upstreamServerName != "" {
		return upstreamServerName, nil
	}

	if len(args) > 0 {
		return args[0], nil
	}

	if allowAll {
		return "", fmt.Errorf("server name required (or use --all)")
	}

	return "", fmt.Errorf("server name required")
}

// validateServerExists checks if a server exists in the configuration
func validateServerExists(cfg *config.Config, serverName string) error {
	for _, srv := range cfg.Servers {
		if srv.Name == serverName {
			return nil
		}
	}
	return fmt.Errorf("server '%s' not found in configuration", serverName)
}

func runUpstreamAction(serverName, action string) error {
	// Create context with correlation ID and request source tracking
	ctx := reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Load configuration
	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading configuration: %v\n", err)
		return err
	}

	// Validate server exists
	if err := validateServerExists(globalConfig, serverName); err != nil {
		return err
	}

	// Create logger
	logger, err := createUpstreamLogger(upstreamLogLevel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating logger: %v\n", err)
		return err
	}

	// Require daemon for actions
	client, ok := newDaemonClient(globalConfig, logger.Sugar())
	if !ok {
		return fmt.Errorf("server actions require running daemon. Start with: mcpproxy serve")
	}

	fmt.Printf("Performing action '%s' on server '%s'...\n", action, serverName)

	err = client.ServerAction(ctx, serverName, action)
	if err != nil {
		return fmt.Errorf("failed to %s server: %w", action, err)
	}

	fmt.Printf("✅ Successfully %sed server '%s'\n", action, serverName)
	return nil
}

// T081-T082: Updated to use new bulk operation endpoints
func runUpstreamBulkAction(action string, force bool) error {
	// Create context with correlation ID and request source tracking
	ctx := reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI)
	// Use a longer parent context (2 minutes) to allow multiple operations
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()

	// Load configuration
	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading configuration: %v\n", err)
		return err
	}

	// Create logger
	logger, err := createUpstreamLogger(upstreamLogLevel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating logger: %v\n", err)
		return err
	}

	// Require daemon
	client, ok := newDaemonClient(globalConfig, logger.Sugar())
	if !ok {
		return fmt.Errorf("server actions require running daemon. Start with: mcpproxy serve")
	}

	// Get server count for confirmation
	servers, err := client.GetServers(ctx)
	if err != nil {
		return fmt.Errorf("failed to get server list: %w", err)
	}

	if len(servers) == 0 {
		fmt.Printf("⚠️  No servers configured\n")
		return nil
	}

	// Require confirmation for enable/disable --all
	if action == "enable" || action == "disable" {
		confirmed, err := confirmBulkAction(action, len(servers), force)
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Println("Operation cancelled")
			return nil
		}
	}

	// Call appropriate bulk operation endpoint
	var result *cliclient.BulkOperationResult
	switch action {
	case "restart":
		result, err = client.RestartAll(ctx)
	case "enable":
		result, err = client.EnableAll(ctx)
	case "disable":
		result, err = client.DisableAll(ctx)
	default:
		return fmt.Errorf("unknown bulk action: %s", action)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ Bulk %s failed: %v\n", action, err)
		return err
	}

	// Display results
	actionTitle := action
	if len(action) > 0 {
		actionTitle = strings.ToUpper(action[:1]) + action[1:]
	}
	fmt.Printf("\n%s Operation Results:\n", actionTitle)
	fmt.Printf("  Total servers:      %d\n", result.Total)
	fmt.Printf("  ✅ Successful:      %d\n", result.Successful)
	fmt.Printf("  ❌ Failed:          %d\n", result.Failed)

	// Show errors if any
	if len(result.Errors) > 0 {
		fmt.Printf("\nErrors:\n")
		for serverName, errMsg := range result.Errors {
			fmt.Printf("  • %s: %s\n", serverName, errMsg)
		}
	}

	// Return error if any servers failed
	if result.Failed > 0 {
		return fmt.Errorf("%d server(s) failed to %s", result.Failed, action)
	}

	return nil
}
