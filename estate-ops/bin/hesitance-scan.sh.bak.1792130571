#!/usr/bin/env bash
# hesitance-scan.sh — estate hesitance-rot detector (permanent).
#
# The canonical hesitance guard for Chris's fleet (ordered: sovereign
# projects/ops/bin, filename claimed fleet seq 11264). Consolidated 2026-09-20
# from the pack-fix hunt's hesitance-lint: one tool, one home, no duplication.
#
# Scans briefs, docs, cron bodies, and skill docs for designed-in hesitance:
#   "ask Chris", "awaiting approval", "wait for approval", "defer to Chris",
#   "skip long builds", "do not investigate further",
#   "do not retry, do not run anything else",
# and other patterns where the default was surrender instead of action.
#
# Every hit is classified:
#   ROT        — genuine hesitance rot. Fix at the root (rewrite the brief/doc).
#   LEGITIMATE — genuinely needs Chris: money, credentials, irreversible
#                external sends, or "only Chris can do X" stated once, plainly.
#   QUOTE      — historical quote of the old bad brief (scar documentation in
#                SOUL.md/IDENTITY.md/memory), not a live instruction.
#   ANTI       — the line explicitly PROHIBITS the pattern (anti-hesitance
#                doctrine, e.g. "asking Chris is a bug"). Not rot.
#
# Allowlist a single line only, narrowly, with a reason:
#   # hesitance-allow: <reason>
#
# Exit: 0 = no rot (LEGITIMATE/QUOTE/ANTI hits only), 1 = rot found, 2 = usage error.
#
# Usage:
#   hesitance-scan.sh [path ...]        # scan given files/dirs (default: box roots)
#   hesitance-scan.sh --fleet [N]       # also scan last N fleet messages (needs squawk CLI)
#   hesitance-scan.sh --quiet           # only summary + exit code
#
# Hunt catalog: sovereign projects/pack-fix/hesitance-patterns.md
# Standing rule (Chris, 2026-09-20): default is autonomous action —
# "do it, report done; only surface what genuinely needs Chris:
# money, credentials, irreversible external sends."

set -u

QUIET=0
FLEET=0
FLEET_N=20
ALLOW_TAG='hesitance-allow:'

# ---- pattern lists (case-insensitive) ---------------------------------------
# ROT: hesitance baked into an instruction or brief.
ROT_PAT='ask chris|awaiting approval|wait for .*approval|defer to chris|flag for review|flag for chris|skip long builds?|no further investigation|do not investigate|do not retry,? do not run anything else|pending (chris|user) approval|wait for chris|run it by chris|check with chris|escalate to chris|approval before (proceeding|acting|doing)'
# LEGIT: the hit is fine because the line names something only Chris can do.
LEGIT_CTX='vault page|via vault|only (chris|the user) can|money|spend|billing|purchase|top-?up|irreversible|credential rotat|mint|secret|client key|api key|delete (the )?repo|transfer ownership|force-?push|public publish'
# QUOTE: the hit is a historical quote of the old bad brief, not an instruction.
QUOTE_CTX='hypocrisy|hesitance rollback|brief said|my soul claimed|re-?injected|the standard three times|scar'
# ANTI: the line explicitly PROHIBITS the pattern (negation) — anti-hesitance
# doctrine, e.g. "I never ask Chris to do things". Not rot.
ANTI_CTX='never ask chris|no ["'"'"']?ask chris|don.t ask chris|asking chris is a bug|not ask chris|without asking chris'
# Files documenting the scar quote the old brief; hits of the known quote
# fragments inside them are QUOTE, not ROT.
SCAR_FILE_CTX='delegation hypocrisy|hesitance rollback'
SCAR_QUOTE_FRAG='skip long builds|fix what.s fixable'

declare -A scar_file_cache=()

file_is_scar_doc() { # $1 = path; true if file documents the hesitance scar
  local f="$1"
  if [ -z "${scar_file_cache[$f]+x}" ]; then
    if grep -qiE "$SCAR_FILE_CTX" "$f" 2>/dev/null; then
      scar_file_cache[$f]=1
    else
      scar_file_cache[$f]=0
    fi
  fi
  [ "${scar_file_cache[$f]}" -eq 1 ]
}

# Paths never scanned (vendored code, history, toolchains, and the hunt's own
# documentation — the catalog quotes the patterns it documents, which is not
# a live instruction).
EXCLUDE_DIRS=(.git node_modules site-packages venvs vendor vendors archive _archive pack-fix)
EXCLUDE_FILES=('hesitance-scan.sh' 'hesitance-patterns.md' '*~' '*.pyc')
# Note: _archive/ holds superseded bodies as historical evidence, not live
# instructions. The archived swarm-watchdog copy there was rewritten 2026-09-20
# to the fixed act-then-report behavior (enabled: false) so it is
# resurrection-safe; it stays excluded from scans as non-live.

rot_n=0; legit_n=0; quote_n=0; anti_n=0

classify() { # $1 = path, $2 = matched line text
  local f="$1" line="$2"
  if printf '%s' "$line" | grep -qiE "$ANTI_CTX"; then
    printf 'ANTI'
  elif printf '%s' "$line" | grep -qiE "$LEGIT_CTX"; then
    printf 'LEGITIMATE'
  elif printf '%s' "$line" | grep -qiE "$QUOTE_CTX"; then
    printf 'QUOTE'
  elif file_is_scar_doc "$f" && printf '%s' "$line" | grep -qiE "$SCAR_QUOTE_FRAG"; then
    printf 'QUOTE'
  else
    printf 'ROT'
  fi
}

scan_stream() { # reads "path:lineno:text" lines on stdin
  while IFS= read -r hit; do
    local f="${hit%%:*}" rest="${hit#*:}"
    # Allowlisted lines are explicitly exempted.
    case "$hit" in *"$ALLOW_TAG"*) continue ;; esac
    # Never flag the scanner's own pattern catalog (explicit-path safe).
    [[ "$f" == */hesitance-scan.sh || "$f" == "hesitance-scan.sh" ]] && continue
    local text="${rest#*:}"   # strip path:lineno:
    local cls
    cls=$(classify "$f" "$text")
    case "$cls" in
      ROT)        rot_n=$((rot_n+1));   [ "$QUIET" -eq 0 ] && printf 'ROT        %s\n' "$hit" ;;
      LEGITIMATE) legit_n=$((legit_n+1)); [ "$QUIET" -eq 0 ] && printf 'LEGITIMATE %s\n' "$hit" ;;
      QUOTE)      quote_n=$((quote_n+1)); [ "$QUIET" -eq 0 ] && printf 'QUOTE      %s\n' "$hit" ;;
      ANTI)       anti_n=$((anti_n+1));  [ "$QUIET" -eq 0 ] && printf 'ANTI       %s\n' "$hit" ;;
    esac
  done
}

TARGETS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --quiet) QUIET=1; shift ;;
    --fleet) FLEET=1; shift ;;
    -n) FLEET_N="$2"; shift 2 ;;
    --) shift; while [ $# -gt 0 ]; do TARGETS+=("$1"); shift; done ;;
    -*) printf 'unknown flag: %s\n' "$1" >&2; exit 2 ;;
    *) TARGETS+=("$1"); shift ;;
  esac
done

if [ ${#TARGETS[@]} -eq 0 ]; then
  # Default roots per box.
  if [ -d /home/toxic/sovereign ]; then
    TARGETS=(/home/toxic/sovereign/skills /home/toxic/sovereign/projects
             /home/toxic/sovereign/scratch /home/toxic/maximal-sweep)
  elif [ -d /home/hatch/workspace ]; then
    TARGETS=(/home/hatch/workspace/cron.d /home/hatch/workspace/skills
             /home/hatch/workspace/sweeps /home/hatch/workspace/goals
             /home/hatch/workspace/emergent-tasking
             /home/hatch/SOUL.md /home/hatch/AGENTS.md /home/hatch/IDENTITY.md)
  else
    printf 'no scan targets given and no known box roots found\n' >&2; exit 2
  fi
fi

EXISTING=()
for t in "${TARGETS[@]}"; do
  [ -e "$t" ] && EXISTING+=("$t")
done
if [ ${#EXISTING[@]} -eq 0 ]; then
  printf 'no scan targets exist\n' >&2; exit 2
fi

run_scan() { # $1 = name of array with targets; ripgrep preferred, grep fallback
  if command -v rg >/dev/null 2>&1; then
    local -a args=(-n -i -H --hidden --no-heading -e "$ROT_PAT")
    local d
    for d in "${EXCLUDE_DIRS[@]}"; do args+=(-g "!**/$d/**"); done
    local pat
    for pat in "${EXCLUDE_FILES[@]}"; do args+=(-g "!$pat"); done
    rg "${args[@]}" "${EXISTING[@]}" 2>/dev/null
  else
    local -a args=(-rnEi --hidden -e "$ROT_PAT")
    local d
    for d in "${EXCLUDE_DIRS[@]}"; do args+=("--exclude-dir=$d"); done
    local pat
    for pat in "${EXCLUDE_FILES[@]}"; do args+=("--exclude=$pat"); done
    grep "${args[@]}" "${EXISTING[@]}" 2>/dev/null
  fi
}

scan_stream < <(run_scan)

if [ "$FLEET" -eq 1 ]; then
  if command -v squawk >/dev/null 2>&1; then
    while IFS= read -r hit; do
      case "$hit" in *"$ALLOW_TAG"*) continue ;; esac
      text="${hit#*:}"
      cls=$(classify "fleet" "$text")
      case "$cls" in
        ROT)        rot_n=$((rot_n+1));   [ "$QUIET" -eq 0 ] && printf 'ROT        fleet:%s\n' "$hit" ;;
        LEGITIMATE) legit_n=$((legit_n+1)); [ "$QUIET" -eq 0 ] && printf 'LEGITIMATE fleet:%s\n' "$hit" ;;
        QUOTE)      quote_n=$((quote_n+1)); [ "$QUIET" -eq 0 ] && printf 'QUOTE      fleet:%s\n' "$hit" ;;
      esac
    done < <(squawk read fleet --n "$FLEET_N" 2>/dev/null | grep -inE "$ROT_PAT")
  else
    printf 'squawk CLI not found; skipping fleet scan\n' >&2
  fi
fi

[ "$QUIET" -eq 0 ] && printf '\nsummary: %d ROT, %d LEGITIMATE, %d QUOTE, %d ANTI\n' "$rot_n" "$legit_n" "$quote_n" "$anti_n"

[ "$rot_n" -gt 0 ] && exit 1
exit 0
