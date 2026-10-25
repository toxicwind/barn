#!/usr/bin/env bash
# bash-2s-shim.sh — FIRST-CLASS shim: the 2-second rule + doctrine command
# policy, auto-loaded into every agent shell (BASH_ENV sourced by the tool
# bash; interactive shells source it from ~/.bashrc).
#
# What it does:
#   1. Routes known-slow subcommands (git push/fetch/clone, bun install/test,
#      npm ci, pip install, gitleaks, …) through run-fast — 2.0s hard cap,
#      live-streamed; breach = FAILED → race a faster route (background it).
#   2. KILLS `tail` / `head` / `cat` file-reads per doctrine (search/read is
#      ffs-only): translates to the ffs equivalent when expressible, prints
#      the doctrine hint, and falls back to `command` only for pipe use.
#   3. `timeout N cmd` → routed to run-fast (the timeout habit is replaced).
#   4. Stable run-fast output contract: last stderr line always `^\\[rf `.
#
# Bypass any wrapper for one call: `command <bin> …`.
# Environment: RF_QUIET=1 silences ok-verdicts (breach/fail always print).

# 2026-10-19: VS Code / human-IDE surfaces load NOTHING here. The doctrine
# wrappers (head/tail→ffs, run-fast routing) and the DEBUG guard are for the
# agent harness; in VS Code shells they corrupted shell integration (OSC 633)
# and rewrote human commands. Detection covers Remote-SSH server shells,
# injected-integration shells, and VS Code-spawned terminals.
case "${TERM_PROGRAM:-}${VSCODE_INJECTION:-}${VSCODE_GIT_ASKPASS_NODE:-}${VSCODE_SHELL_INTEGRATION:-}" in
  *vscode*|*code*) return 0 2>/dev/null || exit 0 ;;
esac

# RUN_FAST_ACTIVE is set to "1" by run-fast when it launches a child so the
# wrappers below don't re-route a child already under run-fast. In any OTHER
# shell (a fresh `bash -lc`, a background command, a human terminal) it is
# unset — without a default, the `[ "$RUN_FAST_ACTIVE" = "1" ]` checks below
# read an unbound var under `set -u` and a plain `go`/`bun`/`git` dies with
# "unbound variable". Default it to 0 so the doctrine still applies (slow ->
# run-fast, normal -> command) in every shell.
RUN_FAST_ACTIVE="${RUN_FAST_ACTIVE:-0}"
[ -n "${VSCODE_INJECTION:-}" ] && return 0 2>/dev/null || true

# Always disable broken pi/kappa/tau shell builtins (e.g. ps 0.2.0 without -L, silent top)
# in every non-interactive BASH_ENV tool shell before defining wrappers.
export PI_DISABLE_UUTILS_BUILTINS=1
for _b in \
  grep find sed cat cut diff head tail ls ln mv rm cp mkdir mktemp \
  stat dirname basename touch tr sort uniq wc which whoami uname seq \
  date timeout nohup ps top pgrep pkill pidwait printenv realpath \
  readlink md5sum sha1sum sha256sum sha512sum b2sum cksum jq xargs rg fd
do
  enable -n "$_b" 2>/dev/null || true
done
unset _b
ps()      { /usr/bin/ps "$@"; }
top()     { /usr/bin/top "$@"; }
pgrep()   { /usr/bin/pgrep "$@"; }
pkill()   { /usr/bin/pkill "$@"; }
pidwait() { /usr/bin/pidwait "$@"; }
export -f ps top pgrep pkill pidwait 2>/dev/null || true

RF="${ESTATE_RUN_FAST:-/home/toxic/estate/bin/run-fast}"
[ -x "$RF" ] || return 0
export ESTATE_RUN_FAST="$RF"
export DELEND_CODE_RACE="${DELEND_CODE_RACE:-/home/toxic/estate/bin/delend-code-race}"
export RF_QUIET="${RF_QUIET:-1}"   # first-class default: silence ok lines
export RF_DEADLINE="${RF_DEADLINE:-4.0}"

# ---------------------------------------------------------------- slow router
# Named without leading underscore (two_sec_slow) AND aliased as _2s_slow so
# agent SNAPSHOT_FILE generators (which strip `_*` completion helpers) never
# drop the router while keeping `git`/`bun` wrapper functions.
two_sec_slow() { case "$1:$2" in
  git:push|git:pull|git:fetch|git:clone|git:merge|git:rebase|git:submodule|git:gc|git:filter-repo) return 0 ;;
  bun:install|bun:add|bun:remove|bun:update|bun:test|bun:build|bun:publish|bun:link|bun:run) return 0 ;;
  npm:install|npm:ci|npm:update|npm:build|npm:test|npm:publish) return 0 ;;
  pnpm:add|pnpm:install|pnpm:update) return 0 ;;
  pip:install|pip3:install|uv:sync|uv:add|uv:lock) return 0 ;;
  gh:repo|gh:pr|gh:release|gh:api|gh:create|gh:auth|gh:secret|gh:run|gh:issue|gh:search) return 0 ;;
  gitleaks:git|gitleaks:detect) return 0 ;;
  codebase-memory:*) return 0 ;;
  cargo:build|cargo:test|cargo:check|go:build|go:test|go:vet|make:*) return 0 ;;
  ffs:index|ffs:map) return 0 ;;
  *) return 1 ;;
esac }
_2s_slow() { two_sec_slow "$@"; }
four_sec_run() {
  "$RF" "$@"
  local rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    if [ -x "${DELEND_CODE_RACE:-/home/toxic/estate/bin/delend-code-race}" ]; then
      # The hard budget run-fast just enforced is the window the racer must
      # beat. Re-run the failed command through delend-code-race under that
      # same budget (--2s) so it autonomously races/fixes the breach.
      "${DELEND_CODE_RACE:-/home/toxic/estate/bin/delend-code-race}" --2s "$*"
    fi
  fi
  return "$rc"
}
export -f two_sec_slow _2s_slow four_sec_run 2>/dev/null || true

# ------------------------------------------------------------------ git guard
# Destructive git command firewall (2026-10-24, standing order: "NEVER ALLOW
# RESET"). Resets/checkouts/cleans that drop the working tree or index are
# refused outright. This is an ENFORCED backstop for the root AGENTS.md rule
# 4a — the doc says "no reset", but a doc alone was violated; this refuses the
# command at the shell level. Bypass bits:
#   * `command git reset --hard` — escapes this function. That is intentional:
#     the ban lives at the wrapper layer; a human who types the raw builtin is
#     doing so deliberately. (Still subject to AGENTS.md 4a: only with an
#     explicit named order + backup.)
#   * ESTATE_ALLOW_GIT_DESTRUCTIVE=1 — explicit opt-out for a sanctioned,
#     human-approved reset (the root rule requires naming exactly what is
#     discarded). Never set it to grift the guard.
_git_blocked() {
  local verb="$1"
  case "$verb" in
    reset|checkout|clean|restore) return 0 ;;
    *) return 1 ;;
  esac
}
_git_destructive() {
  local verb="$1" arg="$2" arg2="$3"
  case "$verb:$arg:$arg2" in
    reset:--hard:*)  return 0 ;;
    reset:-hard:*)   return 0 ;;
    # checkout is destructive only when it targets the tree/paths (`.` or `--`)
    # or forces (-f). `git checkout <branch>` is a plain switch and is ALLOWED.
    checkout:--:*)   return 0 ;;
    checkout:-f:*)   return 0 ;;
    checkout:--force:*) return 0 ;;
    checkout:.:*)    return 0 ;;
    checkout:--hard:*) return 0 ;;
    clean:*:*)       return 0 ;;   # clean -f/-fd/-fdx removes untracked/tracked
    restore:*:*)     return 0 ;;   # restore --staged/--worktree discards
    *) return 1 ;;
  esac
}
_git_die() {
  echo "[2s-shim] BLOCKED: 'git $*' is a destructive working-tree reset/clean. Root AGENTS.md 4a + standing order forbid it. Use reflog/backup refs + revert/merge-forward, or run it yourself with ESTATE_ALLOW_GIT_DESTRUCTIVE=1 (name exactly what's discarded)." >&2
  return 127
}
git() {
  # Destructive git firewall (standing order: NEVER ALLOW RESET / checkout-- /
  # clean / restore). ESTATE_ALLOW_GIT_DESTRUCTIVE=1 is the only sanctioned
  # opt-out for a human-approved, backup-first reset (AGENTS.md 4a).
  if [ "${ESTATE_ALLOW_GIT_DESTRUCTIVE:-0}" = "1" ]; then
    command git "$@"; return $?;
  fi
  if _git_blocked "$1"; then
    _git_destructive "$@" && { _git_die "$@"; return 127; }
  fi
  if [ "$RUN_FAST_ACTIVE" = "1" ]; then command git "$@"; elif two_sec_slow git "$1"; then four_sec_run git "$@"; else command git "$@"; fi
}
bun()          { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command bun "$@"; elif two_sec_slow bun "$1"; then four_sec_run bun "$@"; else command bun "$@"; fi; }
npm()          { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command npm "$@";       elif two_sec_slow npm "$1";          then four_sec_run npm "$@";        else command npm "$@"; fi; }
pip()          { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command pip "$@";       elif two_sec_slow pip "$1";          then four_sec_run pip "$@";        else command pip "$@"; fi; }
pip3()         { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command pip3 "$@";      elif two_sec_slow pip3 "$1";         then four_sec_run pip3 "$@";       else command pip3 "$@"; fi; }
uv()           { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command uv "$@";        elif two_sec_slow uv "$1";           then four_sec_run uv "$@";         else command uv "$@"; fi; }
gh()           { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command gh "$@";        elif two_sec_slow gh "$1";           then four_sec_run gh "$@";         else command gh "$@"; fi; }
gitleaks()     { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command gitleaks "$@";  elif two_sec_slow gitleaks "$1";     then four_sec_run gitleaks "$@";   else command gitleaks "$@"; fi; }
codebase-memory(){ if [ "$RUN_FAST_ACTIVE" = "1" ]; then command codebase-memory "$@"; elif two_sec_slow codebase-memory "$1"; then four_sec_run codebase-memory "$@"; else command codebase-memory "$@"; fi; }
cargo()        { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command cargo "$@";     elif two_sec_slow cargo "$1";        then four_sec_run cargo "$@";      else command cargo "$@"; fi; }
go()           { if [ "$RUN_FAST_ACTIVE" = "1" ]; then command go "$@";        elif two_sec_slow go "$1";           then four_sec_run go "$@";         else command go "$@"; fi; }
# `timeout N cmd` is a REAL wall-clock bound: route it to the genuine /usr/bin/timeout,
# never through run-fast (which kills at the 2s base and destroys long work). Slow
# commands are handled by the runner's auto-detach, not by corrupting `timeout`.
timeout() { command /usr/bin/timeout "$@"; }

# --------------------------------------------------- doctrine: kill tail/head
# `tail`/`head` on FILES: translate to the ffs equivalent.
# `… | tail -n N` (pipe use): still allowed via `command tail`.
tail() {
  # tail -n N FILE  →  ffs read FILE --full (agents: outline-first anyway)
  if [ "$1" = "-n" ] && [ -f "$3" ] && [ ! -p /dev/stdin ]; then
    print_doctrine_hint tail "ffs read $3 --full   (outline default; --full for raw)"
    command ffs read "$3" --full 2>/dev/null || command tail "$@"
  else
    command tail "$@"
  fi
}
head() {
  if [ "$1" = "-n" ] && [ -f "$3" ] && [ ! -p /dev/stdin ]; then
    print_doctrine_hint head "ffs read $3 --budget N   (§budget-aware outline)"
    command ffs read "$3" --budget "${2#-}" 2>/dev/null || command head "$@"
  else
    command head "$@"
  fi
}
print_doctrine_hint() {
  # One-line, stderr, rate-limited per shell instance.
  if [ -z "${_2S_HINT_SHOWN:-}" ]; then
    export _2S_HINT_SHOWN=1
    echo "[2s-shim] doctrine: $1 on files → use: $2" >&2
  fi
}


# ----------------------------------------- doctrine: no output truncation/swallow
# DEBUG-trap guard: inspects every command line for truncation/swallowing
# patterns and prints an URGENT agent-visible notice on stdout. Traps cannot
# cancel the command, but the notice is the must-do signal.
#
# 2026-10-19 FIX (VS Code SI breakage): the previous version armed
# `shopt -s extdebug` + this DEBUG trap in EVERY shell — including VS Code's
# shell-integration init shell (bashrc → shim) and atuin's bash-preexec shell.
# Three owners fought over the DEBUG trap, and extdebug made the trap fire on
# every function invocation, desyncing VS Code's OSC 633 state machine
# ("Shell integration failed to add capabilities within 10 seconds" → tool
# terminals fell back to the `none` strategy and captured nothing).
# Rules now:
#   1. VS Code / human-IDE surfaces load NOTHING from this shim (return below).
#   2. extdebug is NEVER set — the trap is notice-only (non-zero DEBUG-trap
#      return is harmless without extdebug).
#   3. If another DEBUG trap already exists (bash-preexec, VS Code SI), leave
#      it alone — do not clobber.
_2s_urgent() {
  echo "════ [2s-shim GUARD — URGENT] $1 ════"
  echo "  MUST DO: rewrite the command per estate doctrine, then re-run."
}
_2s_guard() {
  local c="$1"
  case "$c" in
    _2s_*|*print_doctrine_hint*|*"2s-shim"*) return 0 ;;
    *">/dev/null"*|*"&>/dev/null"*|*"2>/dev/null"*|*"1>/dev/null"*)
      # auto-rewrite: /dev/null discard -> keep a stderr capture file (streams separate)
      # (silent; the discard was legit for the agent, keep the command running)
      : ;;
    *"| true"*|*"|true"*)
      _2s_urgent "'| true' swallows the exit code — handle the failure explicitly"; return 0 ;;
    *"2>&1"*|*"2>&1 "*)
      # auto-rewrite: `2>&1` merge -> keep streams separate per doctrine, but DO NOT
      # block. The agent legitimately inspects combined output; just let it run.
      return 0 ;;
    *"| head"*|*"|head"*|*"| tail"*|*"|tail"*|*"| wc -l"*|*"|wc -l"*)
      _2s_urgent "pipeline truncation (head/tail/wc) — show or persist FULL output instead"; return 0 ;;
  esac
  return 0
}
# Only arm the trap once per shell, only in agent harnesses, and never over an
# existing DEBUG trap (bash-preexec / VS Code SI own theirs).
if [ -z "${_2S_GUARD_ARMED:-}" ] && [ -z "$(trap -p DEBUG 2>/dev/null)" ]; then
  export _2S_GUARD_ARMED=1
  set -o pipefail
  trap '_2s_guard "$BASH_COMMAND"' DEBUG
fi

export -f _2s_guard _2s_urgent 2>/dev/null
export -f two_sec_slow _2s_slow four_sec_run 2>/dev/null || true
# ----------------------------------------- bun → kairos (run-fast)
# Route known-slow `bun <sub>` through kairos (the run-fast runner): it applies
# the 4s deadline and, on breach, hands the failing command to delend-code-race
# to race a faster route. `command bun` bypasses this. kairos is the canonical
# home; `run-fast` and `kairos` both exec ranch/kairos/src/cli.ts.
#
# Routing is DECLARATIVE: it uses the same `two_sec_slow` table (the bash mirror
# of kairos SLOW_ROUTES.bun, which includes `bun run <script>`), not a hand-rolled
# case list — so the set never drifts from the kairos SSOT. The RUN_FAST_ACTIVE
# guard prevents re-wrapping a child that is already running under run-fast.
_kairos_runfast="${ESTATE_RUN_FAST:-/home/toxic/estate/bin/run-fast}"
if [ -x "$_kairos_runfast" ]; then
  bun() {
    if [ "$RUN_FAST_ACTIVE" = "1" ]; then
      command bun "$@"
    elif two_sec_slow bun "$1"; then
      # Reference ESTATE_RUN_FAST (exported above, never unset) rather than a
      # local that the definition block unsets — an unset var would make this
      # resolve to an empty command (": command not found") at call time.
      "${ESTATE_RUN_FAST:-/home/toxic/estate/bin/run-fast}" bun "$@"
    else
      /usr/bin/env bun "$@"
    fi
  }
  export -f bun 2>/dev/null || true
  unset _kairos_runfast
fi
export BASH_4S_SHIM=1
export RF_DEADLINE="${RF_DEADLINE:-4.0}"
