package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cli/output"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/reqcontext"
)

// runUpstreamAdd handles the 'upstream add' command
func runUpstreamAdd(cmd *cobra.Command, args []string) error {
	// Parse command-line arguments
	// Usage: add <name> [url] [-- command args...]
	if len(args) < 1 {
		return fmt.Errorf("server name is required")
	}

	serverName := args[0]

	// Validate server name (alphanumeric, hyphens, underscores, 1-64 chars)
	if err := validateServerName(serverName); err != nil {
		return err
	}

	// Check for -- separator to detect stdio mode
	var url string
	var stdioCmd []string
	dashDashIndex := cmd.ArgsLenAtDash()

	if dashDashIndex >= 0 {
		// Stdio mode: args before -- are name (and optionally url), args after are command
		preArgs := args[:dashDashIndex]
		stdioCmd = args[dashDashIndex:]

		if len(preArgs) > 1 {
			url = preArgs[1] // URL provided before --
		}
		if len(stdioCmd) == 0 {
			return fmt.Errorf("command required after '--'")
		}
	} else {
		// HTTP mode or auto-detect
		if len(args) > 1 {
			url = args[1]
		}
	}

	// Determine transport type
	transport := upstreamAddTransport
	if transport == "" {
		if len(stdioCmd) > 0 {
			transport = "stdio"
		} else if url != "" {
			transport = "streamable-http"
		}
	}

	// Validate based on transport
	if transport == "stdio" && len(stdioCmd) == 0 {
		return fmt.Errorf("command required for stdio transport (use -- to separate)")
	}
	if (transport == "http" || transport == "streamable-http") && url == "" {
		return fmt.Errorf("URL required for http transport")
	}

	// Parse headers (for HTTP)
	headers := make(map[string]string)
	for _, h := range upstreamAddHeaders {
		parts := strings.SplitN(h, ":", 2)
		if len(parts) != 2 {
			return fmt.Errorf("invalid header format: %s (expected 'Name: value')", h)
		}
		headers[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
	}

	// Parse environment variables (for stdio)
	env := make(map[string]string)
	for _, e := range upstreamAddEnvs {
		parts := strings.SplitN(e, "=", 2)
		if len(parts) != 2 {
			return fmt.Errorf("invalid env format: %s (expected 'KEY=value')", e)
		}
		env[parts[0]] = parts[1]
	}

	// GH #938: refuse a typo'd tier before anything is written, with the same
	// vocabulary the REST layer reports in its 400.
	if err := validateTrustModeFlag(upstreamAddTrustMode); err != nil {
		return err
	}

	// Build the request
	req := &cliclient.AddServerRequest{
		Name:       serverName,
		URL:        url,
		Headers:    headers,
		Env:        env,
		WorkingDir: upstreamAddWorkingDir,
		Protocol:   transport,
		TrustMode:  upstreamAddTrustMode,
	}

	// Set quarantine based on --no-quarantine flag
	if upstreamAddNoQuarantine {
		quarantined := false
		req.Quarantined = &quarantined
	}

	// For stdio, extract command and args
	if len(stdioCmd) > 0 {
		req.Command = stdioCmd[0]
		if len(stdioCmd) > 1 {
			req.Args = stdioCmd[1:]
		}
	}

	// Create context
	ctx := reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Load configuration to get data dir
	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeConfigNotFound, err.Error()).
			WithGuidance("Check that your config file exists and is valid").
			WithRecoveryCommand("mcpproxy doctor"), output.ErrCodeConfigNotFound)
	}

	// Check if daemon is running
	if client, ok := newDaemonClient(globalConfig, nil); ok {
		return runUpstreamAddDaemonMode(ctx, client, req)
	}

	// Direct config file mode
	return runUpstreamAddConfigMode(req, globalConfig)
}

func runUpstreamAddDaemonMode(ctx context.Context, client *cliclient.Client, req *cliclient.AddServerRequest) error {
	result, err := client.AddServer(ctx, req)
	if err != nil {
		// Check if it's "already exists" error and --if-not-exists is set
		if upstreamAddIfNotExists && strings.Contains(err.Error(), "already exists") {
			return outputSkipNotice(
				fmt.Sprintf("Server '%s' already exists (skipped)", req.Name),
				map[string]interface{}{"name": req.Name, "skipped": true},
			)
		}
		return outputError(output.NewStructuredError(output.ErrCodeOperationFailed, err.Error()).
			WithGuidance("Check the server name and configuration"), output.ErrCodeOperationFailed)
	}

	// Output success
	outputFormat := ResolveOutputFormat()
	if outputFormat == "json" || outputFormat == "yaml" {
		formatter, _ := GetOutputFormatter()
		output, _ := formatter.Format(result)
		fmt.Println(output)
	} else {
		fmt.Printf("✅ Added server '%s'\n", req.Name)
		if result != nil && result.Quarantined {
			fmt.Println("   ⚠️  New servers are quarantined by default. Approve in the web UI.")
		}
	}

	return nil
}

func runUpstreamAddConfigMode(req *cliclient.AddServerRequest, globalConfig *config.Config) error {
	// Check if server already exists
	for _, srv := range globalConfig.Servers {
		if srv.Name == req.Name {
			if upstreamAddIfNotExists {
				return outputSkipNotice(
					fmt.Sprintf("Server '%s' already exists (skipped)", req.Name),
					map[string]interface{}{"name": req.Name, "skipped": true},
				)
			}
			return fmt.Errorf("server '%s' already exists", req.Name)
		}
	}

	// Determine quarantine status. This MUST match the daemon path
	// (internal/httpapi POST /api/v1/servers), which derives the add-time
	// default from the trust tier via Config.QuarantineDefaultForServer — auto is
	// admitted unquarantined, scan|manual are quarantined on add (spec 086
	// FR-011). Hardcoding true here meant `upstream add --trust-mode auto`
	// produced a DIFFERENT server depending on whether the daemon happened to be
	// running. The explicit --no-quarantine/--quarantine flag still wins after.
	quarantined := globalConfig.QuarantineDefaultForServer(&config.ServerConfig{
		TrustMode: req.TrustMode,
	})
	if req.Quarantined != nil {
		quarantined = *req.Quarantined
	}

	// Create new server config
	newServer := &config.ServerConfig{
		Name:        req.Name,
		URL:         req.URL,
		Command:     req.Command,
		Args:        req.Args,
		Env:         req.Env,
		Headers:     req.Headers,
		WorkingDir:  req.WorkingDir,
		Protocol:    req.Protocol,
		Enabled:     true,
		Quarantined: quarantined,
		TrustMode:   req.TrustMode,
	}

	// Add to config
	globalConfig.Servers = append(globalConfig.Servers, newServer)

	// Save config
	configPath := config.GetConfigPath(globalConfig.DataDir)
	if err := config.SaveConfig(globalConfig, configPath); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}

	// Output success
	fmt.Printf("✅ Added server '%s' to config\n", req.Name)
	if quarantined {
		fmt.Println("   ⚠️  New servers are quarantined by default. Start the daemon and approve in the web UI.")
	}

	return nil
}

// runUpstreamRemove handles the 'upstream remove' command
func runUpstreamRemove(cmd *cobra.Command, args []string) error {
	serverName := args[0]

	// Create context
	ctx := reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Load configuration
	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeConfigNotFound, err.Error()).
			WithGuidance("Check that your config file exists and is valid").
			WithRecoveryCommand("mcpproxy doctor"), output.ErrCodeConfigNotFound)
	}

	// Prompt for confirmation if not --yes
	if !upstreamRemoveYes {
		confirmed, err := promptConfirmation(fmt.Sprintf("Remove server '%s'?", serverName))
		if err != nil {
			return err
		}
		if !confirmed {
			fmt.Println("Operation cancelled")
			return nil
		}
	}

	// Check if daemon is running
	if client, ok := newDaemonClient(globalConfig, nil); ok {
		return runUpstreamRemoveDaemonMode(ctx, client, serverName)
	}

	// Direct config file mode
	return runUpstreamRemoveConfigMode(serverName, globalConfig)
}

func runUpstreamRemoveDaemonMode(ctx context.Context, client *cliclient.Client, serverName string) error {
	err := client.RemoveServer(ctx, serverName)
	if err != nil {
		// Check if it's "not found" error and --if-exists is set
		if upstreamRemoveIfExists && strings.Contains(err.Error(), "not found") {
			return outputSkipNotice(
				fmt.Sprintf("Server '%s' not found (skipped)", serverName),
				map[string]interface{}{"name": serverName, "skipped": true},
			)
		}
		return outputError(output.NewStructuredError(output.ErrCodeOperationFailed, err.Error()).
			WithGuidance("Check the server name"), output.ErrCodeOperationFailed)
	}

	// Output success
	outputFormat := ResolveOutputFormat()
	if outputFormat == "json" || outputFormat == "yaml" {
		formatter, _ := GetOutputFormatter()
		output, _ := formatter.Format(map[string]interface{}{
			"name":    serverName,
			"removed": true,
		})
		fmt.Println(output)
	} else {
		fmt.Printf("✅ Removed server '%s'\n", serverName)
	}

	return nil
}

func runUpstreamRemoveConfigMode(serverName string, globalConfig *config.Config) error {
	// Find and remove server
	found := false
	newServers := make([]*config.ServerConfig, 0, len(globalConfig.Servers))
	for _, srv := range globalConfig.Servers {
		if srv.Name == serverName {
			found = true
			continue
		}
		newServers = append(newServers, srv)
	}

	if !found {
		if upstreamRemoveIfExists {
			return outputSkipNotice(
				fmt.Sprintf("Server '%s' not found (skipped)", serverName),
				map[string]interface{}{"name": serverName, "skipped": true},
			)
		}
		return fmt.Errorf("server '%s' not found", serverName)
	}

	// Update config
	globalConfig.Servers = newServers

	// Save config
	configPath := config.GetConfigPath(globalConfig.DataDir)
	if err := config.SaveConfig(globalConfig, configPath); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}

	fmt.Printf("✅ Removed server '%s' from config\n", serverName)
	return nil
}

// parseAddJSONRequest decodes the `upstream add-json` payload into an add
// request.
//
// trust_mode is decoded and validated here (GH #938): the previous anonymous
// struct had no such field, so `upstream add-json srv '{"url":…,
// "trust_mode":"scan"}'` reported success and persisted the fail-closed default
// — the operator believed the tier had been applied. A bogus value is refused
// with the same vocabulary every other write seam uses instead of being
// silently downgraded.
func parseAddJSONRequest(serverName, jsonStr string) (*cliclient.AddServerRequest, error) {
	var jsonConfig struct {
		URL        string            `json:"url"`
		Command    string            `json:"command"`
		Args       []string          `json:"args"`
		Env        map[string]string `json:"env"`
		Headers    map[string]string `json:"headers"`
		WorkingDir string            `json:"working_dir"`
		Protocol   string            `json:"protocol"`
		TrustMode  string            `json:"trust_mode"`
	}

	if err := json.Unmarshal([]byte(jsonStr), &jsonConfig); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}

	// Auto-detect protocol
	protocol := jsonConfig.Protocol
	if protocol == "" {
		if jsonConfig.Command != "" {
			protocol = "stdio"
		} else if jsonConfig.URL != "" {
			protocol = "streamable-http"
		}
	}

	// Validate
	if jsonConfig.URL == "" && jsonConfig.Command == "" {
		return nil, fmt.Errorf("JSON must contain either 'url' or 'command'")
	}
	if err := validateTrustModeFlag(jsonConfig.TrustMode); err != nil {
		return nil, err
	}

	return &cliclient.AddServerRequest{
		Name:       serverName,
		URL:        jsonConfig.URL,
		Command:    jsonConfig.Command,
		Args:       jsonConfig.Args,
		Headers:    jsonConfig.Headers,
		Env:        jsonConfig.Env,
		WorkingDir: jsonConfig.WorkingDir,
		Protocol:   protocol,
		TrustMode:  jsonConfig.TrustMode,
	}, nil
}

// runUpstreamAddJSON handles the 'upstream add-json' command
func runUpstreamAddJSON(cmd *cobra.Command, args []string) error {
	serverName := args[0]
	jsonStr := args[1]

	// Validate server name
	if err := validateServerName(serverName); err != nil {
		return err
	}

	req, err := parseAddJSONRequest(serverName, jsonStr)
	if err != nil {
		return err
	}

	// Create context
	ctx := reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI)
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	// Load configuration
	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		return outputError(output.NewStructuredError(output.ErrCodeConfigNotFound, err.Error()).
			WithGuidance("Check that your config file exists and is valid").
			WithRecoveryCommand("mcpproxy doctor"), output.ErrCodeConfigNotFound)
	}

	// Check if daemon is running
	if client, ok := newDaemonClient(globalConfig, nil); ok {
		return runUpstreamAddDaemonMode(ctx, client, req)
	}

	// Direct config file mode
	return runUpstreamAddConfigMode(req, globalConfig)
}

// validateServerName validates server name format (alphanumeric, hyphens, underscores, 1-64 chars)
func validateServerName(name string) error {
	if len(name) == 0 {
		return fmt.Errorf("server name cannot be empty")
	}
	if len(name) > 64 {
		return fmt.Errorf("server name too long (max 64 characters)")
	}

	for i, c := range name {
		isAlphaNum := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
		isAllowed := c == '-' || c == '_'
		if !isAlphaNum && !isAllowed {
			return fmt.Errorf("invalid character '%c' at position %d in server name (allowed: a-z, A-Z, 0-9, -, _)", c, i)
		}
	}

	return nil
}

// promptConfirmation prompts the user for yes/no confirmation
func promptConfirmation(message string) (bool, error) {
	fmt.Printf("%s [y/N]: ", message)
	var response string
	_, err := fmt.Scanln(&response)
	if err != nil {
		// If EOF or empty, treat as "no"
		return false, nil
	}

	response = strings.ToLower(strings.TrimSpace(response))
	return response == "y" || response == "yes", nil
}

// runUpstreamPatch handles the 'upstream patch' command. Translates the
// repeatable --header / --env / --header-remove / --env-remove flags into
// a JSON Merge Patch (RFC 7396) body and POSTs it to PATCH /api/v1/servers/{name}.
//
// Upserts encode as {"headers": {"X-Foo": "bar"}}; deletes encode as
// {"headers": {"X-Stale": null}}. Both shapes go through encoding/json
// (`map[string]*string`) where a nil pointer renders as the literal
// `null` token — verified by the backend's PATCH tests.
func runUpstreamPatch(_ *cobra.Command, args []string) error {
	serverName := strings.TrimSpace(args[0])
	if serverName == "" {
		return fmt.Errorf("server name is required")
	}

	initTimeout := strings.TrimSpace(upstreamPatchInitTimeout)
	if len(upstreamPatchHeaders) == 0 && len(upstreamPatchHeaderRemove) == 0 &&
		len(upstreamPatchEnvs) == 0 && len(upstreamPatchEnvRemove) == 0 && initTimeout == "" {
		return fmt.Errorf("at least one of --header / --header-remove / --env / --env-remove / --init-timeout must be specified")
	}

	// Validate --init-timeout locally so we fail fast with a clear message
	// before hitting the daemon (the backend re-validates the bounds).
	if initTimeout != "" {
		if _, perr := time.ParseDuration(initTimeout); perr != nil {
			return fmt.Errorf("invalid --init-timeout %q: %v (expected a duration like '120s' or '3m')", initTimeout, perr)
		}
	}

	headers := map[string]*string{}
	for _, h := range upstreamPatchHeaders {
		parts := strings.SplitN(h, ":", 2)
		if len(parts) != 2 {
			return fmt.Errorf("invalid --header format: %q (expected 'Name: value')", h)
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		if key == "" {
			return fmt.Errorf("invalid --header: empty header name in %q", h)
		}
		headers[key] = &val
	}
	for _, k := range upstreamPatchHeaderRemove {
		key := strings.TrimSpace(k)
		if key == "" {
			return fmt.Errorf("invalid --header-remove: empty name")
		}
		if _, dupe := headers[key]; dupe {
			return fmt.Errorf("--header and --header-remove for %q conflict; pick one", key)
		}
		headers[key] = nil // JSON Merge Patch: null = delete
	}

	envs := map[string]*string{}
	for _, e := range upstreamPatchEnvs {
		parts := strings.SplitN(e, "=", 2)
		if len(parts) != 2 {
			return fmt.Errorf("invalid --env format: %q (expected 'KEY=value')", e)
		}
		key := strings.TrimSpace(parts[0])
		val := parts[1]
		if key == "" {
			return fmt.Errorf("invalid --env: empty key in %q", e)
		}
		envs[key] = &val
	}
	for _, k := range upstreamPatchEnvRemove {
		key := strings.TrimSpace(k)
		if key == "" {
			return fmt.Errorf("invalid --env-remove: empty name")
		}
		if _, dupe := envs[key]; dupe {
			return fmt.Errorf("--env and --env-remove for %q conflict; pick one", key)
		}
		envs[key] = nil
	}

	body := map[string]interface{}{}
	if len(headers) > 0 {
		body["headers"] = headers
	}
	if len(envs) > 0 {
		body["env"] = envs
	}
	if initTimeout != "" {
		body["init_timeout"] = initTimeout
	}

	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("failed to marshal patch body: %w", err)
	}

	ctx, cancel := context.WithTimeout(reqcontext.WithMetadata(context.Background(), reqcontext.SourceCLI), 15*time.Second)
	defer cancel()

	globalConfig, err := loadUpstreamConfig()
	if err != nil {
		return fmt.Errorf("failed to load config: %w", err)
	}
	logger, err := createUpstreamLogger("warn")
	if err != nil {
		return fmt.Errorf("failed to create logger: %w", err)
	}
	client, ok := newDaemonClient(globalConfig, logger.Sugar())
	if !ok {
		return fmt.Errorf("mcpproxy daemon is not running — start it with `mcpproxy serve` first; the `patch` subcommand requires a live backend so configuration changes are applied with full deep-merge semantics and propagated to running upstream connections immediately. Editing the config file by hand only works while the daemon is offline")
	}

	if err := client.PatchServer(ctx, serverName, bodyBytes); err != nil {
		return err
	}

	fmt.Printf("✅ Patched %s", serverName)
	parts := []string{}
	if n := len(upstreamPatchHeaders); n > 0 {
		parts = append(parts, fmt.Sprintf("%d header(s) set", n))
	}
	if n := len(upstreamPatchHeaderRemove); n > 0 {
		parts = append(parts, fmt.Sprintf("%d header(s) removed", n))
	}
	if n := len(upstreamPatchEnvs); n > 0 {
		parts = append(parts, fmt.Sprintf("%d env var(s) set", n))
	}
	if n := len(upstreamPatchEnvRemove); n > 0 {
		parts = append(parts, fmt.Sprintf("%d env var(s) removed", n))
	}
	if initTimeout != "" {
		parts = append(parts, fmt.Sprintf("init_timeout=%s", initTimeout))
	}
	if len(parts) > 0 {
		fmt.Printf(": %s", strings.Join(parts, ", "))
	}
	fmt.Println()
	return nil
}
