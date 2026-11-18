package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/term"

	clioutput "github.com/smart-mcp-proxy/mcpproxy-go/internal/cli/output"
)

// unwrapAPIResponse extracts the "data" field from an API response envelope
// {success: true, data: ...}. If the response is not wrapped, returns the raw bytes.
func unwrapAPIResponse(raw []byte) ([]byte, error) {
	var envelope struct {
		Success bool            `json:"success"`
		Data    json.RawMessage `json:"data"`
		Error   string          `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return raw, nil // Not an envelope, return raw
	}
	if envelope.Error != "" {
		return nil, fmt.Errorf("%s", envelope.Error)
	}
	if envelope.Data != nil {
		return envelope.Data, nil
	}
	return raw, nil // No data field, return raw
}

// formatAndPrint marshals the data in the given format and prints it.
func formatAndPrint(format string, data interface{}) error {
	formatter, err := clioutput.NewFormatter(format)
	if err != nil {
		return err
	}
	out, err := formatter.Format(data)
	if err != nil {
		return fmt.Errorf("failed to format output: %w", err)
	}
	fmt.Println(out)
	return nil
}

// formatAndPrintRaw parses raw JSON and re-formats it in the given format.
func formatAndPrintRaw(format string, rawJSON []byte) error {
	var data interface{}
	if err := json.Unmarshal(rawJSON, &data); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}
	return formatAndPrint(format, data)
}

// secJoinSlice joins a string slice field from a map for display.
func secJoinSlice(m map[string]interface{}, key string) string {
	items, ok := m[key].([]interface{})
	if !ok {
		return ""
	}
	strs := make([]string, len(items))
	for i, s := range items {
		strs[i] = fmt.Sprintf("%v", s)
	}
	return strings.Join(strs, ", ")
}

// secFormatInt formats a numeric field from a map as a string.
// signatureBundleLines renders the security overview's `signature_bundle`
// descriptor (spec 086 FR-019 / GH #938 finding 2). Before this, no supported
// surface could answer "which signatures is my proxy running, and how old are
// they?" — a years-stale corpus looked identical to a fresh export.
//
// Returns nil when the field is absent so an older daemon renders nothing
// rather than an empty block.
func signatureBundleLines(overview map[string]interface{}) []string {
	bundle, ok := overview["signature_bundle"].(map[string]interface{})
	if !ok || len(bundle) == 0 {
		return nil
	}

	source, _ := bundle["source"].(string)
	if path, _ := bundle["path"].(string); path != "" {
		source = fmt.Sprintf("%s (%s)", source, path)
	}

	lines := []string{
		"  Signature bundle:",
		fmt.Sprintf("    Source:      %s", source),
	}
	if version, _ := bundle["bundle_version"].(string); version != "" {
		lines = append(lines, fmt.Sprintf("    Version:     %s", version))
	}
	if generated, _ := bundle["generated_at"].(string); generated != "" {
		lines = append(lines, fmt.Sprintf("    Generated:   %s", generated))
	}
	if fingerprint, _ := bundle["fingerprint"].(string); fingerprint != "" {
		lines = append(lines, fmt.Sprintf("    Fingerprint: %s", fingerprint))
	}
	lines = append(lines, fmt.Sprintf("    Rules:       %s runnable, %s skipped, %s declared-skipped",
		secFormatInt(bundle, "runnable_rules"),
		secFormatInt(bundle, "skipped_rules"),
		secFormatInt(bundle, "declared_skipped")))
	if loadErr, _ := bundle["load_error"].(string); loadErr != "" {
		// A configured bundle that failed to load keeps the previous corpus
		// live; say so loudly rather than letting the counts imply all is well.
		lines = append(lines, fmt.Sprintf("    load error:  %s", loadErr))
	}
	if runnable, _ := bundle["runnable_rules"].(float64); runnable == 0 {
		// Zero runnable rules means offline TPA coverage is OFF. Printed in the
		// same tone as a healthy count, it read as "fine" — the exact class of
		// "the runtime is right but the operator is misled" bug #938 is about.
		lines = append(lines, "    WARNING:     no TPA signatures are running — offline scan coverage is OFF")
	}
	return append(lines, "")
}

func secFormatInt(m map[string]interface{}, key string) string {
	if v, ok := m[key].(float64); ok {
		return fmt.Sprintf("%d", int(v))
	}
	return "0"
}

// scannerDisplayStatus normalizes the scanner status to a single vocabulary
// shared between table and JSON/YAML output (F-09).
//
// Vocabulary (richest set kept consistent across formats):
//
//	available  - registry entry, image not pulled
//	pulling    - docker pull in progress
//	installed  - image present, but required env vars not yet set
//	configured - image present and required secrets set (ready to run)
//	error      - last operation failed; see error_message
//
// Unknown values are returned verbatim so future statuses do not get hidden.
func scannerDisplayStatus(status string) string {
	switch status {
	case "available", "pulling", "installed", "configured", "error":
		return status
	case "":
		return "unknown"
	default:
		return status
	}
}

// scannerStatusColor returns an ANSI color escape for a scanner status, plus
// the matching reset sequence. Returns empty strings when stdout is not a TTY
// so that piped output stays clean.
func scannerStatusColor(status string) (open, reset string) {
	if !stdoutIsTTY() {
		return "", ""
	}
	switch status {
	case "configured":
		return "\x1b[32m", "\x1b[0m" // green
	case "installed":
		return "\x1b[36m", "\x1b[0m" // cyan
	case "pulling":
		return "\x1b[33m", "\x1b[0m" // yellow
	case "error":
		return "\x1b[31m", "\x1b[0m" // red
	case "available":
		return "\x1b[90m", "\x1b[0m" // bright black / grey
	default:
		return "", ""
	}
}

// stdoutIsTTY returns true when stdout is connected to an interactive terminal.
// Used to gate ANSI escapes (colors, cursor moves) so piped output stays clean.
func stdoutIsTTY() bool {
	return term.IsTerminal(int(os.Stdout.Fd()))
}

// stderrIsTTY returns true when stderr is connected to an interactive
// terminal. Used to gate the rolling (\r) progress display, which is written
// to stderr so machine formats keep stdout parseable.
func stderrIsTTY() bool {
	return term.IsTerminal(int(os.Stderr.Fd()))
}

// normalizeOverviewLastScan replaces a Go zero-time `last_scan_at` value with
// JSON null so neither the table nor the JSON/YAML serializers display
// "0001-01-01T00:00:00Z" to the user (F-14). The key is preserved (as nil) so
// existing consumers don't see a missing field.
func normalizeOverviewLastScan(overview map[string]interface{}) {
	if overview == nil {
		return
	}
	v, present := overview["last_scan_at"]
	if !present {
		// Insert nil so JSON output still has the field for schema stability.
		overview["last_scan_at"] = nil
		return
	}
	s, ok := v.(string)
	if !ok || s == "" {
		overview["last_scan_at"] = nil
		return
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil && t.IsZero() {
		overview["last_scan_at"] = nil
		return
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil && t.IsZero() {
		overview["last_scan_at"] = nil
		return
	}
	// Also catch the literal stdlib zero serialization.
	if strings.HasPrefix(s, "0001-01-01") {
		overview["last_scan_at"] = nil
	}
}

// secTruncate shortens a string to maxLen, appending "..." if truncated.
func secTruncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	if maxLen <= 3 {
		return s[:maxLen]
	}
	return s[:maxLen-3] + "..."
}

// formatTimestamp parses an RFC3339 timestamp and reformats it for display.
func formatTimestamp(ts string) string {
	if t, err := time.Parse(time.RFC3339, ts); err == nil {
		return t.Format("2006-01-02 15:04:05")
	}
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return t.Format("2006-01-02 15:04:05")
	}
	return ts
}
