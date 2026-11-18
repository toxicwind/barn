package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cli/output"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/contracts"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/preflight"

	"github.com/spf13/cobra"
)

// newToolsPreflightCmd builds `mcpproxy tools preflight`, the cron/CI gate: one
// deterministic, side-effect-free check that answers "are these tools usable
// right now?" before a job spends model tokens finding out the hard way.
//
// The exit code is the product: 0 all ready, 10 retryable (back off), 11 an
// operator has to act, 12 an id does not exist. A wrapper can branch on it
// without parsing any JSON.
func newToolsPreflightCmd() *cobra.Command {
	var (
		profile            string
		pins               []string
		readOnlyOnly       bool
		excludeDestructive bool
		excludeOpenWorld   bool
		wait               time.Duration
	)

	cmd := &cobra.Command{
		Use:   "preflight <server:tool> [<server:tool>...]",
		Short: "Check that required tools are ready, without calling any upstream server",
		Long: `Check a list of required tools against local proxy state and report, per tool,
whether it is ready or exactly why it is not.

The check performs zero upstream calls and changes nothing: it reads the tool
index, approval records, connection state and configuration policy only.

Exit codes (worst class present wins):
  0   every tool is ready
  10  degraded but retryable (a server is starting up or unhealthy) — back off and retry
  11  blocked: an operator action is needed (approve, enable, log in, re-pin)
  12  at least one requested id is unknown in your view (typo, or removed server)
  1   the command itself failed (daemon unreachable, invalid arguments)

Examples:
  mcpproxy tools preflight gh-ops:sync_issues slack:post_message
  mcpproxy tools preflight ctl:echo -o json
  mcpproxy tools preflight ctl:echo --pin ctl:echo=sha256/v1:9f86d0...
  mcpproxy tools preflight ctl:echo --profile work --wait 5s
  mcpproxy tools preflight ctl:echo --read-only-only`,
		// Tool ids are required — except under --help-json, which is a
		// discovery call an agent makes before it knows what to pass. Cobra
		// validates Args before the --help-json hook runs, so a plain
		// MinimumNArgs(1) would make the command's own metadata unreachable.
		Args: preflightArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			request, err := buildPreflightRequest(args, pins, profile, wait,
				contracts.PreflightPolicy{
					ReadOnlyOnly:       readOnlyOnly,
					ExcludeDestructive: excludeDestructive,
					ExcludeOpenWorld:   excludeOpenWorld,
				})
			if err != nil {
				// Argument errors keep the usage block: the operator mistyped
				// the invocation and the syntax is the answer. They are still
				// exit 1, not a verdict code.
				return newPreflightGeneralError(err)
			}
			cmd.SilenceUsage = true
			// From here the command's return value is a VERDICT, not a usage
			// problem. Cobra would print it a second time on top of the central
			// handler's "Error: …" line, and a cron log with the same verdict
			// twice reads like two failures.
			cmd.SilenceErrors = true
			return runToolsPreflight(request)
		},
	}

	cmd.Flags().StringVar(&profile, "profile", "", "Evaluate under a named profile's server scope")
	cmd.Flags().StringArrayVar(&pins, "pin", nil, "Pin a tool to a schema hash: --pin <server:tool>=sha256/v<N>:<hex> (repeatable)")
	cmd.Flags().BoolVar(&readOnlyOnly, "read-only-only", false, "Require tools to be annotated read-only")
	cmd.Flags().BoolVar(&excludeDestructive, "exclude-destructive", false, "Require tools to be annotated non-destructive")
	cmd.Flags().BoolVar(&excludeOpenWorld, "exclude-open-world", false, "Require tools to be annotated closed-world")
	cmd.Flags().DurationVar(&wait, "wait", 0, "Poll local state for up to this long while every failure is retryable (max 10s)")

	return cmd
}

// preflightArgs requires at least one tool id, but lets `--help-json` through
// with none: that flag is answered by a PersistentPreRunE hook, which cobra
// runs AFTER argument validation, so a bare MinimumNArgs(1) would hide the
// command's machine-readable help from the agents it exists for.
func preflightArgs(cmd *cobra.Command, args []string) error {
	if helpJSON, err := cmd.Flags().GetBool("help-json"); err == nil && helpJSON {
		return nil
	}
	return cobra.MinimumNArgs(1)(cmd, args)
}

// buildPreflightRequest turns CLI arguments into the REST request body.
//
// It validates only what is genuinely local (pin syntax, pins naming an id that
// was not requested, and the wait range — see below). Everything else — the
// 100-id cap, unknown profiles — is the daemon's rule, and duplicating it here
// would give the two surfaces two chances to disagree.
//
// --wait is the exception, and only because the wire field is milliseconds: the
// conversion is LOSSY, so `--wait -1ns` would reach the daemon as 0 and
// `--wait 10.0000001s` as an in-range 10000. Both would be accepted as
// something the operator did not ask for. The range is checked on the exact
// duration, against the same cap the daemon enforces (preflight.MaxWaitMS).
func buildPreflightRequest(ids, pins []string, profile string, wait time.Duration, policy contracts.PreflightPolicy) (*contracts.PreflightRequest, error) {
	pinByID, err := parsePreflightPins(pins)
	if err != nil {
		return nil, err
	}
	if err := validatePreflightWaitFlag(wait); err != nil {
		return nil, err
	}

	request := &contracts.PreflightRequest{
		Tools:   make([]contracts.PreflightToolRef, 0, len(ids)),
		Profile: strings.TrimSpace(profile),
		WaitMS:  int(wait.Milliseconds()),
	}
	if policy.ReadOnlyOnly || policy.ExcludeDestructive || policy.ExcludeOpenWorld {
		policyCopy := policy
		request.Policy = &policyCopy
	}

	requested := make(map[string]bool, len(ids))
	for _, raw := range ids {
		id := strings.TrimSpace(raw)
		if id == "" {
			return nil, fmt.Errorf("empty tool id in arguments (expected <server>:<tool>)")
		}
		requested[id] = true
		request.Tools = append(request.Tools, contracts.PreflightToolRef{ID: id, PinHash: pinByID[id]})
	}

	for id := range pinByID {
		if !requested[id] {
			return nil, fmt.Errorf("--pin names %q, which is not in the requested tool list", id)
		}
	}

	return request, nil
}

// maxPreflightWait is the --wait cap as a duration, derived from the wire cap
// so the two can never drift apart.
const maxPreflightWait = preflight.MaxWaitMS * time.Millisecond

// validatePreflightWaitFlag rejects a wait outside [0, 10s] on the EXACT
// duration, before it is truncated to milliseconds.
func validatePreflightWaitFlag(wait time.Duration) error {
	if wait < 0 {
		return fmt.Errorf("--wait must not be negative (got %s)", wait)
	}
	if wait > maxPreflightWait {
		return fmt.Errorf("--wait is %s, which exceeds the cap of %s", wait, maxPreflightWait)
	}
	return nil
}

// parsePreflightPins parses repeatable `--pin <id>=<hash>` flags. The split is
// on the FIRST '=' because a pin value is "sha256/v1:<hex>" — it carries ':'
// and '/', but never '=' — while the id carries ':'.
func parsePreflightPins(pins []string) (map[string]string, error) {
	out := make(map[string]string, len(pins))
	for _, pin := range pins {
		idx := strings.Index(pin, "=")
		if idx <= 0 {
			return nil, fmt.Errorf("invalid --pin %q: expected <server>:<tool>=<hash>", pin)
		}
		id := strings.TrimSpace(pin[:idx])
		hash := strings.TrimSpace(pin[idx+1:])
		if id == "" || hash == "" {
			return nil, fmt.Errorf("invalid --pin %q: expected <server>:<tool>=<hash>", pin)
		}
		if existing, ok := out[id]; ok && existing != hash {
			return nil, fmt.Errorf("conflicting --pin values for %q: %q and %q", id, existing, hash)
		}
		out[id] = hash
	}
	return out, nil
}

// runToolsPreflight calls the daemon, renders the result, and converts a
// non-ready verdict into the typed exit-code error.
func runToolsPreflight(request *contracts.PreflightRequest) error {
	client, _, err := newSecurityCLIClient()
	if err != nil {
		return newPreflightGeneralError(err)
	}

	// The request's own wait budget is capped at 10s daemon-side; the transport
	// deadline just has to outlive it.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	response, err := client.Preflight(ctx, request)
	if err != nil {
		return newPreflightGeneralError(cliError("preflight failed", err))
	}

	rendered, err := renderPreflight(ResolveOutputFormat(), response)
	if err != nil {
		return newPreflightGeneralError(err)
	}
	fmt.Print(rendered)

	// The verdict is not a command failure — it is the answer. It travels as a
	// typed error purely so the CENTRAL classifier assigns 10/11/12.
	return newPreflightVerdictError(preflightExitVerdict(response), preflightSummary(response))
}

// preflightExitVerdict is the verdict the exit code comes from: the worse of
// what the daemon reported and what the per-tool results imply.
//
// Recomputing locally is deliberate. The exit code is the contract a cron
// wrapper trusts, and taking the max of both readings means an older daemon
// that under-reports the set verdict can never make a blocked tool look like a
// clean run. Both readings use the same locked table (preflight.ExitCode), so
// "worse" is just the higher exit code.
func preflightExitVerdict(response *contracts.PreflightResponse) string {
	if response == nil {
		return preflight.VerdictReady
	}
	reasons := make([]string, 0, len(response.Tools))
	for _, tool := range response.Tools {
		if tool.Status == preflight.StatusReady {
			continue
		}
		reasons = append(reasons, tool.Reason)
	}
	worst := preflight.VerdictForReasons(reasons)
	if preflight.ExitCode(response.Verdict) > preflight.ExitCode(worst) {
		return response.Verdict
	}
	return worst
}

// preflightSummary is the one-line context that rides along with the exit-code
// error, e.g. "2 of 5 tools unavailable: server_disabled, not_found".
func preflightSummary(response *contracts.PreflightResponse) string {
	if response == nil {
		return ""
	}
	unavailable := 0
	seen := make(map[string]bool)
	var reasons []string
	for _, tool := range response.Tools {
		if tool.Status == preflight.StatusReady {
			continue
		}
		unavailable++
		if tool.Reason != "" && !seen[tool.Reason] {
			seen[tool.Reason] = true
			reasons = append(reasons, tool.Reason)
		}
	}
	if unavailable == 0 {
		return ""
	}
	summary := fmt.Sprintf("%d of %d tools unavailable", unavailable, len(response.Tools))
	if len(reasons) > 0 {
		summary += ": " + strings.Join(reasons, ", ")
	}
	return summary
}

// renderPreflight formats one response for the requested output format. It is
// pure (returns the string instead of printing) so every format is unit-tested
// without capturing stdout.
func renderPreflight(outputFormat string, response *contracts.PreflightResponse) (string, error) {
	// Normalize ONCE, before both the formatter lookup and the branch below.
	// NewFormatter is case-insensitive, so `-o JSON` used to select the JSON
	// formatter and then fall into the table branch, emitting a table header
	// followed by JSON-encoded rows.
	format := strings.ToLower(strings.TrimSpace(outputFormat))

	formatter, err := output.NewFormatter(format)
	if err != nil {
		return "", output.NewStructuredError(output.ErrCodeInvalidOutputFormat, err.Error()).
			WithGuidance("Use -o table, -o json, or -o yaml")
	}

	if format == "json" || format == "yaml" {
		// Marshal through the wire DTO's JSON tags so `-o yaml` emits the same
		// key names as `-o json` and the REST payload, rather than yaml's
		// lowercased Go field names.
		payload, convErr := preflightWirePayload(response)
		if convErr != nil {
			return "", convErr
		}
		rendered, fmtErr := formatter.Format(payload)
		if fmtErr != nil {
			return "", fmt.Errorf("failed to format output: %w", fmtErr)
		}
		return rendered + "\n", nil
	}

	headers, rows := preflightRows(response)
	table, fmtErr := formatter.FormatTable(headers, rows)
	if fmtErr != nil {
		return "", fmt.Errorf("failed to format table: %w", fmtErr)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "VERDICT: %s (exit %d)\n", response.Verdict, preflight.ExitCode(preflightExitVerdict(response)))
	fmt.Fprintf(&b, "CHECKED: %s\n", response.CheckedAt.Format(time.RFC3339))
	if response.WaitedMS != nil {
		fmt.Fprintf(&b, "WAITED:  %dms\n", *response.WaitedMS)
	}
	b.WriteString("\n")
	b.WriteString(table)
	return b.String(), nil
}

// preflightWirePayload converts the response to generic JSON values so the
// YAML formatter honours the wire key names.
func preflightWirePayload(response *contracts.PreflightResponse) (map[string]interface{}, error) {
	encoded, err := json.Marshal(response)
	if err != nil {
		return nil, fmt.Errorf("failed to encode preflight response: %w", err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(encoded, &payload); err != nil {
		return nil, fmt.Errorf("failed to decode preflight response: %w", err)
	}
	return payload, nil
}

// preflightRows builds the table view. Detail and remediation are sanitized:
// detail can quote an upstream-controlled server or tool name.
func preflightRows(response *contracts.PreflightResponse) (headers []string, rows [][]string) {
	headers = []string{"ID", "STATUS", "REASON", "RETRYABLE", "ACTION", "DETAIL"}
	rows = make([][]string, 0, len(response.Tools))
	for _, tool := range response.Tools {
		reason := tool.Reason
		retryable := ""
		if tool.Retryable != nil {
			retryable = fmt.Sprintf("%t", *tool.Retryable)
		}
		action := tool.Action
		if reason == "" {
			reason = "-"
		}
		if retryable == "" {
			retryable = "-"
		}
		if action == "" {
			action = "-"
		}
		detail := tool.Detail
		if detail == "" {
			detail = tool.Remediation
		}
		if detail == "" {
			detail = "-"
		}
		rows = append(rows, []string{
			sanitizeName(tool.ID),
			tool.Status,
			reason,
			retryable,
			action,
			sanitizeCell(detail, maxToolDescriptionCell),
		})
	}
	return headers, rows
}
