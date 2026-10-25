#!/usr/bin/env bun
/**
 * heredoc-fix — autonomous command/heredoc fixer shim.
 *
 * Reusable for the recurring failure class where a command chain carries complex
 * nesting that the exec frame mangles (backquotes, `<<'PY'` heredocs, `$()` and
 * `(...)` inside single-quoted ssh/bash -c, `2>&1`, etc.). It:
 *   1. Reads the intended command from argv (with or without explicit quote layer)
 *      or from stdin (heredoc body).
 *   2. Rebuilds a *single, de-nested* script: collapses escaped outer quotes,
 *      detects a stray unbalanced `'`/`"` from the outer frame, and writes the
 *      canonical bytes to a temp file.
 *   3. Runs it via a clean shell (bash -c with a CSI-free env) and streams output.
 * The goal is to turn "this command broke on quoting" into a deterministic, idempotent
 * run you can retry as-is.
 *
 * Usage:
 *   heredoc-fix --script 'echo "$1"; ssh host '"'"'cmd'"'"'' [args...]
 *   heredoc-fix --stdin-file /tmp/cmd.txt          # run a heredoc body from a file
 *   printf '%s' "cmd" | heredoc-fix --pipe          # heredoc from stdin
 *   heredoc-fix --quote -- asdf "ls -la $(pwd)"     # re-quote argv into a single string
 *
 * Exit: 0 = ran clean; 2 = fixed+ran clean (a fix was applied); 3 = could not de-nest.
 */
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

type Result = { code: number; fixed: boolean };
const Ok = (fixed: boolean): Result => ({ code: fixed ? 2 : 0, fixed });

function unquoteFirstLayer(s: string): string {
	// If the whole arg is wrapped in a single pair of ' or ", strip it; then undo
	// the shell-escaped \" and \' that an outer frame introduced.
	let out = s;
	if (
		(out.startsWith("'") && out.endsWith("'") && out.length >= 2) ||
		(out.startsWith('"') && out.endsWith('"') && out.length >= 2)
	) {
		out = out.slice(1, -1);
	}
	// Collapse an odd number of trailing backslashes before a quote back to nothing.
	out = out.replace(/\\(['"])/g, "$1");
	return out;
}

function detectUnbalanced(s: string): boolean {
	const stripped = s.replace(/\\[\\'"`]/g, "  "); // ignore escaped quotes
	let depth = 0;
	let quote: "'" | '"' | null = null;
	for (const ch of stripped) {
		if (quote) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		if (ch === "(" || ch === "[" || ch === "{") depth++;
		if (ch === ")" || ch === "]" || ch === "}") depth--;
	}
	return depth !== 0 || quote !== null;
}

function heredocsIn(s: string): boolean {
	return /<<[-]?[A-Za-z_'"\w]+/.test(s);
}

function fix(args: string[]): Result {
	const [flag, ...rest] = args;
	let script: string;

	if (flag === "--pipe") {
		script = require("node:fs").readFileSync(0, "utf8");
	} else if (flag === "--stdin-file") {
		const f = rest[0];
		if (!f) return { code: 3, fixed: false };
		script = require("node:fs").readFileSync(f, "utf8");
	} else if (flag === "--script") {
		// `--script` takes ONE argument; any following args are runtime args
		script = rest[0] ?? "";
		if (rest.length > 1) script += " " + rest.slice(1).map((a) => JSON.stringify(a)).join(" ");
	} else if (flagsIndex(args).includes("--quote")) {
		// Re-quote argv: join shell-escaped
		const idx = args.indexOf("--quote");
		const parts = args.slice(idx + 1).join(" ");
		script = parts;
	} else {
		script = args.join(" ");
	}

	const fixed = heredocsIn(script) || detectUnbalanced(script) || script.includes("\\'") || script.includes('\\"');
	// Normalize: strip an unbalanced trailing layer of single quotes many wrappers add.
	if (detectUnbalanced(script)) {
		script = unquoteFirstLayer(script);
	}

	const dir = mkdtempSync(join(tmpdir(), "heredoc-fix-"));
	const file = join(dir, "entry.sh");
	writeFileSync(file, script, "utf8");
	try {
		// Clean, CSI-free environment; bash so heredocs + $() work as authored.
		const r = spawnSync("/usr/bin/env", ["-i", "HOME=" + (process.env.HOME ?? ""),
			"PATH=/usr/local/bin:/usr/bin:/bin:/home/toxic/.bun/bin", "TERM=xterm",
			"bash", "--noprofile", "--norc", file], { stdio: "inherit" });
		return { code: r.status ?? 1, fixed };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function flagsIndex(args: string[]): string[] {
	return args.filter((a) => a.startsWith("--"));
}

const code = fix(process.argv.slice(2)).code;
process.exit(code);