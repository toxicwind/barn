package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/smart-mcp-proxy/mcpproxy-go/internal/config"
	"github.com/smart-mcp-proxy/mcpproxy-go/internal/socket"
)

func TestUpstreamDaemonDetection_NoDaemon(t *testing.T) {
	clearDaemonEnv(t)

	// Test with non-existent directory
	if _, ok := newDaemonClient(&config.Config{DataDir: "/tmp/nonexistent-mcpproxy-test-dir-12345"}, nil); ok {
		t.Error("newDaemonClient should report no daemon for non-existent directory")
	}

	// Test with existing directory but no socket
	tmpDir := t.TempDir()
	if _, ok := newDaemonClient(&config.Config{DataDir: tmpDir}, nil); ok {
		t.Error("newDaemonClient should report no daemon when socket doesn't exist")
	}
}

func TestGetLogDirectory(t *testing.T) {
	// Test helper function for getting log directory
	// This is tested indirectly through runUpstreamLogsFromFile
	// Here we document the expected behavior

	t.Run("empty log dir uses default", func(t *testing.T) {
		// When config.Logging.LogDir is empty, should use logs.GetLogDir()
		// This is tested in the actual command execution
	})

	t.Run("custom log dir used when set", func(t *testing.T) {
		// When config.Logging.LogDir is set, should use that path
		// This is tested in the actual command execution
	})
}

func TestSocketDetection(t *testing.T) {
	// Create temp directory
	tmpDir := t.TempDir()

	// Test socket path detection
	socketPath := socket.DetectSocketPath(tmpDir)

	// Should return a path
	if socketPath == "" {
		t.Error("DetectSocketPath should return non-empty path")
	}

	// Socket should not exist yet
	if socket.IsSocketAvailable(socketPath) {
		t.Error("Socket should not be available in empty temp dir")
	}
}

func TestLoadUpstreamConfig(t *testing.T) {
	// Save original flag value
	oldConfigPath := upstreamConfigPath
	defer func() { upstreamConfigPath = oldConfigPath }()

	t.Run("default config path", func(t *testing.T) {
		upstreamConfigPath = ""
		// This will attempt to load default config
		// We just verify it doesn't panic
		_, err := loadUpstreamConfig()
		// Error is expected if no config exists, which is fine
		_ = err
	})

	t.Run("custom config path", func(t *testing.T) {
		// Create a temporary config file
		tmpDir := t.TempDir()
		configPath := filepath.Join(tmpDir, "test_config.json")

		// Write minimal valid config
		configJSON := `{
			"listen": "127.0.0.1:8080",
			"data_dir": "~/.mcpproxy",
			"mcpServers": []
		}`
		err := os.WriteFile(configPath, []byte(configJSON), 0644)
		if err != nil {
			t.Fatalf("Failed to write test config: %v", err)
		}

		upstreamConfigPath = configPath
		cfg, err := loadUpstreamConfig()
		if err != nil {
			t.Errorf("Failed to load custom config: %v", err)
		}
		if cfg != nil && cfg.Listen != "127.0.0.1:8080" {
			t.Errorf("Expected listen address '127.0.0.1:8080', got %s", cfg.Listen)
		}
	})
}

func TestCreateUpstreamLogger(t *testing.T) {
	tests := []struct {
		name     string
		logLevel string
		wantErr  bool
	}{
		{
			name:     "trace level",
			logLevel: "trace",
			wantErr:  false,
		},
		{
			name:     "debug level",
			logLevel: "debug",
			wantErr:  false,
		},
		{
			name:     "info level",
			logLevel: "info",
			wantErr:  false,
		},
		{
			name:     "warn level",
			logLevel: "warn",
			wantErr:  false,
		},
		{
			name:     "error level",
			logLevel: "error",
			wantErr:  false,
		},
		{
			name:     "invalid level defaults to warn",
			logLevel: "invalid",
			wantErr:  false,
		},
		{
			name:     "empty level defaults to warn",
			logLevel: "",
			wantErr:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			logger, err := createUpstreamLogger(tt.logLevel)
			if (err != nil) != tt.wantErr {
				t.Errorf("createUpstreamLogger() error = %v, wantErr %v", err, tt.wantErr)
				return
			}
			if logger == nil && !tt.wantErr {
				t.Error("createUpstreamLogger() returned nil logger")
			}
		})
	}
}

func TestRunUpstreamListFromConfig(t *testing.T) {
	// Create a minimal config
	cfg := &struct {
		Servers []struct {
			Name     string `json:"name"`
			Enabled  bool   `json:"enabled"`
			Protocol string `json:"protocol"`
		} `json:"mcpServers"`
	}{}

	// Add test servers
	cfg.Servers = append(cfg.Servers, struct {
		Name     string `json:"name"`
		Enabled  bool   `json:"enabled"`
		Protocol string `json:"protocol"`
	}{
		Name:     "test-server",
		Enabled:  true,
		Protocol: "stdio",
	})

	// This function is tested through runUpstreamList integration
	// Here we document expected behavior
	t.Run("converts config to output format", func(t *testing.T) {
		// Should create map with:
		// - name, enabled, protocol from config
		// - connected: false (no daemon)
		// - tool_count: 0 (no daemon)
		// - status: "unknown (daemon not running)"
	})
}

// ============================================================================
// T012: Server Name Validation Tests
// ============================================================================

func TestValidateServerName(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		wantErr   bool
		errSubstr string
	}{
		// Valid names
		{"simple lowercase", "myserver", false, ""},
		{"with hyphens", "my-server", false, ""},
		{"with underscores", "my_server", false, ""},
		{"alphanumeric", "server123", false, ""},
		{"mixed case", "MyServer", false, ""},
		{"all chars", "My-Server_123", false, ""},
		{"single char", "a", false, ""},
		{"max length 64", strings.Repeat("a", 64), false, ""},

		// Invalid names
		{"empty", "", true, "cannot be empty"},
		{"too long", strings.Repeat("a", 65), true, "too long"},
		{"with spaces", "my server", true, "invalid character"},
		{"with dots", "my.server", true, "invalid character"},
		{"with slash", "my/server", true, "invalid character"},
		{"with colon", "my:server", true, "invalid character"},
		{"starts with special", "@myserver", true, "invalid character"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateServerName(tt.input)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateServerName(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
			if tt.wantErr && tt.errSubstr != "" && err != nil {
				if !strings.Contains(err.Error(), tt.errSubstr) {
					t.Errorf("validateServerName(%q) error = %q, want substr %q", tt.input, err.Error(), tt.errSubstr)
				}
			}
		})
	}
}

// jsonEscapePath escapes a path for embedding in JSON strings.
// On Windows, backslashes must be escaped as \\, or use forward slashes.
func jsonEscapePath(p string) string {
	return filepath.ToSlash(p)
}
