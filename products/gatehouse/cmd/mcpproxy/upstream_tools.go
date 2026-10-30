package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/reqcontext"
)

// runUpstreamToolAction toggles a single tool for a server via the daemon.
// The action verb ("enable"/"disable") is derived from `enabled` so the
// surface stays narrow.
func runUpstreamToolAction(serverName, toolName string, enabled bool) error {
	verb := "enable"
	if !enabled {
		verb = "disable"
	}

	ctx := reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading configuration: %v\n", err)
		return err
	}
	if err := validateServerExists(globalConfig, serverName); err != nil {
		return err
	}

	logger, err := createUpstreamLogger(upstreamLogLevel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating logger: %v\n", err)
		return err
	}

	client, ok := newDaemonClient(globalConfig, logger.Sugar())
	if !ok {
		return fmt.Errorf("tool actions require running daemon. Start with: mcpproxy serve")
	}

	// "enable" / "disable" are ASCII verbs, so an inline ASCII-only
	// title-case is fine here and avoids the deprecated strings.Title.
	titleVerb := strings.ToUpper(verb[:1]) + verb[1:]
	fmt.Printf("%sing tool '%s' on server '%s'...\n", titleVerb, toolName, serverName)
	if err := client.SetToolEnabled(ctx, serverName, toolName, enabled); err != nil {
		return fmt.Errorf("failed to %s tool: %w", verb, err)
	}
	fmt.Printf("✅ Tool '%s' %sd on server '%s'\n", toolName, verb, serverName)
	return nil
}

// runUpstreamToolBulkAction enables or disables every known tool for a server.
func runUpstreamToolBulkAction(serverName string, enabled bool) error {
	verb := "enable-all"
	if !enabled {
		verb = "disable-all"
	}

	ctx := reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI)
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error loading configuration: %v\n", err)
		return err
	}
	if err := validateServerExists(globalConfig, serverName); err != nil {
		return err
	}

	logger, err := createUpstreamLogger(upstreamLogLevel)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error creating logger: %v\n", err)
		return err
	}

	client, ok := newDaemonClient(globalConfig, logger.Sugar())
	if !ok {
		return fmt.Errorf("tool actions require running daemon. Start with: mcpproxy serve")
	}

	fmt.Printf("Running tools %s on server '%s'...\n", verb, serverName)
	changed, err := client.SetAllToolsEnabled(ctx, serverName, enabled)
	if err != nil {
		return fmt.Errorf("failed to %s tools: %w", verb, err)
	}
	if changed == 0 {
		fmt.Printf("ℹ️  No tools changed (already in target state) on server '%s'\n", serverName)
		return nil
	}
	state := "enabled"
	if !enabled {
		state = "disabled"
	}
	fmt.Printf("✅ %d tool(s) %s on server '%s'\n", changed, state, serverName)
	return nil
}
