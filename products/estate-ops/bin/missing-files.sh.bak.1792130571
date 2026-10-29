#!/usr/bin/env bash
# missing-files.sh — find files the system REFERENCES but that don't exist.
#
# Scans, in order:
#   1. systemd units (system + user): ExecStart/ExecStop/ExecReload/ExecCondition/
#      EnvironmentFile/WorkingDirectory/ReadWritePaths
#   2. live configs: herd.yaml, pitchfork.toml, ports.env, keypools.yaml,
#      model_constraints.yaml, llama-swap.yaml
#   3. docs (*.md) under /home/toxic/sovereign: /home/toxic/... paths ending in
#      .sh .py .toml .yaml .yml .service .timer .env .json (skips JSONL-substring
#      artifacts, prose fragments, and example patterns)
#
# For each referenced path that does not exist, prints:
#   MISSING <path>
#     referenced-by <file>:<line>
#     line: <the referencing line, trimmed>
#
# Usage: missing-files.sh [--quiet] [--docs] [--units] [--configs]
#   --quiet    print only MISSING blocks (no progress chatter)
#   --docs     scan docs only; --units units only; --configs configs only
# Exit 0 = nothing missing, 1 = one or more missing references.
# Part of sovereign/projects/ops/bin/ (toxicwind/sovereign-projects).
set -u
QUIET=0; DO_UNITS=1; DO_CONFIGS=1; DO_DOCS=1
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=1 ;;
    --units) DO_UNITS=1; DO_CONFIGS=0; DO_DOCS=0 ;;
    --configs) DO_UNITS=0; DO_CONFIGS=1; DO_DOCS=0 ;;
    --docs) DO_UNITS=0; DO_CONFIGS=0; DO_DOCS=1 ;;
  esac
done

log() { [ "$QUIET" = "1" ] || echo "$@" >&2; }
missing=0
declare -A SEEN

# Normalize systemd specifiers we know how to expand; skip the rest.
expand_spec() {
  local p="$1"
  p="${p//\%h/\/home\/toxic}"
  p="${p//\%t/\/run\/user\/1000}"
  p="${p//\%U/1000}"
  printf '%s' "$p"
}

check_path() {
  # $1 = raw path, $2 = referrer file, $3 = line number, $4 = referencing line
  local raw="$1" ref="$2" lineno="$3" rline="$4" p key
  # Skip obvious prose artifacts
  case "$raw" in
    *...*|*-$|*/$|*.|*YYYYMMDD*|*/\.\.*) return 0 ;;
  esac
  p="$(expand_spec "$raw")"
  case "$p" in
    *%*) return 0 ;;  # unexpandable specifier — can't verify, don't flag
  esac
  key="$p"
  [ -n "${SEEN[$key]:-}" ] && return 0
  SEEN[$key]=1
  if [ ! -e "$p" ]; then
    missing=$((missing+1))
    echo "MISSING $p"
    echo "  referenced-by $ref:$lineno"
    echo "  line: $(printf '%s' "$rline" | sed 's/^[[:space:]]*//' | cut -c1-160)"
  fi
}

# --- 1. systemd units --------------------------------------------------------
if [ "$DO_UNITS" = "1" ]; then
  log "scanning systemd units..."
  for u in /etc/systemd/system/*.service /etc/systemd/system/*.timer \
           /home/toxic/.config/systemd/user/*.service /home/toxic/.config/systemd/user/*.timer; do
    [ -f "$u" ] || continue
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
      lineno=$((lineno+1))
      key="${line%%=*}"; val="${line#*=}"
      case "$key" in
        ExecStart|ExecStartPre|ExecStartPost|ExecStop|ExecStopPost|ExecReload|ExecCondition|EnvironmentFile|WorkingDirectory|ReadWritePaths|ReadOnlyPaths|ConfigurationDirectory)
          # First token of the value (strip leading -/+!/@ prefixes systemd allows)
          tok="$(printf '%s' "$val" | awk '{print $1}' | sed 's/^[-+!@:]*//')"
          case "$tok" in
            /*) check_path "$tok" "$u" "$lineno" "$line" ;;
          esac
          # EnvironmentFile may also name a bare path with dash prefix
          if [ "$key" = "EnvironmentFile" ]; then
            bare="$(printf '%s' "$val" | sed 's/^-//' | awk '{print $1}')"
            case "$bare" in /*) check_path "$bare" "$u" "$lineno" "$line" ;; esac
          fi
          ;;
      esac
    done < "$u"
  done
fi

# --- 2. live configs ----------------------------------------------------------
if [ "$DO_CONFIGS" = "1" ]; then
  log "scanning live configs..."
  for c in /home/toxic/sovereign/config/herd.yaml \
           /home/toxic/sovereign/pitchfork.toml \
           /home/toxic/sovereign/config/ports.env \
           /home/toxic/sovereign/config/keypools.yaml \
           /home/toxic/sovereign/config/model_constraints.yaml \
           /home/toxic/sovereign/config/llama-swap.yaml; do
    [ -f "$c" ] || { log "  (config not present: $c)"; continue; }
    while IFS=: read -r lineno raw; do
      rline="$(sed -n "${lineno}p" "$c")"
      check_path "$raw" "$c" "$lineno" "$rline"
    done < <(grep -nEo '/home/toxic/[A-Za-z0-9_./-]+' "$c" 2>/dev/null)
  done
fi

# --- 3. docs ------------------------------------------------------------------
if [ "$DO_DOCS" = "1" ]; then
  log "scanning docs (*.md)..."
  while IFS= read -r md; do
    while IFS=: read -r lineno raw; do
        # Skip .json when it is really .jsonl (substring artifact)
        rline="$(sed -n "${lineno}p" "$md")"
        case "$rline" in *"$raw"l*) continue ;; esac
        check_path "$raw" "$md" "$lineno" "$rline"
      done < <(grep -nEo '/home/toxic/[A-Za-z0-9_./-]*\.(sh|py|toml|yaml|yml|service|timer|env|json)' "$md" 2>/dev/null)
  done < <(find /home/toxic/sovereign -name '*.md' -not -path '*/node_modules/*' 2>/dev/null)
fi

log "done: $missing missing reference(s)"
[ "$missing" -eq 0 ]
