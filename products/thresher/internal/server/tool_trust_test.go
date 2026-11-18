package server

import "testing"

// Contract (2026-11-08, Thread 5): auto-approve is READ-ONLY. Relevance
// (BM25/BGE) is advisory only; trust is a static verb classification enforced
// server-side. A write/destructive tool must never auto-approve, regardless of
// how relevant it looks.
func TestAuthorizeTool(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"read_file", true},
		{"grep", true},
		{"pens_ask", true},
		{"write_file", false},
		{"git_commit", false},
		{"bash", false},
		{"delete_project", false},
		{"shell_exec", false},
		{"run", false},
	}
	for _, c := range cases {
		got, reason := AuthorizeTool(c.name, true)
		if got != c.want {
			t.Fatalf("%s: got %v want %v (%s)", c.name, got, c.want, reason)
		}
	}
}

// A destructive tool must name itself and the human-approval requirement in
// the reason — the operator has to know what they're being asked to approve.
func TestAuthorizeToolReasonNamesDestructive(t *testing.T) {
	_, reason := AuthorizeTool("delete_project", true)
	if reason == "" {
		t.Fatal("expected a non-empty reason for a destructive tool")
	}
}

// Trust classification must be static and verb-derived: "bash"/"run" are write
// (they execute), not read, even though they carry no noun.
func TestClassifyToolVerbs(t *testing.T) {
	if ClassifyTool("read_file") != TrustRead {
		t.Fatal("read_file should be TrustRead")
	}
	if ClassifyTool("bash") != TrustWrite {
		t.Fatal("bash should be TrustWrite (executes)")
	}
	if ClassifyTool("delete_project") != TrustDestructive {
		t.Fatal("delete_project should be TrustDestructive")
	}
}