package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
)

func runSecurityScan(_ *cobra.Command, args []string) error {
	// Handle --all flag
	if secScanAll {
		return runSecurityScanAll()
	}

	// Single server mode requires exactly one argument
	if len(args) < 1 {
		return fmt.Errorf("server name is required (or use --all to scan all servers)")
	}

	client, cfg, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	serverName := args[0]

	// F-06: --dry-run never starts a real scan. Instead, fetch the scanner
	// inventory + (best-effort) the server's last scan context, and print a
	// human-readable plan describing what *would* run. We still exit 0 so
	// the dry-run is scriptable.
	if secScanDryRun {
		return printScanDryRunPlan(client, serverName, secScanners)
	}

	// Build request body
	reqBody := map[string]interface{}{
		"dry_run": secScanDryRun,
	}
	if secScanners != "" {
		reqBody["scanner_ids"] = splitAndTrim(secScanners)
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	// Compute a sane hard timeout for the whole scan operation:
	//   per-scanner-timeout * scanner_count + 30s margin, capped at 30 min
	// (or default to 15 min if we can't infer it).
	hardTimeout := computeScanHardTimeout(cfg, secScanners)
	ctx, cancel := context.WithTimeout(context.Background(), hardTimeout)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodPost, "/api/v1/servers/"+serverName+"/scan", body)
	if err != nil {
		return fmt.Errorf("failed to start scan: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	// Check for disabled server (500 with specific message)
	if resp.StatusCode == http.StatusInternalServerError {
		errMsg := extractAPIErrorMsg(respBody)
		if strings.Contains(strings.ToLower(errMsg), "disabled") || strings.Contains(strings.ToLower(errMsg), "not enabled") {
			fmt.Fprintf(os.Stderr, "Error: Server %q is disabled. Enable it first or quarantine and scan:\n", serverName)
			fmt.Fprintf(os.Stderr, "  mcpproxy upstream enable %s\n", serverName)
			fmt.Fprintf(os.Stderr, "  mcpproxy security scan %s\n", serverName)
			return fmt.Errorf("server %q is disabled", serverName)
		}
	}

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "start scan")
	}

	var job map[string]interface{}
	respBody, err = unwrapAPIResponse(respBody)
	if err != nil {
		return fmt.Errorf("API error: %w", err)
	}
	if err := json.Unmarshal(respBody, &job); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	jobID := getMapString(job, "id")

	// If --async, return immediately with the job ID
	if secScanAsync {
		format := ResolveOutputFormat()
		if format == "json" || format == "yaml" {
			return formatAndPrint(format, job)
		}
		fmt.Printf("Scan started for %q (job: %s)\n", serverName, jobID)
		fmt.Println("Use 'mcpproxy security status " + serverName + "' to check progress.")
		return nil
	}

	// Synchronous mode: poll until done.
	//
	// F-05 fixes:
	//   1. Unwrap the API envelope (`{success,data}`) before reading status —
	//      the previous loop read `status` from the envelope and never saw
	//      "completed", causing infinite spin.
	//   2. Use a 750ms ticker (no tight loop, no 2s lag).
	//   3. Honor a hard timeout based on the configured per-scanner timeout.
	//   4. Print one progress line per tick with run/running/failed counts.
	// Progress goes to stderr so stdout stays clean for machine formats
	// (see docs/cli-output-formatting.md).
	fmt.Fprintf(os.Stderr, "Scanning %q (timeout %s, job %s)...\n", serverName, hardTimeout, jobID)
	scanStart := time.Now()

	ticker := time.NewTicker(750 * time.Millisecond)
	defer ticker.Stop()

	var lastProgressLen int
	for {
		select {
		case <-ctx.Done():
			fmt.Fprintln(os.Stderr)
			return fmt.Errorf("scan timed out after %s for %q (job %s); use 'mcpproxy security status %s' to inspect", hardTimeout, serverName, jobID, serverName)
		case <-ticker.C:
		}

		statusResp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/servers/"+serverName+"/scan/status", nil)
		if err != nil {
			return fmt.Errorf("failed to check scan status: %w", err)
		}

		statusBody, err := io.ReadAll(statusResp.Body)
		statusResp.Body.Close()
		if err != nil {
			return fmt.Errorf("failed to read status response: %w", err)
		}

		if statusResp.StatusCode != http.StatusOK {
			return parseAPIError(statusBody, statusResp.StatusCode, "check scan status")
		}

		// CRITICAL: unwrap the API envelope. The previous implementation
		// read job fields directly from the envelope and never observed
		// the "completed" terminal state.
		statusBody, err = unwrapAPIResponse(statusBody)
		if err != nil {
			return fmt.Errorf("API error: %w", err)
		}
		var status map[string]interface{}
		if err := json.Unmarshal(statusBody, &status); err != nil {
			return fmt.Errorf("failed to parse status response: %w", err)
		}

		jobStatus := getMapString(status, "status")
		elapsed := time.Since(scanStart).Truncate(time.Second)

		// Aggregate per-scanner counts so the user sees forward progress.
		var run, running, failed, total int
		var runningNames []string
		if scannerStatuses, ok := status["scanner_statuses"].([]interface{}); ok {
			total = len(scannerStatuses)
			for _, s := range scannerStatuses {
				ss, ok := s.(map[string]interface{})
				if !ok {
					continue
				}
				switch getMapString(ss, "status") {
				case "completed":
					run++
				case "failed":
					failed++
				case "running":
					running++
					if name := getMapString(ss, "scanner_id"); name != "" {
						runningNames = append(runningNames, name)
					}
				}
			}
		}

		progress := fmt.Sprintf("  [%s] %d run, %d running, %d failed of %d", elapsed, run, running, failed, total)
		if len(runningNames) > 0 {
			progress += fmt.Sprintf(" (running: %s)", strings.Join(runningNames, ", "))
		}
		// Erase previous line on TTY for a clean rolling display; on a pipe
		// just print one progress line per tick. Progress is written to
		// stderr, so the TTY check must follow stderr (not stdout) — else
		// `2>scan.log` on a terminal would fill the log with \r frames.
		if stderrIsTTY() {
			pad := ""
			if lastProgressLen > len(progress) {
				pad = strings.Repeat(" ", lastProgressLen-len(progress))
			}
			fmt.Fprint(os.Stderr, "\r"+progress+pad)
			lastProgressLen = len(progress)
		} else {
			fmt.Fprintln(os.Stderr, progress)
		}

		switch jobStatus {
		case "completed":
			if stderrIsTTY() {
				fmt.Fprintln(os.Stderr)
			}
			fmt.Fprintf(os.Stderr, "  Scan completed in %s\n", elapsed)
			return printScanSummary(client, ctx, serverName)
		case "failed":
			if stderrIsTTY() {
				fmt.Fprintln(os.Stderr)
			}
			fmt.Fprintf(os.Stderr, "  Scan failed after %s\n", elapsed)
			errMsg := getMapString(status, "error")
			if errMsg != "" {
				return fmt.Errorf("scan failed: %s", errMsg)
			}
			return fmt.Errorf("scan failed for %q", serverName)
		case "cancelled":
			if stderrIsTTY() {
				fmt.Fprintln(os.Stderr)
			}
			fmt.Fprintf(os.Stderr, "  Scan cancelled after %s\n", elapsed)
			return fmt.Errorf("scan was cancelled for %q", serverName)
		}
		// pending or running: continue polling
	}
}

// computeScanHardTimeout returns a sensible upper bound for a scan operation:
//
//	per_scanner_timeout * num_scanners + 30s margin, capped at 30 minutes.
//
// If the config does not specify a per-scanner timeout, falls back to 15 min.
func computeScanHardTimeout(cfg *config.Config, scannerFlag string) time.Duration {
	const fallback = 15 * time.Minute
	const cap = 30 * time.Minute

	if cfg == nil || cfg.Security == nil || time.Duration(cfg.Security.ScanTimeoutDefault) <= 0 {
		return fallback
	}
	per := time.Duration(cfg.Security.ScanTimeoutDefault)

	count := 0
	if scannerFlag != "" {
		count = len(splitAndTrim(scannerFlag))
	}
	if count <= 0 {
		// We don't know how many scanners are installed; assume up to 8.
		count = 8
	}
	total := per*time.Duration(count) + 30*time.Second
	if total > cap {
		return cap
	}
	if total < fallback {
		return fallback
	}
	return total
}

// printScanDryRunPlan implements the F-06 frontend dry-run: instead of asking
// the engine to "simulate" a scan (which today still launches containers),
// fetch the scanner inventory and the server's last scan context, then print
// a plan describing what *would* execute.
func printScanDryRunPlan(client *cliclient.Client, serverName, scannerFlag string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	// 1. Fetch all scanners so we can show docker images / commands.
	scanResp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/security/scanners", nil)
	if err != nil {
		return fmt.Errorf("failed to list scanners: %w", err)
	}
	scanRaw, err := io.ReadAll(scanResp.Body)
	scanResp.Body.Close()
	if err != nil {
		return fmt.Errorf("failed to read scanners response: %w", err)
	}
	if scanResp.StatusCode != http.StatusOK {
		return parseAPIError(scanRaw, scanResp.StatusCode, "list scanners")
	}
	scanRaw, err = unwrapAPIResponse(scanRaw)
	if err != nil {
		return fmt.Errorf("API error: %w", err)
	}
	var allScanners []map[string]interface{}
	if err := json.Unmarshal(scanRaw, &allScanners); err != nil {
		return fmt.Errorf("failed to parse scanners response: %w", err)
	}

	// 2. Filter scanners: explicit --scanners flag wins, otherwise pick the
	//    ones that are configured/installed (i.e. the engine would run them).
	var selected []map[string]interface{}
	if scannerFlag != "" {
		wanted := make(map[string]bool)
		for _, id := range splitAndTrim(scannerFlag) {
			wanted[id] = true
		}
		for _, sc := range allScanners {
			if wanted[getMapString(sc, "id")] {
				selected = append(selected, sc)
			}
		}
	} else {
		for _, sc := range allScanners {
			st := getMapString(sc, "status")
			if st == "installed" || st == "configured" {
				selected = append(selected, sc)
			}
		}
	}

	// 3. Best-effort: fetch the server's last scan context for source info.
	//    This may 404 if the server has never been scanned — that's fine.
	var scanContext map[string]interface{}
	filesResp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/servers/"+serverName+"/scan/files", nil)
	if err == nil {
		filesRaw, _ := io.ReadAll(filesResp.Body)
		filesResp.Body.Close()
		if filesResp.StatusCode == http.StatusOK {
			if unwrapped, uerr := unwrapAPIResponse(filesRaw); uerr == nil {
				_ = json.Unmarshal(unwrapped, &scanContext)
			}
		}
	}

	format := ResolveOutputFormat()
	plan := map[string]interface{}{
		"server":   serverName,
		"dry_run":  true,
		"scanners": selected,
	}
	if scanContext != nil {
		plan["source"] = map[string]interface{}{
			"method":           getMapString(scanContext, "source_method"),
			"path":             getMapString(scanContext, "source_path"),
			"docker_isolation": scanContext["docker_isolation"],
			"total_files":      scanContext["total_files"],
		}
	}

	if format == "json" || format == "yaml" {
		return formatAndPrint(format, plan)
	}

	// Human-readable plan
	fmt.Printf("Dry-run plan for %q\n", serverName)
	fmt.Println(strings.Repeat("-", 60))
	if scanContext != nil {
		fmt.Println("Source (from last scan):")
		fmt.Printf("  Method:           %s\n", getMapString(scanContext, "source_method"))
		fmt.Printf("  Path:             %s\n", getMapString(scanContext, "source_path"))
		if di, ok := scanContext["docker_isolation"].(bool); ok {
			fmt.Printf("  Docker isolation: %t\n", di)
		}
		if tf, ok := scanContext["total_files"].(float64); ok {
			fmt.Printf("  Files (last):     %d\n", int(tf))
		}
	} else {
		fmt.Println("Source: (no prior scan context — source will be resolved at scan time)")
	}
	fmt.Println()

	if len(selected) == 0 {
		fmt.Println("No scanners would run.")
		if scannerFlag != "" {
			fmt.Println("(no scanners matched --scanners filter)")
		} else {
			fmt.Println("(no scanners are installed/configured — run `mcpproxy security enable <id>`)")
		}
		return nil
	}

	fmt.Printf("Scanners that would run (%d):\n", len(selected))
	for _, sc := range selected {
		id := getMapString(sc, "id")
		name := getMapString(sc, "name")
		status := getMapString(sc, "status")
		image := getMapString(sc, "docker_image")
		if override := getMapString(sc, "image_override"); override != "" {
			image = override
		}
		timeout := getMapString(sc, "timeout")
		fmt.Printf("  - %s (%s) [%s]\n", id, name, status)
		if image != "" {
			fmt.Printf("      image:   %s\n", image)
		}
		if timeout != "" {
			fmt.Printf("      timeout: %s\n", timeout)
		}
		if cmd, ok := sc["command"].([]interface{}); ok && len(cmd) > 0 {
			parts := make([]string, len(cmd))
			for i, p := range cmd {
				parts[i] = fmt.Sprintf("%v", p)
			}
			fmt.Printf("      command: %s\n", strings.Join(parts, " "))
		}
		if inputs, ok := sc["inputs"].([]interface{}); ok && len(inputs) > 0 {
			parts := make([]string, len(inputs))
			for i, p := range inputs {
				parts[i] = fmt.Sprintf("%v", p)
			}
			fmt.Printf("      inputs:  %s\n", strings.Join(parts, ", "))
		}
	}

	fmt.Println()
	fmt.Println("Dry-run only — no scanners executed. Re-run without --dry-run to scan.")
	return nil
}

// runSecurityScanAll handles the --all flag: starts a batch scan and polls for progress.
func runSecurityScanAll() error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return err
	}

	// Build request body
	reqBody := map[string]interface{}{}
	if secScanners != "" {
		reqBody["scanner_ids"] = splitAndTrim(secScanners)
	}

	body, err := json.Marshal(reqBody)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	resp, err := client.DoRaw(ctx, http.MethodPost, "/api/v1/security/scan-all", body)
	if err != nil {
		return fmt.Errorf("failed to start batch scan: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		return parseAPIError(respBody, resp.StatusCode, "start batch scan")
	}

	format := ResolveOutputFormat()

	// If --async, return immediately
	if secScanAsync {
		if format == "json" || format == "yaml" {
			return formatAndPrintRaw(format, respBody)
		}
		fmt.Println("Batch scan started. Use 'mcpproxy security scan --all' to check progress.")
		return nil
	}

	// F-16: poll on a steady ticker; on a TTY redraw the table in place using
	// ANSI cursor escapes. On a pipe, fall back to one status line per tick so
	// the output is grep/awk friendly.
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	tty := stdoutIsTTY()
	var prevLines int
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("batch scan timed out after 30m; use 'mcpproxy security cancel-all' to abort")
		case <-ticker.C:
		}

		qResp, err := client.DoRaw(ctx, http.MethodGet, "/api/v1/security/queue", nil)
		if err != nil {
			return fmt.Errorf("failed to check queue progress: %w", err)
		}

		qBody, err := io.ReadAll(qResp.Body)
		qResp.Body.Close()
		if err != nil {
			return fmt.Errorf("failed to read queue response: %w", err)
		}

		if qResp.StatusCode != http.StatusOK {
			return parseAPIError(qBody, qResp.StatusCode, "check queue progress")
		}

		var progress map[string]interface{}
		qBody, err = unwrapAPIResponse(qBody)
		if err != nil {
			return fmt.Errorf("API error: %w", err)
		}
		if err := json.Unmarshal(qBody, &progress); err != nil {
			return fmt.Errorf("failed to parse progress: %w", err)
		}

		// Check if idle (no batch in progress)
		queueStatus := getMapString(progress, "status")
		if queueStatus == "idle" {
			fmt.Println("No batch scan in progress.")
			return nil
		}

		// Final state — print the final table without redraw, then exit.
		if queueStatus == "completed" || queueStatus == "cancelled" {
			if format == "json" || format == "yaml" {
				return formatAndPrint(format, progress)
			}
			if tty && prevLines > 0 {
				clearPreviousLines(prevLines)
			}
			printQueueProgressTable(progress)
			fmt.Println()
			if queueStatus == "completed" {
				fmt.Println("Batch scan completed.")
			} else {
				fmt.Println("Batch scan was cancelled.")
			}
			return nil
		}

		if tty {
			if prevLines > 0 {
				clearPreviousLines(prevLines)
			}
			prevLines = printQueueProgressTable(progress)
		} else {
			printQueueProgressOneLine(progress)
		}
	}
}

// clearPreviousLines uses ANSI escapes to move the cursor up `n` lines and
// erase from the cursor to the end of screen. Used to redraw the batch-scan
// progress table in place.
func clearPreviousLines(n int) {
	if n <= 0 {
		return
	}
	// CUU n: move cursor up; ED 0: clear from cursor to end of screen.
	fmt.Printf("\x1b[%dA\x1b[J", n)
}

// printQueueProgressTable prints the progress table for a batch scan and
// returns the number of lines printed (so the caller can erase them next tick).
func printQueueProgressTable(progress map[string]interface{}) int {
	total := int(getMapFloat(progress, "total"))
	completed := int(getMapFloat(progress, "completed"))
	running := int(getMapFloat(progress, "running"))
	skipped := int(getMapFloat(progress, "skipped"))
	failed := int(getMapFloat(progress, "failed"))

	lines := 0

	header := fmt.Sprintf("Scanning all servers (%d/%d completed, %d running", completed, total, running)
	if skipped > 0 {
		header += fmt.Sprintf(", %d skipped", skipped)
	}
	if failed > 0 {
		header += fmt.Sprintf(", %d failed", failed)
	}
	header += ")..."
	fmt.Println(header)
	lines++

	// Table header
	fmt.Printf("%-24s %-12s %-10s %s\n", "SERVER", "STATUS", "FINDINGS", "ERROR")
	lines++
	fmt.Println(strings.Repeat("-", 70))
	lines++

	// Items
	if items, ok := progress["items"].([]interface{}); ok {
		for _, item := range items {
			it, ok := item.(map[string]interface{})
			if !ok {
				continue
			}
			name := getMapString(it, "server_name")
			status := getMapString(it, "status")
			errMsg := getMapString(it, "error")
			skipReason := getMapString(it, "skip_reason")

			// F-16: pull findings_count from the per-item job status so the
			// FINDINGS column shows real numbers instead of "-".
			findings := "-"
			if fc, ok := it["findings_count"].(float64); ok {
				findings = fmt.Sprintf("%d", int(fc))
			} else if fc, ok := it["findings"].(float64); ok {
				findings = fmt.Sprintf("%d", int(fc))
			}

			// Show error or skip reason
			msg := errMsg
			if skipReason != "" {
				msg = skipReason
			}
			if len(msg) > 30 {
				msg = msg[:27] + "..."
			}

			fmt.Printf("%-24s %-12s %-10s %s\n",
				secTruncate(name, 24),
				status,
				findings,
				msg,
			)
			lines++
		}
	}
	return lines
}

// printQueueProgressOneLine prints a single-line summary of batch progress.
// Used in non-TTY mode (e.g. when stdout is piped) to keep output greppable.
func printQueueProgressOneLine(progress map[string]interface{}) {
	total := int(getMapFloat(progress, "total"))
	completed := int(getMapFloat(progress, "completed"))
	running := int(getMapFloat(progress, "running"))
	skipped := int(getMapFloat(progress, "skipped"))
	failed := int(getMapFloat(progress, "failed"))
	fmt.Printf("[batch] %d/%d completed, %d running, %d skipped, %d failed\n",
		completed, total, running, skipped, failed)
}
