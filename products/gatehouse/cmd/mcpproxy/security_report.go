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

func runSecurityCancelAll(_ *cobra.Command, _ []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodPost, "/api/v1/security/cancel-all", nil)
	if err != nil {
		return fmt.Errorf("failed to cancel batch scan: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "cancel batch scan")
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrintRaw(format, respBody)
	}

	fmt.Println("Batch scan cancelled.")
	return nil
}

// printScannerStatusTable renders the per-scanner execution table including a
// DURATION column. Nothing is printed when there are no scanner statuses.
func printScannerStatusTable(scannerStatuses []interface{}) {
	if len(scannerStatuses) == 0 {
		return
	}
	fmt.Println()
	fmt.Printf("  %-20s %-12s %-10s %-8s %s\n", "SCANNER", "STATUS", "DURATION", "FINDINGS", "ERROR")
	fmt.Printf("  %s\n", strings.Repeat("-", 75))
	for _, s := range scannerStatuses {
		ss, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		scannerID := getMapString(ss, "scanner_id")
		ssStatus := getMapString(ss, "status")
		findings := "0"
		if fc, ok := ss["findings_count"].(float64); ok {
			findings = fmt.Sprintf("%d", int(fc))
		}
		ssErr := getMapString(ss, "error")
		if len(ssErr) > 25 {
			ssErr = ssErr[:22] + "..."
		}
		dur := formatScannerDurationMs(scannerDurationMs(ss))
		fmt.Printf("  %-20s %-12s %-10s %-8s %s\n", scannerID, ssStatus, dur, findings, ssErr)
	}
}

// printScannerTimings renders a compact per-scanner wall-clock timing block
// from a scan report's scanner_statuses. Nothing is printed when timing data
// is absent.
func printScannerTimings(report map[string]interface{}) {
	statuses, ok := report["scanner_statuses"].([]interface{})
	if !ok || len(statuses) == 0 {
		return
	}
	type timingRow struct{ id, status, dur string }
	rows := make([]timingRow, 0, len(statuses))
	for _, s := range statuses {
		ss, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		id := getMapString(ss, "scanner_id")
		if id == "" {
			continue
		}
		rows = append(rows, timingRow{
			id:     id,
			status: getMapString(ss, "status"),
			dur:    formatScannerDurationMs(scannerDurationMs(ss)),
		})
	}
	if len(rows) == 0 {
		return
	}
	fmt.Println()
	fmt.Println("Scanner timing:")
	for _, r := range rows {
		fmt.Printf("  %-20s %-12s %s\n", r.id, r.status, r.dur)
	}
}

func runSecurityStatus(_ *cobra.Command, args []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	serverName := args[0]
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/servers/"+serverName+"/scan/status", nil)
	if err != nil {
		return fmt.Errorf("failed to get scan status: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("no scan found for server %q", serverName)
	}
	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "get scan status")
	}

	var status map[string]interface{}
	respBody, err = unwrapAPIResponse(respBody)
	if err != nil {
		return fmt.Errorf("API error: %w", err)
	}
	if err := json.Unmarshal(respBody, &status); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	format := ResolveOutputFormat()
	if format == "json" || format == "yaml" {
		return formatAndPrint(format, status)
	}

	// Table output
	fmt.Printf("Scan Status: %s\n", serverName)
	fmt.Printf("  Job ID:   %s\n", getMapString(status, "id"))
	fmt.Printf("  Status:   %s\n", getMapString(status, "status"))
	if startedAt := getMapString(status, "started_at"); startedAt != "" {
		fmt.Printf("  Started:  %s\n", formatTimestamp(startedAt))
	}
	if completedAt := getMapString(status, "completed_at"); completedAt != "" {
		fmt.Printf("  Finished: %s\n", formatTimestamp(completedAt))
	}
	if errMsg := getMapString(status, "error"); errMsg != "" {
		fmt.Printf("  Error:    %s\n", errMsg)
	}

	// Per-scanner statuses (includes a DURATION column)
	if scannerStatuses, ok := status["scanner_statuses"].([]interface{}); ok {
		printScannerStatusTable(scannerStatuses)
	}

	return nil
}

func runSecurityReport(_ *cobra.Command, args []string) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	serverName := args[0]
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/servers/"+serverName+"/scan/report", nil)
	if err != nil {
		return fmt.Errorf("failed to get scan report: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("no scan report found for server %q", serverName)
	}
	if resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "get scan report")
	}

	format := ResolveOutputFormat()

	// Special case: SARIF output
	if format == "sarif" {
		var report map[string]interface{}
		respBody, err = unwrapAPIResponse(respBody)
		if err != nil {
			return fmt.Errorf("API error: %w", err)
		}
		if err := json.Unmarshal(respBody, &report); err != nil {
			return fmt.Errorf("failed to parse report: %w", err)
		}
		return printSarifOutput(report)
	}

	if format == "json" || format == "yaml" {
		return formatAndPrintRaw(format, respBody)
	}

	// Table output: parse and display human-readable report
	var report map[string]interface{}
	respBody, err = unwrapAPIResponse(respBody)
	if err != nil {
		return fmt.Errorf("API error: %w", err)
	}
	if err := json.Unmarshal(respBody, &report); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	// F-10: also fetch /scan/status (best-effort) so we can name the scanners
	// that failed AND surface the per-scanner error message. The aggregated
	// report has counts but only sometimes carries per-scanner names; the
	// live job status is the authoritative source.
	failed := fetchFailedScannerInfo(client, ctx, serverName)
	return printReportTable(serverName, report, failed)
}

// failedScannerInfo carries a failed scanner's ID and the error that the
// scanner runtime recorded for it. The error is rendered in the human-readable
// report so the user can tell e.g. that `ramparts` failed because of a glibc
// version mismatch — previously the CLI showed only the scanner name and the
// user had to dig into log files to find the cause.
type failedScannerInfo struct {
	ID    string
	Error string
}

// fetchFailedScannerInfo returns information about scanners that did not
// complete in the most recent scan job for `serverName`. Returns nil on any
// error so the caller can render the report without per-scanner names.
func fetchFailedScannerInfo(client *cliclient.Client, ctx context.Context, serverName string) []failedScannerInfo {
	resp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/servers/"+serverName+"/scan/status", nil)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil
	}
	body, err = unwrapAPIResponse(body)
	if err != nil {
		return nil
	}
	var status map[string]interface{}
	if err := json.Unmarshal(body, &status); err != nil {
		return nil
	}
	scannerStatuses, ok := status["scanner_statuses"].([]interface{})
	if !ok {
		return nil
	}
	var failed []failedScannerInfo
	for _, s := range scannerStatuses {
		ss, ok := s.(map[string]interface{})
		if !ok {
			continue
		}
		if getMapString(ss, "status") == "failed" {
			id := getMapString(ss, "scanner_id")
			if id == "" {
				continue
			}
			failed = append(failed, failedScannerInfo{
				ID:    id,
				Error: getMapString(ss, "error"),
			})
		}
	}
	return failed
}

// printScanSummary fetches and prints a compact summary after a scan completes.
func printScanSummary(client *cliclient.Client, ctx context.Context, serverName string) error {
	resp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/servers/"+serverName+"/scan/report", nil)
	if err != nil {
		fmt.Println("Scan completed. Use 'mcpproxy security report " + serverName + "' to view results.")
		return nil
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Println("Scan completed. Use 'mcpproxy security report " + serverName + "' to view results.")
		return nil
	}

	if resp.StatusCode != http.StatusOK {
		fmt.Println("Scan completed. Use 'mcpproxy security report " + serverName + "' to view results.")
		return nil
	}

	var report map[string]interface{}
	respBody, err = unwrapAPIResponse(respBody)
	if err != nil {
		return fmt.Errorf("API error: %w", err)
	}
	if err := json.Unmarshal(respBody, &report); err != nil {
		fmt.Println("Scan completed. Use 'mcpproxy security report " + serverName + "' to view results.")
		return nil
	}

	fmt.Printf("Scan completed for %q.\n\n", serverName)
	failed := fetchFailedScannerInfo(client, ctx, serverName)
	return printReportTable(serverName, report, failed)
}

// printReportTable prints a human-readable report with two-pass scan support.
//
// failedScanners (F-10) is the list of scanner IDs+errors that failed in the
// most recent scan job, sourced from /scan/status (the report itself only
// carries counts). When non-empty, the table shows a "Scanners: X run, Y
// failed" line, a yellow warn line about incomplete coverage, and per-scanner
// error reasons so the user can see WHY a scanner failed without grepping
// log files.
func printReportTable(serverName string, report map[string]interface{}, failedScanners []failedScannerInfo) error {
	riskScore := "?"
	if rs, ok := report["risk_score"].(float64); ok {
		riskScore = fmt.Sprintf("%d", int(rs))
	}

	scannedAt := getMapString(report, "scanned_at")
	jobID := getMapString(report, "job_id")

	// F-10 / MCP-2401: scanner coverage. Read counts up front so the risk-score
	// line can flag low confidence when part of the fleet never ran.
	scannersRun := int(getMapFloat(report, "scanners_run"))
	scannersFailed := int(getMapFloat(report, "scanners_failed"))
	scannersTotal := int(getMapFloat(report, "scanners_total"))

	fmt.Printf("Security Report: %s\n", serverName)
	if jobID != "" {
		fmt.Printf("Scan ID:     %s\n", jobID)
	}
	riskLine := fmt.Sprintf("Risk Score:  %s/100", riskScore)
	if scannersFailed > 0 && scannersTotal > 0 {
		// MCP-2401: the score was computed from an incomplete scan. Flag the
		// degraded confidence on the number itself, not only in the warning
		// block below, so a glance at "0/100" isn't read as an all-clear.
		riskLine += fmt.Sprintf(" (degraded — %d of %d scanners did not run)", scannersFailed, scannersTotal)
	}
	fmt.Println(riskLine)
	if scannedAt != "" {
		fmt.Printf("Scanned:     %s\n", formatTimestamp(scannedAt))
	}

	if scannersTotal > 0 {
		line := fmt.Sprintf("Scanners:    %d run, %d failed", scannersRun, scannersFailed)
		if scannersFailed > 0 && len(failedScanners) > 0 {
			names := make([]string, 0, len(failedScanners))
			for _, f := range failedScanners {
				names = append(names, f.ID)
			}
			line += " (" + strings.Join(names, ", ") + ")"
		}
		line += fmt.Sprintf(" of %d", scannersTotal)
		fmt.Println(line)
	}

	// Per-scanner wall-clock timing, so users can see which scanner dominated
	// the scan time. Sourced from scanner_statuses; silently skipped when the
	// report carries no per-scanner status data.
	printScannerTimings(report)

	// Scan context: show the user what was actually scanned. Without this the
	// terse "0 findings" / "1 finding" output gives no signal as to whether
	// the scan looked at real source code (docker_extract), a working_dir
	// fallback, or just the synthetic tool definitions (tool_definitions_only).
	// That distinction is critical when triaging a finding — a "Malicious
	// Code" hit located at tools.json:85 means something very different from
	// the same hit located at server.py:42.
	printScanContextSection(report)

	fmt.Println()

	// F-10: warn the user when coverage is incomplete so they don't approve
	// a server based on a "0 findings" result that's actually 5 of 7 scanners
	// silently failing.
	if scannersFailed > 0 && scannersTotal > 0 {
		warn := fmt.Sprintf("WARNING: Scan coverage incomplete: %d of %d scanners did not run", scannersFailed, scannersTotal)
		if stdoutIsTTY() {
			warn = "\x1b[33m" + warn + "\x1b[0m"
		}
		fmt.Println(warn)
		// Show the actual error message for each failed scanner so users can
		// diagnose without digging through ~/Library/Logs/mcpproxy/main.log.
		for _, f := range failedScanners {
			if f.Error == "" {
				continue
			}
			msg := f.Error
			if len(msg) > 240 {
				msg = msg[:240] + "..."
			}
			// Single-line: replace newlines so a multi-line stderr capture
			// doesn't break the indented layout.
			msg = strings.ReplaceAll(msg, "\n", " ")
			fmt.Printf("  - %s: %s\n", f.ID, msg)
		}
		fmt.Println()
	}

	// Separate findings by scan pass
	var pass1Findings, pass2Findings []interface{}
	if findings, ok := report["findings"].([]interface{}); ok {
		for _, f := range findings {
			if finding, ok := f.(map[string]interface{}); ok {
				scanPass := int(getMapFloat(finding, "scan_pass"))
				if scanPass == 2 {
					pass2Findings = append(pass2Findings, f)
				} else {
					pass1Findings = append(pass1Findings, f)
				}
			}
		}
	}

	// === Security Scan (Pass 1) ===
	fmt.Println("=== Security Scan (Pass 1) ===")
	if len(pass1Findings) == 0 {
		fmt.Println("  0 findings")
	} else {
		fmt.Printf("  %d finding(s)\n", len(pass1Findings))
		fmt.Println()
		printFindingsList(pass1Findings)
	}

	// === Supply Chain Audit (Pass 2) ===
	pass2Running := false
	if v, ok := report["pass2_running"].(bool); ok {
		pass2Running = v
	}
	pass2Complete := false
	if v, ok := report["pass2_complete"].(bool); ok {
		pass2Complete = v
	}

	fmt.Println()
	fmt.Println("=== Supply Chain Audit (Pass 2) ===")
	if pass2Running {
		fmt.Println("  Running in background...")
	} else if pass2Complete {
		if len(pass2Findings) == 0 {
			fmt.Println("  0 findings")
		} else {
			fmt.Printf("  %d finding(s)\n", len(pass2Findings))
			fmt.Println()
			printFindingsList(pass2Findings)
		}
	} else {
		fmt.Println("  Not started")
	}

	return nil
}

// printScanContextSection renders a one-block summary of *what* the scanners
// looked at (source method, files, container, tool definitions exported).
// This is the most important context for triaging a finding: a HIGH-severity
// finding located at tools.json from a tool_definitions_only scan is a very
// different signal from the same finding located at server.py from a
// docker_extract scan.
func printScanContextSection(report map[string]interface{}) {
	ctx, ok := report["scan_context"].(map[string]interface{})
	if !ok {
		return
	}
	method := getMapString(ctx, "source_method")
	if method == "" && getMapString(ctx, "server_protocol") == "" {
		return // nothing useful to render
	}

	fmt.Println()
	fmt.Println("Scan Context")
	if method != "" {
		fmt.Printf("  Source:           %s\n", method)
	}
	if path := getMapString(ctx, "source_path"); path != "" {
		fmt.Printf("  Path:             %s\n", path)
	}
	if proto := getMapString(ctx, "server_protocol"); proto != "" {
		fmt.Printf("  Protocol:         %s\n", proto)
	}
	if di, ok := ctx["docker_isolation"].(bool); ok {
		fmt.Printf("  Docker isolation: %t\n", di)
	}
	if cid := getMapString(ctx, "container_id"); cid != "" {
		// Truncate full SHA256 container IDs to 12 chars (docker's standard).
		short := cid
		if len(short) > 12 {
			short = short[:12]
		}
		fmt.Printf("  Container:        %s\n", short)
	}
	if tf, ok := ctx["total_files"].(float64); ok && int(tf) > 0 {
		fmt.Printf("  Files scanned:    %d\n", int(tf))
	}
	if te, ok := ctx["tools_exported"].(float64); ok && int(te) > 0 {
		fmt.Printf("  Tools analyzed:   %d\n", int(te))
	}
}

// printFindingsList prints a list of findings in the CLI report format.
func printFindingsList(findings []interface{}) {
	for _, f := range findings {
		finding, ok := f.(map[string]interface{})
		if !ok {
			continue
		}
		severity := strings.ToUpper(getMapString(finding, "severity"))
		ruleID := getMapString(finding, "rule_id")
		title := getMapString(finding, "title")
		description := getMapString(finding, "description")
		location := getMapString(finding, "location")
		scannerName := getMapString(finding, "scanner")
		helpURI := getMapString(finding, "help_uri")
		pkg := getMapString(finding, "package_name")
		installed := getMapString(finding, "installed_version")
		fixed := getMapString(finding, "fixed_version")
		threatLevel := getMapString(finding, "threat_level")
		threatType := getMapString(finding, "threat_type")
		category := getMapString(finding, "category")

		// Main line: [SEVERITY] CVE-ID: title (scanner)
		label := title
		if ruleID != "" && ruleID != title {
			label = ruleID
		}
		line := fmt.Sprintf("  [%s] %s", severity, label)
		if cvss, ok := finding["cvss_score"].(float64); ok && cvss > 0 {
			line += fmt.Sprintf(" CVSS=%.1f", cvss)
		}
		if scannerName != "" {
			line += " (" + scannerName + ")"
		}
		fmt.Println(line)

		// Title (when ruleID is the headline label)
		if title != "" && label == ruleID {
			fmt.Println("         Title:    " + title)
		}

		// Description: this is the long-form rule explanation. Previously the
		// CLI rendered ONLY the rule ID, leaving users to look up what e.g.
		// "MCP-MC-001" meant. Showing the description here mirrors the Web UI.
		if description != "" && description != title {
			desc := description
			if len(desc) > 240 {
				desc = desc[:240] + "..."
			}
			desc = strings.ReplaceAll(desc, "\n", " ")
			fmt.Println("         What:     " + desc)
		}

		// Threat classification context (already used in the Web UI but absent
		// from CLI output until now). Helps users distinguish a tool-poisoning
		// finding from an obfuscated-code finding from a CVE.
		if threatType != "" || threatLevel != "" || category != "" {
			parts := []string{}
			if threatLevel != "" {
				parts = append(parts, threatLevel)
			}
			if threatType != "" {
				parts = append(parts, threatType)
			}
			if category != "" && category != threatType {
				parts = append(parts, "category="+category)
			}
			if len(parts) > 0 {
				fmt.Println("         Threat:   " + strings.Join(parts, " · "))
			}
		}

		// Deterministic-scanner transparency (Spec 076 US4): the combined
		// confidence and the independent checks that contributed to this
		// finding, so an operator can see WHY a tool was flagged and that
		// agreement among checks raised its score.
		if conf, ok := finding["confidence"].(float64); ok && conf > 0 {
			fmt.Printf("         Confidence: %.2f\n", conf)
		}
		if rawSignals, ok := finding["signals"].([]interface{}); ok && len(rawSignals) > 0 {
			names := make([]string, 0, len(rawSignals))
			for _, s := range rawSignals {
				if name, ok := s.(string); ok && name != "" {
					names = append(names, name)
				}
			}
			if len(names) > 0 {
				fmt.Println("         Signals:  " + strings.Join(names, ", "))
			}
		}

		// Package info
		if pkg != "" {
			pkgLine := "         Package:  " + pkg
			if installed != "" {
				pkgLine += " v" + installed
			}
			if fixed != "" {
				pkgLine += " -> fix: " + fixed
			}
			fmt.Println(pkgLine)
		}

		// Location
		if location != "" {
			fmt.Println("         Location: " + location)
		}

		// Link to advisory
		if helpURI != "" {
			fmt.Println("         Details:  " + helpURI)
		}

		// Evidence (triggering content)
		evidence := getMapString(finding, "evidence")
		if evidence != "" {
			if len(evidence) > 200 {
				evidence = evidence[:200] + "..."
			}
			fmt.Println("         Evidence: " + evidence)
		}
	}
}

// printSarifOutput extracts and prints raw SARIF data from individual scanner reports.
func printSarifOutput(report map[string]interface{}) error {
	// Try to extract SARIF from individual scanner reports
	reports, ok := report["reports"].([]interface{})
	if !ok || len(reports) == 0 {
		return fmt.Errorf("no SARIF data available in report")
	}

	// Collect all SARIF runs into a combined envelope
	var allRuns []interface{}
	for _, r := range reports {
		if rep, ok := r.(map[string]interface{}); ok {
			if sarifRaw, ok := rep["sarif_raw"]; ok && sarifRaw != nil {
				// sarif_raw could be a json.RawMessage (string) or already parsed
				switch v := sarifRaw.(type) {
				case string:
					var sarif map[string]interface{}
					if err := json.Unmarshal([]byte(v), &sarif); err == nil {
						if runs, ok := sarif["runs"].([]interface{}); ok {
							allRuns = append(allRuns, runs...)
						}
					}
				case map[string]interface{}:
					if runs, ok := v["runs"].([]interface{}); ok {
						allRuns = append(allRuns, runs...)
					}
				}
			}
		}
	}

	if len(allRuns) == 0 {
		return fmt.Errorf("no SARIF data available in report")
	}

	// Build a combined SARIF envelope
	sarif := map[string]interface{}{
		"$schema": "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
		"version": "2.1.0",
		"runs":    allRuns,
	}

	formatted, err := json.MarshalIndent(sarif, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to format SARIF: %w", err)
	}
	fmt.Println(string(formatted))
	return nil
}
