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
)

func runSecurityApprove(_ *cobra.Command, args []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	serverName := args[0]
	body, err := json.Marshal(map[string]interface{}{"force": secApproveForce})
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodPost, "/api/v1/servers/"+serverName+"/security/approve", body)
	if err != nil {
		return fmt.Errorf("failed to approve server: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "approve server")
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrintRaw(format, respBody)
	}

	if secApproveForce {
		fmt.Printf("Server %q force-approved.\n", serverName)
	} else {
		fmt.Printf("Server %q approved.\n", serverName)
	}
	return nil
}

func runSecurityReject(_ *cobra.Command, args []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	serverName := args[0]
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodPost, "/api/v1/servers/"+serverName+"/security/reject", nil)
	if err != nil {
		return fmt.Errorf("failed to reject server: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "reject server")
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrintRaw(format, respBody)
	}

	fmt.Printf("Server %q rejected and quarantined.\n", serverName)
	return nil
}

func runSecurityOverview(_ *cobra.Command, _ []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/security/overview", nil)
	if err != nil {
		return fmt.Errorf("failed to get security overview: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "get security overview")
	}

	var overview map[string]interface{}
	respBody, err = unwrapAPIResponse(respBody)
	if err != nil {
		return fmt.Errorf("API error: %w", err)
	}
	if err := json.Unmarshal(respBody, &overview); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	// F-14: scrub Go zero-time from last_scan_at so neither the table nor the
	// JSON/YAML serializers show "0001-01-01 00:00:00". We keep the field in
	// the schema (as nil) so consumers don't break, but represent "never".
	normalizeOverviewLastScan(overview)

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrint(format, overview)
	}

	// Human-readable overview
	fmt.Println("Security Overview")
	fmt.Printf("  Scanners installed: %s\n", secFormatInt(overview, "scanners_installed"))
	fmt.Printf("  Servers scanned:    %s\n", secFormatInt(overview, "servers_scanned"))
	fmt.Printf("  Total scans:        %s\n", secFormatInt(overview, "total_scans"))
	fmt.Printf("  Active scans:       %s\n", secFormatInt(overview, "active_scans"))
	if v, present := overview["last_scan_at"]; present && v != nil {
		if lastScan, ok := v.(string); ok && lastScan != "" {
			fmt.Printf("  Last scan:          %s\n", formatTimestamp(lastScan))
		} else {
			fmt.Printf("  Last scan:          %s\n", "never")
		}
	} else {
		fmt.Printf("  Last scan:          %s\n", "never")
	}
	fmt.Println()

	// Signature bundle (spec 086 FR-019 / GH #938): which TPA corpus is live,
	// where it came from, and how fresh it is.
	for _, line := range signatureBundleLines(overview) {
		fmt.Println(line)
	}

	// Findings breakdown
	if findings, ok := overview["findings_by_severity"].(map[string]interface{}); ok {
		fmt.Println("  Findings:")
		fmt.Printf("    Critical: %s\n", secFormatInt(findings, "critical"))
		fmt.Printf("    High:     %s\n", secFormatInt(findings, "high"))
		fmt.Printf("    Medium:   %s\n", secFormatInt(findings, "medium"))
		fmt.Printf("    Low:      %s\n", secFormatInt(findings, "low"))
		fmt.Printf("    Info:     %s\n", secFormatInt(findings, "info"))
	}

	return nil
}

func runSecurityIntegrity(_ *cobra.Command, args []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	serverName := args[0]
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/servers/"+serverName+"/integrity", nil)
	if err != nil {
		return fmt.Errorf("failed to check integrity: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("no integrity baseline found for server %q", serverName)
	}
	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "check integrity")
	}

	var result map[string]interface{}
	respBody, err = unwrapAPIResponse(respBody)
	if err != nil {
		return fmt.Errorf("API error: %w", err)
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrint(format, result)
	}

	// Table output
	passed := false
	if p, ok := result["passed"].(bool); ok {
		passed = p
	}

	fmt.Printf("Integrity Check: %s\n", serverName)
	if passed {
		fmt.Println("  Status: PASSED")
	} else {
		fmt.Println("  Status: FAILED")
	}
	if checkedAt := getMapString(result, "checked_at"); checkedAt != "" {
		fmt.Printf("  Checked: %s\n", formatTimestamp(checkedAt))
	}

	// Show violations if any
	if violations, ok := result["violations"].([]interface{}); ok && len(violations) > 0 {
		fmt.Println()
		fmt.Println("  Violations:")
		for _, v := range violations {
			if viol, ok := v.(map[string]interface{}); ok {
				violType := getMapString(viol, "type")
				message := getMapString(viol, "message")
				fmt.Printf("    [%s] %s\n", strings.ToUpper(violType), message)
				if expected := getMapString(viol, "expected"); expected != "" {
					fmt.Printf("      Expected: %s\n", expected)
				}
				if actual := getMapString(viol, "actual"); actual != "" {
					fmt.Printf("      Actual:   %s\n", actual)
				}
			}
		}
	}

	return nil
}
