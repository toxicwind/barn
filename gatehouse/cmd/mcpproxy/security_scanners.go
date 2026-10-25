package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
)

func runSecurityScanners(_ *cobra.Command, _ []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/security/scanners", nil)
	if err != nil {
		return fmt.Errorf("failed to list scanners: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "list scanners")
	}

	var scanners []map[string]interface{}
	respBody, err = unwrapAPIResponse(respBody)
	if err != nil {
		return fmt.Errorf("API error: %w", err)
	}
	if err := json.Unmarshal(respBody, &scanners); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrint(format, scanners)
	}

	if len(scanners) == 0 {
		fmt.Println("No security scanners available.")
		return nil
	}

	// Table format
	fmt.Printf("%-20s %-22s %-22s %-12s %-s\n",
		"ID", "NAME", "VENDOR", "STATUS", "INPUTS")
	fmt.Println(strings.Repeat("-", 95))

	for _, sc := range scanners {
		id := getMapString(sc, "id")
		name := getMapString(sc, "name")
		vendor := getMapString(sc, "vendor")
		rawStatus := getMapString(sc, "status")
		status := scannerDisplayStatus(rawStatus)
		colorOpen, colorReset := scannerStatusColor(rawStatus)
		inputs := secJoinSlice(sc, "inputs")

		// Pad status BEFORE applying color so column alignment isn't broken
		// by invisible escape sequences.
		paddedStatus := fmt.Sprintf("%-12s", status)
		if colorOpen != "" {
			paddedStatus = colorOpen + paddedStatus + colorReset
		}

		fmt.Printf("%-20s %-22s %-22s %s %-s\n",
			secTruncate(id, 20),
			secTruncate(name, 22),
			secTruncate(vendor, 22),
			paddedStatus,
			inputs)
	}

	return nil
}

func runSecurityInstall(_ *cobra.Command, args []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	scannerID := args[0]

	fmt.Printf("Enabling scanner %q...\n", scannerID)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodPost, "/api/v1/security/scanners/"+scannerID+"/enable", nil)
	if err != nil {
		return fmt.Errorf("failed to enable scanner: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "install scanner")
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrintRaw(format, respBody)
	}

	fmt.Printf("Scanner %q enabled successfully.\n", scannerID)
	// Audit FIX 3b: if the core reports that the scanner belongs to the opt-in
	// deep-scan layer and that layer is off, tell the user — otherwise the
	// scanner is enabled but silently never runs.
	if hint := scannerEnableHint(respBody); hint != "" {
		fmt.Printf("Note: %s\n", hint)
	}
	return nil
}

// scannerEnableHint extracts the optional "hint" field from a successful
// POST /security/scanners/{id}/enable response ({"success":true,"data":
// {"status":"enabled","id":...,"hint":...}}). Returns "" when the response
// carries no hint (older cores, deep scan already enabled, in-process scanner).
func scannerEnableHint(respBody []byte) string {
	var wrapper struct {
		Data struct {
			Hint string `json:"hint"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &wrapper); err != nil {
		return ""
	}
	return wrapper.Data.Hint
}

func runSecurityRemove(_ *cobra.Command, args []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	scannerID := args[0]
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodPost, "/api/v1/security/scanners/"+scannerID+"/disable", nil)
	if err != nil {
		return fmt.Errorf("failed to disable scanner: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("scanner %q not found", scannerID)
	}
	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "remove scanner")
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrintRaw(format, respBody)
	}

	fmt.Printf("Scanner %q disabled successfully.\n", scannerID)
	return nil
}

func runSecurityConfigure(_ *cobra.Command, args []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	scannerID := args[0]

	// Parse --env KEY=VALUE flags
	envMap := make(map[string]string)
	for _, e := range secConfigEnv {
		parts := strings.SplitN(e, "=", 2)
		if len(parts) != 2 || parts[0] == "" {
			return fmt.Errorf("invalid env format %q, expected KEY=VALUE", e)
		}
		envMap[parts[0]] = parts[1]
	}

	body, err := json.Marshal(map[string]interface{}{"env": envMap})
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	// F-15: bumped from 10s -> 60s. Configure can be slow when the scanner
	// engine validates credentials against an upstream provider.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// F-15: client-side prefetch — confirm the scanner exists before issuing
	// the (potentially slow) PUT, so a typo'd id fails fast with a 404 instead
	// of hanging the user for 60s.
	if err := securityVerifyScannerExists(ctx, client, scannerID); err != nil {
		return err
	}

	resp, err := client.DoRaw(ctx, http.MethodPut, "/api/v1/security/scanners/"+scannerID+"/config", body)
	if err != nil {
		return fmt.Errorf("failed to configure scanner: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("scanner %q not found", scannerID)
	}
	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "configure scanner")
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrintRaw(format, respBody)
	}

	fmt.Printf("Scanner %q configured with %d environment variable(s).\n", scannerID, len(envMap))
	return nil
}

// securityVerifyScannerExists pings the scanner status endpoint and returns
// a friendly "not found" error before the caller commits to a slower request.
func securityVerifyScannerExists(ctx context.Context, client *cliclient.Client, scannerID string) error {
	statusCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := client.DoRaw(statusCtx, http.MethodGet, "/api/v1/security/scanners/"+scannerID, nil)
	if err != nil {
		// Network error: don't block — let the real call surface the issue.
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("scanner %q not found", scannerID)
	}
	return nil
}
