package server

// TrustLevel represents the static trust classification for an MCP tool.
type TrustLevel int

const (
	TrustRead       TrustLevel = iota // Requires no special approval beyond read permissions.
	TrustWrite                        // Requires explicit human approval.
	TrustDestructive                  // Requires explicit human approval; typically irreversible.
)

// leadingVerbs contains the set of leading verbs that map to specific trust levels.
var destructiveVerbs = map[string]bool{
	"delete": true, "remove": true, "drop": true, "revoke": true, "destroy": true,
	"purge": true, "reset": true, "clear": true, "kill": true, "wipe": true,
	"truncate": true, "force": true, "ban": true, "block": true,
}

var writeVerbs = map[string]bool{
	"create": true, "update": true, "modify": true, "add": true, "set": true,
	"send": true, "edit": true, "change": true, "write": true, "post": true,
	"put": true, "patch": true, "insert": true, "upload": true, "submit": true,
	"assign": true, "configure": true, "enable": true, "register": true,
	"publish": true, "move": true, "copy": true, "rename": true, "merge": true,
	"exec": true, "spawn": true, "run": true, "commit": true, "push": true,
	"bash": true, "shell": true, "sh": true,
}

// classifyTrust returns the TrustLevel based on the verbs in the tool name.
// It scans EVERY alpha token (not just the leading one): "git_commit" carries
// the action "commit" -> TrustWrite even though its leading token is the
// command namespace "git". Destructive wins over write; write wins over read.
func classifyTrust(name string) TrustLevel {
	level := TrustRead
	for _, token := range nameTokens(name) {
		if destructiveVerbs[token] {
			return TrustDestructive
		}
		if writeVerbs[token] {
			level = TrustWrite
		}
	}
	return level
}

// nameTokens splits a tool name into its alpha-only words (snake_case,
// camelCase, hyphen, or bare words). Non-alpha characters are boundaries.
// Named nameTokens (not tokens) to avoid shadowing the imported tokens package.
func nameTokens(name string) []string {
	var out []string
	var cur []rune
	for _, r := range name {
		if isAlpha(r) {
			cur = append(cur, r)
		} else if len(cur) > 0 {
			out = append(out, string(cur))
			cur = nil
		}
	}
	if len(cur) > 0 {
		out = append(out, string(cur))
	}
	return out
}

// ClassifyTool derives the trust level for a given tool name.
// This is a static classification based on the leading verb.
func ClassifyTool(name string) TrustLevel {
	return classifyTrust(name)
}

// AuthorizeTool checks if a tool can be executed under the current auto-approval policy.
// It returns allowed=true only if the tool is TrustRead AND autoApproveRead is true.
// For Write and Destructive tools, it returns allowed=false with a reason requiring
// explicit human approval. Relevance (BM25/BGE) is advisory only — trust is static.
func AuthorizeTool(name string, autoApproveRead bool) (allowed bool, reason string) {
	level := classifyTrust(name)

	switch level {
	case TrustRead:
		if autoApproveRead {
			return true, "read-only auto-approved"
		}
		return false, "read tool but auto-approve disabled"
	case TrustWrite:
		return false, "tool \"" + name + "\" is a WRITE operation — explicit human approval required (relevance is not trust)"
	case TrustDestructive:
		return false, "tool \"" + name + "\" is DESTRUCTIVE — explicit human approval required (relevance is not trust)"
	default:
		return false, "unknown trust level for tool: " + name
	}
}

// isAlpha returns true if the rune is a letter.
func isAlpha(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
}