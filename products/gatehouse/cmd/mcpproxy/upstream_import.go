package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cli/output"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/configimport"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/reqcontext"
)

// runUpstreamImport handles the 'upstream import' command
func runUpstreamImport(_ *cobra.Command, args []string) error {
	filePath := args[0]

	// Read file content
	content, err := os.ReadFile(filePath)
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeInvalidInput, fmt.Sprintf("failed to read file: %v", err)).
			WithGuidance("Check that the file exists and is readable"), output.ErrCodeInvalidInput)
	}

	// Build import options
	opts := &configimport.ImportOptions{
		Preview:        upstreamImportDryRun,
		SkipQuarantine: upstreamImportNoQuarantine,
		Now:            time.Now(),
	}

	// Parse format hint if provided
	if upstreamImportFormat != "" {
		format := parseImportFormat(upstreamImportFormat)
		if format == configimport.FormatUnknown {
			return outputError(output.NewStructuredError(output.ErrCodeInvalidInput, fmt.Sprintf("unknown format: %s", upstreamImportFormat)).
				WithGuidance("Valid formats: claude-desktop, claude-code, cursor, codex, gemini"), output.ErrCodeInvalidInput)
		}
		opts.FormatHint = format
	}

	// Filter by server name if specified
	if upstreamImportServer != "" {
		opts.ServerNames = []string{upstreamImportServer}
	}

	// Load current configuration to check for existing servers
	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeConfigNotFound, err.Error()).
			WithGuidance("Check that your config file exists and is valid").
			WithRecoveryCommand("mcpproxy doctor"), output.ErrCodeConfigNotFound)
	}

	// Build list of existing server names
	existingNames := make([]string, len(globalConfig.Servers))
	for i, srv := range globalConfig.Servers {
		existingNames[i] = srv.Name
	}
	opts.ExistingServers = existingNames

	// Run import
	result, err := configimport.Import(content, opts)
	if err != nil {
		// Check if it's a format detection error
		var importErr *configimport.ImportError
		if errors.As(err, &importErr) {
			return outputError(output.NewStructuredError(output.ErrCodeInvalidInput, importErr.Message).
				WithGuidance("Use --format to specify the configuration format"), output.ErrCodeInvalidInput)
		}
		return outputError(output.NewStructuredError(output.ErrCodeOperationFailed, err.Error()), output.ErrCodeOperationFailed)
	}

	// Output results based on format
	outputFormat := ResolveOutputFormat()

	if outputFormat == "json" || outputFormat == "yaml" {
		return outputImportResultStructured(result, outputFormat)
	}

	return outputImportResultTable(result, upstreamImportDryRun, upstreamImportNoQuarantine, globalConfig)
}

// parseImportFormat converts a format string to ConfigFormat
func parseImportFormat(format string) configimport.ConfigFormat {
	switch strings.ToLower(format) {
	case "claude-desktop", "claudedesktop":
		return configimport.FormatClaudeDesktop
	case "claude-code", "claudecode":
		return configimport.FormatClaudeCode
	case "cursor":
		return configimport.FormatCursor
	case "codex":
		return configimport.FormatCodex
	case "gemini":
		return configimport.FormatGemini
	default:
		return configimport.FormatUnknown
	}
}

// outputImportResultStructured outputs the import result in JSON/YAML format
func outputImportResultStructured(result *configimport.ImportResult, format string) error {
	// Build output structure
	output := map[string]interface{}{
		"format":      result.Format,
		"format_name": result.FormatDisplayName,
		"summary":     result.Summary,
		"imported":    buildImportedServersOutput(result.Imported),
		"skipped":     result.Skipped,
		"failed":      result.Failed,
		"warnings":    result.Warnings,
	}

	formatter, err := GetOutputFormatter()
	if err != nil {
		return err
	}

	formatted, err := formatter.Format(output)
	if err != nil {
		return fmt.Errorf("failed to format output: %w", err)
	}

	fmt.Println(formatted)
	return nil
}

// buildImportedServersOutput builds the output structure for imported servers
func buildImportedServersOutput(imported []*configimport.ImportedServer) []map[string]interface{} {
	result := make([]map[string]interface{}, len(imported))
	for i, s := range imported {
		result[i] = map[string]interface{}{
			"name":           s.Server.Name,
			"protocol":       s.Server.Protocol,
			"url":            s.Server.URL,
			"command":        s.Server.Command,
			"args":           s.Server.Args,
			"enabled":        s.Server.Enabled,
			"quarantined":    s.Server.Quarantined,
			"source_format":  s.SourceFormat,
			"original_name":  s.OriginalName,
			"fields_skipped": s.FieldsSkipped,
			"warnings":       s.Warnings,
		}
	}
	return result
}

// outputImportResultTable outputs the import result in table format
func outputImportResultTable(result *configimport.ImportResult, dryRun bool, noQuarantine bool, globalConfig *config.Config) error {
	// Header
	if dryRun {
		fmt.Println("🔍 DRY RUN - No changes will be made")
		fmt.Println()
	}

	fmt.Printf("📁 Detected format: %s\n", result.FormatDisplayName)
	fmt.Println()

	// Summary
	fmt.Printf("Summary:\n")
	fmt.Printf("  Total servers found: %d\n", result.Summary.Total)
	fmt.Printf("  To import:          %d\n", result.Summary.Imported)
	fmt.Printf("  Skipped:            %d\n", result.Summary.Skipped)
	fmt.Printf("  Failed:             %d\n", result.Summary.Failed)
	fmt.Println()

	// Show imported servers
	if len(result.Imported) > 0 {
		if dryRun {
			fmt.Println("Servers to import:")
		} else {
			fmt.Println("Imported servers:")
		}

		for _, s := range result.Imported {
			statusIcon := "✅"
			if dryRun {
				statusIcon = "📋"
			}
			fmt.Printf("  %s %s (%s)\n", statusIcon, s.Server.Name, s.Server.Protocol)

			// Show warnings for this server
			if len(s.Warnings) > 0 {
				for _, w := range s.Warnings {
					fmt.Printf("      ⚠️  %s\n", w)
				}
			}

			// Show skipped fields
			if len(s.FieldsSkipped) > 0 {
				fmt.Printf("      ℹ️  Skipped fields: %s\n", strings.Join(s.FieldsSkipped, ", "))
			}
		}
		fmt.Println()
	}

	// Show skipped servers
	if len(result.Skipped) > 0 {
		fmt.Println("Skipped servers:")
		for _, s := range result.Skipped {
			reason := s.Reason
			switch reason {
			case "already_exists":
				reason = "already exists in config"
			case "filtered_out":
				reason = "not in --server filter"
			}
			fmt.Printf("  ⏭️  %s (%s)\n", s.Name, reason)
		}
		fmt.Println()
	}

	// Show failed servers
	if len(result.Failed) > 0 {
		fmt.Println("Failed servers:")
		for _, s := range result.Failed {
			fmt.Printf("  ❌ %s: %s\n", s.Name, s.Details)
		}
		fmt.Println()
	}

	// Show global warnings
	if len(result.Warnings) > 0 {
		fmt.Println("Warnings:")
		for _, w := range result.Warnings {
			fmt.Printf("  ⚠️  %s\n", w)
		}
		fmt.Println()
	}

	// If not dry run and we have servers to import, actually add them
	if !dryRun && len(result.Imported) > 0 {
		err := applyImportedServers(result.Imported, globalConfig)
		if err != nil {
			return err
		}
		if noQuarantine {
			fmt.Println("✅ Servers imported without quarantine. They are ready to use.")
		} else {
			fmt.Println("🔒 New servers are quarantined by default. Approve them in the web UI.")
		}
	}

	return nil
}

// applyImportedServers adds the imported servers to the configuration
func applyImportedServers(imported []*configimport.ImportedServer, globalConfig *config.Config) error {
	// Create context
	ctx := reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Check if daemon is running
	if client, ok := newDaemonClient(globalConfig, nil); ok {
		return applyImportedServersDaemonMode(ctx, client, imported)
	}

	// Direct config file mode
	return applyImportedServersConfigMode(imported, globalConfig)
}

// applyImportedServersDaemonMode adds servers via the daemon
func applyImportedServersDaemonMode(ctx context.Context, client *cliclient.Client, imported []*configimport.ImportedServer) error {
	for _, s := range imported {
		req := &cliclient.AddServerRequest{
			Name:       s.Server.Name,
			URL:        s.Server.URL,
			Command:    s.Server.Command,
			Args:       s.Server.Args,
			Env:        s.Server.Env,
			Headers:    s.Server.Headers,
			WorkingDir: s.Server.WorkingDir,
			Protocol:   s.Server.Protocol,
		}

		// Use the quarantine state from the import result (controlled by --no-quarantine flag)
		quarantined := s.Server.Quarantined
		req.Quarantined = &quarantined

		_, err := client.AddServer(ctx, req)
		if err != nil {
			// Log error but continue with other servers
			fmt.Fprintf(os.Stderr, "  ❌ Failed to add '%s': %v\n", s.Server.Name, err)
		}
	}

	return nil
}

// runUpstreamInspect handles the 'upstream inspect' command (Spec 032)
func runUpstreamInspect(_ *cobra.Command, args []string) error {
	serverName := args[0]

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeConfigNotFound, err.Error()).
			WithGuidance("Check that your config file exists and is valid").
			WithRecoveryCommand("mcpproxy doctor"), output.ErrCodeConfigNotFound)
	}

	logger, err := createUpstreamLogger("warn")
	if err != nil {
		return outputError(err, output.ErrCodeOperationFailed)
	}

	client, ok := newDaemonClient(globalConfig, logger.Sugar())
	if !ok {
		return fmt.Errorf("mcpproxy daemon is not running. Start it with: mcpproxy serve")
	}

	// If a specific tool is requested, show the diff
	if upstreamInspectTool != "" {
		record, err := client.GetToolDiff(ctx, serverName, upstreamInspectTool)
		if err != nil {
			return cliError("failed to get tool diff", err)
		}

		outputFormat := ResolveOutputFormat()
		if outputFormat == "json" || outputFormat == "yaml" {
			formatter, fmtErr := GetOutputFormatter()
			if fmtErr != nil {
				return fmtErr
			}
			result, fmtErr := formatter.Format(record)
			if fmtErr != nil {
				return fmtErr
			}
			fmt.Println(result)
			return nil
		}

		// Table format: show detailed diff
		fmt.Printf("Tool Diff: %s:%s\n", serverName, record.ToolName)
		fmt.Printf("Status: %s\n\n", record.Status)
		fmt.Printf("--- Previous Description ---\n%s\n\n", record.PreviousDescription)
		fmt.Printf("+++ Current Description ---\n%s\n\n", record.CurrentDescription)
		if record.PreviousSchema != "" || record.CurrentSchema != "" {
			fmt.Printf("--- Previous Schema ---\n%s\n\n", record.PreviousSchema)
			fmt.Printf("+++ Current Schema ---\n%s\n", record.CurrentSchema)
		}
		return nil
	}

	// List all tool approvals for this server
	records, err := client.GetToolApprovals(ctx, serverName)
	if err != nil {
		return cliError("failed to get tool approvals", err)
	}

	if len(records) == 0 {
		fmt.Printf("No tool approval records found for server '%s'\n", serverName)
		return nil
	}

	outputFormat := ResolveOutputFormat()
	if outputFormat == "json" || outputFormat == "yaml" {
		formatter, fmtErr := GetOutputFormatter()
		if fmtErr != nil {
			return fmtErr
		}
		result, fmtErr := formatter.Format(records)
		if fmtErr != nil {
			return fmtErr
		}
		fmt.Println(result)
		return nil
	}

	// Table format
	headers := []string{"TOOL", "STATUS", "HASH", "DESCRIPTION"}
	var rows [][]string
	pendingCount, changedCount, approvedCount := 0, 0, 0
	for _, r := range records {
		status := r.Status
		switch status {
		case "pending":
			pendingCount++
		case "changed":
			changedCount++
		case "approved":
			approvedCount++
		}

		desc := r.Description
		if len(desc) > 60 {
			desc = desc[:57] + "..."
		}

		hash := r.Hash
		if len(hash) > 12 {
			hash = hash[:12]
		}

		rows = append(rows, []string{r.ToolName, status, hash, desc})
	}

	formatter, fmtErr := GetOutputFormatter()
	if fmtErr != nil {
		return fmtErr
	}
	result, fmtErr := formatter.FormatTable(headers, rows)
	if fmtErr != nil {
		return fmtErr
	}
	fmt.Print(result)
	fmt.Printf("\nSummary: %d approved, %d pending, %d changed (total: %d)\n", approvedCount, pendingCount, changedCount, len(records))

	if pendingCount > 0 || changedCount > 0 {
		fmt.Printf("\nTo approve all tools: mcpproxy upstream approve %s\n", serverName)
		if changedCount > 0 {
			fmt.Printf("To inspect changes:   mcpproxy upstream inspect %s --tool <name>\n", serverName)
		}
	}

	return nil
}

// runUpstreamApprove handles the 'upstream approve' command (Spec 032)
func runUpstreamApprove(_ *cobra.Command, args []string) error {
	serverName := args[0]
	toolNames := args[1:]

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeConfigNotFound, err.Error()).
			WithGuidance("Check that your config file exists and is valid").
			WithRecoveryCommand("mcpproxy doctor"), output.ErrCodeConfigNotFound)
	}

	logger, err := createUpstreamLogger("warn")
	if err != nil {
		return outputError(err, output.ErrCodeOperationFailed)
	}

	client, ok := newDaemonClient(globalConfig, logger.Sugar())
	if !ok {
		return fmt.Errorf("mcpproxy daemon is not running. Start it with: mcpproxy serve")
	}

	approveAll := len(toolNames) == 0
	count, err := client.ApproveTools(ctx, serverName, toolNames, approveAll)
	if err != nil {
		return cliError("failed to approve tools", err)
	}

	outputFormat := ResolveOutputFormat()
	if outputFormat == "json" || outputFormat == "yaml" {
		formatter, fmtErr := GetOutputFormatter()
		if fmtErr != nil {
			return fmtErr
		}
		result, fmtErr := formatter.Format(map[string]interface{}{
			"server_name": serverName,
			"approved":    count,
			"tools":       toolNames,
		})
		if fmtErr != nil {
			return fmtErr
		}
		fmt.Println(result)
		return nil
	}

	if approveAll {
		fmt.Printf("Approved %d tools for server '%s'\n", count, serverName)
	} else {
		fmt.Printf("Approved %d tool(s) for server '%s': %s\n", count, serverName, strings.Join(toolNames, ", "))
	}

	return nil
}

// applyImportedServersConfigMode adds servers directly to the config file
func applyImportedServersConfigMode(imported []*configimport.ImportedServer, globalConfig *config.Config) error {
	// Add all imported servers to config
	for _, s := range imported {
		globalConfig.Servers = append(globalConfig.Servers, s.Server)
	}

	// Save config
	configPath := config.GetConfigPath(globalConfig.DataDir)
	if err := config.SaveConfig(globalConfig, configPath); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}

	return nil
}
