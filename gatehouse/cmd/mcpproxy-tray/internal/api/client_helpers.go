package api

import (
	"crypto/tls"
	"crypto/x509"
	"os"
	"path/filepath"
	"sort"

	"go.uber.org/zap"
)

// Helper functions to safely extract values from maps
func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func getBool(m map[string]interface{}, key string) bool {
	if v, ok := m[key].(bool); ok {
		return v
	}
	return false
}

func getInt(m map[string]interface{}, key string) int {
	if v, ok := m[key].(float64); ok {
		return int(v)
	}
	return 0
}

func getFloat64(m map[string]interface{}, key string) float64 {
	if v, ok := m[key].(float64); ok {
		return v
	}
	return 0.0
}

func keys(m map[string]interface{}) []string {
	if len(m) == 0 {
		return nil
	}

	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func maskForLog(key string) string {
	if len(key) <= 8 {
		return "****"
	}
	return key[:4] + "****" + key[len(key)-4:]
}

// createTLSConfig creates a TLS config that trusts the local mcpproxy CA
func createTLSConfig(logger *zap.SugaredLogger) *tls.Config {
	// Start with system cert pool
	rootCAs, err := x509.SystemCertPool()
	if err != nil {
		if logger != nil {
			logger.Warn("Failed to load system cert pool, creating empty pool", "error", err)
		}
		rootCAs = x509.NewCertPool()
	}

	// Try to load the local mcpproxy CA certificate
	caPath := getLocalCAPath()
	if caPath != "" {
		if caCert, err := os.ReadFile(caPath); err == nil {
			if rootCAs.AppendCertsFromPEM(caCert) {
				if logger != nil {
					logger.Debug("Successfully loaded local mcpproxy CA certificate", "ca_path", caPath)
				}
			} else {
				if logger != nil {
					logger.Warn("Failed to parse local mcpproxy CA certificate", "ca_path", caPath)
				}
			}
		} else {
			if logger != nil {
				logger.Debug("Local mcpproxy CA certificate not found, will use system certs only", "ca_path", caPath)
			}
		}
	}

	return &tls.Config{
		RootCAs:            rootCAs,
		InsecureSkipVerify: false, // Keep verification enabled for security
		MinVersion:         tls.VersionTLS12,
	}
}

// getLocalCAPath returns the path to the local mcpproxy CA certificate
func getLocalCAPath() string {
	// Check environment variable first
	if customCertsDir := os.Getenv("MCPPROXY_CERTS_DIR"); customCertsDir != "" {
		return filepath.Join(customCertsDir, "ca.pem")
	}

	// Use default location
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	return filepath.Join(homeDir, ".mcpproxy", "certs", "ca.pem")
}
