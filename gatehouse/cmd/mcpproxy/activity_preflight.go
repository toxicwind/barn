package main

import (
	"fmt"
	"sort"
	"strings"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/storage"
)

// maxPreflightSummaryReasons caps how many distinct reason codes the one-line
// summary names before it collapses the tail into "+N more". A preflight may
// carry up to 100 ids across 15 reason codes; an uncapped rollup would push
// every other column of `activity list` off screen.
const maxPreflightSummaryReasons = 3

// maxPreflightSummaryCell bounds the summary in the `activity list` TOOL
// column, matching the cap the tool tables already use for their widest cell.
const maxPreflightSummaryCell = 60

// isPreflightActivity reports whether a record is a Spec 098 preflight.
func isPreflightActivity(activity map[string]interface{}) bool {
	return getStringField(activity, "type") == string(storage.ActivityTypePreflight)
}

// preflightReasonCount is one {reason code, count} pair of the metadata rollup.
type preflightReasonCount struct {
	Reason string
	Count  int
}

// preflightReasonRollup reads metadata["reasons"] into a DETERMINISTIC order:
// most frequent first, ties broken alphabetically. Map iteration order would
// otherwise make the same record render differently on every invocation, which
// breaks both diffing two runs and any test that asserts the line.
func preflightReasonRollup(metadata map[string]interface{}) []preflightReasonCount {
	counts := map[string]int{}
	for reason, raw := range getMapField(metadata, storage.MetadataKeyPreflightReasons) {
		if count, ok := numericMetadataValue(raw); ok {
			counts[reason] = count
		}
	}

	// Fallback for a record whose rollup is missing: recount from the per-tool
	// detail, which carries the same codes.
	if len(counts) == 0 {
		for _, entry := range getArrayField(metadata, storage.MetadataKeyPreflightPerTool) {
			tool, ok := entry.(map[string]interface{})
			if !ok {
				continue
			}
			if reason := getStringField(tool, storage.PreflightPerToolKeyReason); reason != "" {
				counts[reason]++
			}
		}
	}
	if len(counts) == 0 {
		return nil
	}

	rollup := make([]preflightReasonCount, 0, len(counts))
	for reason, count := range counts {
		rollup = append(rollup, preflightReasonCount{Reason: reason, Count: count})
	}
	sort.Slice(rollup, func(i, j int) bool {
		if rollup[i].Count != rollup[j].Count {
			return rollup[i].Count > rollup[j].Count
		}
		return rollup[i].Reason < rollup[j].Reason
	})
	return rollup
}

// formatPreflightReasons renders a rollup as "code xN, code xN". limit <= 0
// means "name them all"; a positive limit collapses the tail into "+N more".
func formatPreflightReasons(rollup []preflightReasonCount, limit int) string {
	if len(rollup) == 0 {
		return ""
	}

	shown := rollup
	remaining := 0
	if limit > 0 && len(rollup) > limit {
		shown = rollup[:limit]
		remaining = len(rollup) - limit
	}

	parts := make([]string, 0, len(shown)+1)
	for _, entry := range shown {
		parts = append(parts, fmt.Sprintf("%s x%d", entry.Reason, entry.Count))
	}
	if remaining > 0 {
		parts = append(parts, fmt.Sprintf("+%d more", remaining))
	}
	return strings.Join(parts, ", ")
}

// numericMetadataValue reads a metadata count that may have arrived as JSON
// (float64) or as the native int the writer used.
func numericMetadataValue(raw interface{}) (int, bool) {
	switch v := raw.(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	default:
		return 0, false
	}
}

// preflightIDsCount is how many unique tool ids the run evaluated. ids_count is
// authoritative (the writer sets it); per_tool length is the fallback for a
// record written by an older/partial writer.
func preflightIDsCount(metadata map[string]interface{}) int {
	if count := getIntField(metadata, storage.MetadataKeyPreflightIDsCount); count > 0 {
		return count
	}
	return len(getArrayField(metadata, storage.MetadataKeyPreflightPerTool))
}

// preflightActivitySummary renders the one-line verdict summary shown in the
// `activity list` table, e.g. "blocked (4 tools): server_disabled x2,
// tool_changed x1". Empty string for anything that is not a readable preflight
// record, so the caller falls back to its usual "-" placeholder.
func preflightActivitySummary(activity map[string]interface{}) string {
	if !isPreflightActivity(activity) {
		return ""
	}
	metadata := getMapField(activity, "metadata")
	if metadata == nil {
		return ""
	}
	verdict := getStringField(metadata, storage.MetadataKeyPreflightVerdict)
	if verdict == "" {
		return ""
	}

	count := preflightIDsCount(metadata)
	unit := "tools"
	if count == 1 {
		unit = "tool"
	}
	summary := fmt.Sprintf("%s (%d %s)", verdict, count, unit)

	if reasons := formatPreflightReasons(preflightReasonRollup(metadata), maxPreflightSummaryReasons); reasons != "" {
		summary += ": " + reasons
	}
	return summary
}

// preflightDetailLines builds the `activity show` section for a preflight
// record. It returns lines instead of printing so the rendering is unit-tested
// without capturing stdout. Empty slice ⇒ nothing to render.
func preflightDetailLines(activity map[string]interface{}) []string {
	if !isPreflightActivity(activity) {
		return nil
	}
	metadata := getMapField(activity, "metadata")
	if metadata == nil {
		return nil
	}
	verdict := getStringField(metadata, storage.MetadataKeyPreflightVerdict)
	if verdict == "" {
		return nil
	}

	lines := []string{
		"",
		"Preflight:",
		fmt.Sprintf("  Verdict:           %s", verdict),
		fmt.Sprintf("  Tools Checked:     %d", preflightIDsCount(metadata)),
	}
	// The full rollup here — the detail view has the room the table row lacks.
	if reasons := formatPreflightReasons(preflightReasonRollup(metadata), 0); reasons != "" {
		lines = append(lines, fmt.Sprintf("  Reasons:           %s", reasons))
	}

	perTool := getArrayField(metadata, storage.MetadataKeyPreflightPerTool)
	if len(perTool) == 0 {
		return lines
	}

	lines = append(lines, "", "  Tools:")
	for i, entry := range perTool {
		tool, ok := entry.(map[string]interface{})
		if !ok {
			continue
		}
		// Tool ids are caller-supplied strings that round-trip through the
		// activity log; escape them before they reach a tty (same trust
		// boundary as `tools list`).
		id := sanitizeName(getStringField(tool, storage.PreflightPerToolKeyID))
		status := getStringField(tool, storage.PreflightPerToolKeyStatus)
		line := fmt.Sprintf("    [%d] %-40s %s", i+1, id, status)
		if reason := getStringField(tool, storage.PreflightPerToolKeyReason); reason != "" {
			line += "  " + reason
		}
		lines = append(lines, line)
	}
	return lines
}

// displayPreflightSection prints the preflight detail for `activity show`.
func displayPreflightSection(activity map[string]interface{}) {
	for _, line := range preflightDetailLines(activity) {
		fmt.Println(line)
	}
}
