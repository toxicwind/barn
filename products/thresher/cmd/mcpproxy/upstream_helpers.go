package main

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"go.uber.org/zap"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cli/output"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/cliclient"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
)

// validateTrustModeFlag refuses an unrecognized --trust-mode value up front
// (GH #938). Empty means "inherit the default"; matching is case-sensitive
// because the runtime fails closed to manual on anything else, so silently
// accepting "Scan" would leave the operator believing scanning is on.
func validateTrustModeFlag(mode string) error {
	if config.IsValidTrustMode(mode) {
		return nil
	}
	return fmt.Errorf("invalid --trust-mode %q: must be one of: %s (values are case-sensitive)",
		mode, strings.Join(config.ValidTrustModes(), ", "))
}

// outputError formats and outputs an error based on the current output format.
// For structured formats (json, yaml), it outputs a StructuredError.
// For table format, it outputs a human-readable error message to stderr.
// T023: Updated to extract request_id from APIError for log correlation
func outputError(err error, code string) error {
	outputFormat := ResolveOutputFormat()

	// T023: Extract request_id from APIError if available
	var requestID string
	var apiErr *cliclient.APIError
	if errors.As(err, &apiErr) && apiErr.HasRequestID() {
		requestID = apiErr.RequestID
	}

	// Convert to StructuredError if not already
	var structErr output.StructuredError
	if se, ok := err.(output.StructuredError); ok {
		structErr = se
	} else {
		structErr = output.NewStructuredError(code, err.Error())
	}

	// T023: Add request_id to StructuredError if available
	if requestID != "" {
		structErr = structErr.WithRequestID(requestID)
	}

	// For structured formats, output JSON/YAML error to stdout
	if outputFormat == "json" || outputFormat == "yaml" {
		formatter, fmtErr := GetOutputFormatter()
		if fmtErr != nil {
			// Fallback to plain error if formatter fails
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return err
		}

		result, formatErr := formatter.FormatError(structErr)
		if formatErr != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			return err
		}

		fmt.Println(result)
		return structErr
	}

	// For table format, output human-readable error to stderr
	// T023: Include request ID with log retrieval suggestion if available
	if requestID != "" {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		fmt.Fprintf(os.Stderr, "\nRequest ID: %s\n", requestID)
		fmt.Fprintf(os.Stderr, "Use 'mcpproxy activity list --request-id %s' to find related logs.\n", requestID)
	} else {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
	}
	return err
}

func loadUpstreamConfig() (*config.Config, error) {
	return loadCLIConfig(upstreamConfigPath)
}

func createUpstreamLogger(level string) (*zap.Logger, error) {
	var zapLevel zap.AtomicLevel
	switch level {
	case "trace", "debug":
		zapLevel = zap.NewAtomicLevelAt(zap.DebugLevel)
	case "info":
		zapLevel = zap.NewAtomicLevelAt(zap.InfoLevel)
	case "warn":
		zapLevel = zap.NewAtomicLevelAt(zap.WarnLevel)
	case "error":
		zapLevel = zap.NewAtomicLevelAt(zap.ErrorLevel)
	default:
		zapLevel = zap.NewAtomicLevelAt(zap.WarnLevel)
	}

	cfg := zap.Config{
		Level:            zapLevel,
		Development:      false,
		Encoding:         "console",
		EncoderConfig:    zap.NewDevelopmentEncoderConfig(),
		OutputPaths:      []string{"stderr"},
		ErrorOutputPaths: []string{"stderr"},
	}

	return cfg.Build()
}

// outputSkipNotice prints a human skip notice (for --if-not-exists /
// --if-exists) to stderr and, in machine formats, emits a structured skip
// object on stdout so `-o json` consumers always receive parseable output.
func outputSkipNotice(notice string, payload map[string]interface{}) error {
	fmt.Fprintln(os.Stderr, notice)
	outputFormat := ResolveOutputFormat()
	if outputFormat == "json" || outputFormat == "yaml" {
		formatter, err := GetOutputFormatter()
		if err != nil {
			return err
		}
		formatted, err := formatter.Format(payload)
		if err != nil {
			return err
		}
		fmt.Println(formatted)
	}
	return nil
}
