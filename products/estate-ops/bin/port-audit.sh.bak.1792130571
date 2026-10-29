#!/usr/bin/env bash
#
# port-audit.sh — audit yote's fixed-port sprawl.
#
#   1. Takes an `ss -tlnp` snapshot of every TCP listener.
#   2. Cross-references each listener against:
#        - the port SSOT            (config/ports.env)
#        - pitchfork daemon claims  (pitchfork.toml ready_http)
#        - herd.yaml dynamic slots  (llama-server processes from startPort)
#        - tailscale serve backends (tailscale serve status)
#        - known system services    (static table below)
#   3. Scans sovereign logs + journal for EADDRINUSE / "address already in use".
#   4. Flags: DUPLICATE live claims, DEAD config claims (no listener),
#      ROGUE listeners (no config source), DANGLING tailscale backends,
#      DUP-CLAIM in the SSOT itself, and hardcoded ports missing from the SSOT.
#   5. Enforces the estate port policy (Chris 2026-09-20): EVERY service port
#      must live in 25000-35000. Violations are flagged, never auto-fixed.
#      Known system/infra ports outside the range are flagged separately as
#      POLICY-VIOLATION-SYSTEM so they are decided, not silently exempted.
#
# Usage: port-audit.sh [--json] [--quiet]
#   --json   emit a machine-readable summary after the human report
#   --quiet  print only findings + summary (cron/watchdog friendly)
#
# Exit: 0 = clean, 1 = findings, 2 = could not take a snapshot.
#
# READ-ONLY. Never kills, restarts, binds, or otherwise touches anything.
# Runs on yote; SOV overrides the sovereign tree root.

set -uo pipefail

SOV="${SOV:-/home/toxic/sovereign}"
SSOT="$SOV/config/ports.env"
PITCHFORK="$SOV/pitchfork.toml"
HERD_YAML="$SOV/config/herd.yaml"
LOG_DIRS=("$SOV/logs" "$SOV/data" "$SOV/var")

JSON=0; QUIET=0
for a in "$@"; do
  case "$a" in
    --json) JSON=1 ;;
    --quiet) QUIET=1 ;;
    *) echo "usage: $0 [--json] [--quiet]" >&2; exit 2 ;;
  esac
done

say() { (( QUIET )) || printf '%s\n' "$*"; }
warn_missing() { say "[warn] $*"; }

# ---------------------------------------------------------------- policy ------
# Estate port policy (Chris 2026-09-20): EVERY service port lives in 25000-35000.
POLICY_MIN=25000
POLICY_MAX=35000
in_policy() { (( $1 >= POLICY_MIN && $1 <= POLICY_MAX )); }

# ---------------------------------------------------------------- snapshot ---
SS_CMD=(ss -tlnp)
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SS_CMD=(sudo -n ss -tlnp)
else
  warn_missing "no passwordless sudo: processes owned by other users will show no pid (ss -p blind spots)"
fi

SNAP="$("${SS_CMD[@]}" 2>/dev/null | awk 'NR>1 && $1=="LISTEN" {print}')"
if [[ -z "$SNAP" ]]; then
  echo "[error] ss snapshot failed/empty" >&2
  exit 2
fi

declare -A PORT_PROCS=()   # port -> "pid:name;pid:name" (deduped)
declare -A PORT_ADDRS=()   # port -> "addr addr"
declare -A PID_CMD=()      # pid  -> short cmdline

while IFS= read -r line; do
  # $4 = Local Address:Port ; process info (if any) in users:(("name",pid=N,fd=F))
  addrport="$(awk '{print $4}' <<<"$line")"
  port="${addrport##*:}"
  addr="${addrport%:*}"
  [[ "$port" =~ ^[0-9]+$ ]] || continue
  procinfo="$(grep -oE 'users:\(\("[^"]*",pid=[0-9]+' <<<"$line" || true)"
  entry=""
  while IFS= read -r u; do
    name="$(sed -E 's/users:\(\("//; s/",pid=.*//' <<<"$u")"
    pid="$(sed -E 's/.*pid=//' <<<"$u")"
    entry+="${pid}:${name};"
    if [[ -z "${PID_CMD[$pid]:-}" ]]; then
      PID_CMD[$pid]="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null | cut -c1-120)"
    fi
  done <<<"$procinfo"
  PORT_PROCS[$port]="${PORT_PROCS[$port]:-}${entry}"
  PORT_ADDRS[$port]="${PORT_ADDRS[$port]:-} $addr"
done <<<"$SNAP"

nports=${#PORT_PROCS[@]}

# ---------------------------------------------------------------- SSOT -------
declare -A CLAIM_SSOT=()   # port -> "NAME NAME"
if [[ -f "$SSOT" ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# || -z "${line//[[:space:]]/}" ]] && continue
    if [[ "$line" =~ ^([A-Z0-9_]+_PORT)=([0-9]+) ]]; then
      CLAIM_SSOT[${BASH_REMATCH[2]}]="${CLAIM_SSOT[${BASH_REMATCH[2]}]:-}${BASH_REMATCH[1]} "
    fi
  done < "$SSOT"
else
  warn_missing "SSOT not found: $SSOT"
fi

# ------------------------------------------------------------- pitchfork -----
declare -A CLAIM_PF=()     # port -> "daemon daemon"
# Two claim sources inside each stanza: the canonical `port = N` declaration
# (single source of truth since the 2026-09-20 port-policy pass) and the
# legacy ready_http URL. Multi-port stanzas (port = [a, b]) claim each port.
if [[ -f "$PITCHFORK" ]]; then
  cur=""; in_target=0
  while IFS= read -r line; do
    if [[ "$line" =~ ^\[daemons\.([A-Za-z0-9_.-]+)\] ]]; then cur="${BASH_REMATCH[1]}"; fi
    # skip comments: stale ready_http notes in comments must not become claims
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ -n "$cur" ]]; then
      if [[ "$line" =~ ^[[:space:]]*port[[:space:]]*=[[:space:]]*\[?([0-9,\ ]+)\]? ]]; then
        for p in $(tr ',' ' ' <<<"${BASH_REMATCH[1]}"); do
          [[ "$p" =~ ^[0-9]+$ ]] || continue
          CLAIM_PF[$p]="${CLAIM_PF[$p]:-}${cur} "
        done
      elif [[ "$line" =~ ^[[:space:]]*ready_http[[:space:]]*=[^:]*://[^:/]+:([0-9]+) ]]; then
        CLAIM_PF[${BASH_REMATCH[1]}]="${CLAIM_PF[${BASH_REMATCH[1]}]:-}${cur} "
      fi
    fi
  done < "$PITCHFORK"
else
  warn_missing "pitchfork.toml not found: $PITCHFORK"
fi

# ------------------------------------------------------------- tailscale -----
declare -A CLAIM_TS=()     # port -> "/path /path"
TS_RAW="$(tailscale serve status 2>/dev/null || sudo -n tailscale serve status 2>/dev/null || true)"
if [[ -n "$TS_RAW" ]]; then
  while IFS= read -r line; do
    if [[ "$line" =~ \|\-\-[[:space:]]*([^[:space:]]+)[[:space:]]+proxy[[:space:]]+http://127\.0\.0\.1:([0-9]+) ]]; then
      CLAIM_TS[${BASH_REMATCH[2]}]="${CLAIM_TS[${BASH_REMATCH[2]}]:-}${BASH_REMATCH[1]} "
    fi
  done <<<"$TS_RAW"
else
  warn_missing "could not read tailscale serve status"
fi

# ---------------------------------------------------------- herd dynamic -----
declare -A HERD_DYN=()     # port -> 1  (llama-server workers, ports assigned from herd.yaml startPort)
for port in "${!PORT_PROCS[@]}"; do
  for e in ${PORT_PROCS[$port]//;/ }; do
    pid="${e%%:*}"
    if [[ "${PID_CMD[$pid]:-}" == *llama-server* || "${PID_CMD[$pid]:-}" == *llama-swap* ]]; then
      HERD_DYN[$port]=1
    fi
  done
done

# ------------------------------------------------------------ system ports ---
# Static documentation of non-sovereign listeners. uid/root services that
# ss -p cannot attribute without sudo are resolved here by convention.
declare -A SYSTEM=(
  [22]="sshd" [2222]="sshd-alt" [53]="dns" [443]="tailscaled-funnel"
  [631]="cupsd" [5355]="systemd-resolved-llmnr" [5432]="postgres"
  [9090]="cockpit" [41641]="tailscaled-udp" [59818]="tailscaled"
  [60955]="tailscaled" [42445]="containerd" [57889]="bpftune"
  [5037]="adb" [20241]="cloudflared"
  # sccache :4226 — upstream-hardcoded localhost build-cache port (no flag/env in
  # this sccache version); not an estate service. Documented decision, still
  # flagged POLICY-VIOLATION-SYSTEM every run (decided, never silently exempted).
  [4226]="sccache-build-cache"
  [58050]="bubbleupnp-server" [58051]="bubbleupnp-server"
  [35393]="bubbleupnp-server" [37497]="bubbleupnp-server" [43161]="bubbleupnp-server"
)

# ---------------------------------------------------------------- findings ---
declare -a FINDINGS=()     # "SEV|code|detail"
find() { FINDINGS+=("$1|$2|$3"); }

is_live() { [[ -n "${PORT_PROCS[$1]:-}" ]]; }

# --- 1. per-port verdicts: duplicates, rogue listeners -----------------------
for port in $(printf '%s\n' "${!PORT_PROCS[@]}" | sort -n); do
  # distinct pids on this port?
  pids="$(tr ';' '\n' <<<"${PORT_PROCS[$port]}" | cut -d: -f1 | grep -E '^[0-9]+$' | sort -u | tr '\n' ' ')"
  npids=$(wc -w <<<"$pids")
  names="$(tr ';' '\n' <<<"${PORT_PROCS[$port]}" | cut -d: -f2- | grep -v '^$' | sort -u | tr '\n' ' ')"
  if (( npids > 1 )); then
    find "CRIT" "DUP-LIVE" "port $port held by $npids processes: $pids ($names)"
  fi
  src=""
  [[ -n "${SYSTEM[$port]:-}" ]]     && src+="system(${SYSTEM[$port]}) "
  [[ -n "${CLAIM_SSOT[$port]:-}" ]] && src+="ssot(${CLAIM_SSOT[$port]}) "
  [[ -n "${CLAIM_PF[$port]:-}" ]]   && src+="pitchfork(${CLAIM_PF[$port]}) "
  [[ -n "${CLAIM_TS[$port]:-}" ]]   && src+="tailscale(${CLAIM_TS[$port]}) "
  [[ -n "${HERD_DYN[$port]:-}" ]]   && src+="herd-dynamic "
  if [[ -z "$src" ]]; then
    tag="ROGUE"
    (( port >= 10000 )) && tag="ROGUE-HARDCODED"
    find "WARN" "$tag" "port $port live with no config source — procs: ${names:-unknown} — candidate for ports.env"
  fi
done

# --- 2. dead config claims ----------------------------------------------------
for port in $(printf '%s\n' "${!CLAIM_SSOT[@]}" | sort -n); do
  is_live "$port" || find "INFO" "DEAD-SSOT" "SSOT claims :$port (${CLAIM_SSOT[$port]}) but nothing listens"
done
for port in $(printf '%s\n' "${!CLAIM_PF[@]}" | sort -n); do
  is_live "$port" || find "INFO" "DEAD-PITCHFORK" "pitchfork claims :$port (daemon ${CLAIM_PF[$port]}) but nothing listens"
done
for port in $(printf '%s\n' "${!CLAIM_TS[@]}" | sort -n); do
  is_live "$port" && continue
  find "WARN" "DANGLING-BACKEND" "tailscale serve backend 127.0.0.1:$port (${CLAIM_TS[$port]}) has NO listener — path will 502"
done

# --- 3. duplicate claims inside the SSOT itself --------------------------------
for port in $(printf '%s\n' "${!CLAIM_SSOT[@]}" | sort -n); do
  n=$(wc -w <<<"${CLAIM_SSOT[$port]}")
  (( n > 1 )) && find "INFO" "DUP-CLAIM" "SSOT assigns :$port to $n names: ${CLAIM_SSOT[$port]}"
done

# --- 3b. port-policy violations: EVERY service port must be 25000-35000 -------
for port in $(printf '%s\n' "${!CLAIM_SSOT[@]}" | sort -n); do
  in_policy "$port" || find "CRIT" "POLICY-VIOLATION" "SSOT claims :$port (${CLAIM_SSOT[$port]}) outside $POLICY_MIN-$POLICY_MAX"
done
for port in $(printf '%s\n' "${!CLAIM_PF[@]}" | sort -n); do
  in_policy "$port" || find "CRIT" "POLICY-VIOLATION" "pitchfork claims :$port (daemon ${CLAIM_PF[$port]}) outside $POLICY_MIN-$POLICY_MAX"
done
for port in $(printf '%s\n' "${!PORT_PROCS[@]}" | sort -n); do
  in_policy "$port" && continue
  [[ -n "${HERD_DYN[$port]:-}" ]] && continue   # herd workers float above the range by design
  names="$(tr ';' '\n' <<<"${PORT_PROCS[$port]}" | cut -d: -f2- | grep -v '^$' | sort -u | tr '\n' ' ')"
  if [[ -n "${SYSTEM[$port]:-}" ]]; then
    # Known infra, still flagged: Chris's order covers every service port;
    # these need an explicit relocation decision, not a silent exemption.
    find "WARN" "POLICY-VIOLATION-SYSTEM" "system port :$port (${SYSTEM[$port]}) outside $POLICY_MIN-$POLICY_MAX — needs relocation decision"
  else
    find "CRIT" "POLICY-VIOLATION" "live listener :$port (${names:-unknown}) outside $POLICY_MIN-$POLICY_MAX with no system entry"
  fi
done

# --- 4. EADDRINUSE / bind-failure scan -----------------------------------------
declare -a EAINUSE_HITS=()
for d in "${LOG_DIRS[@]}"; do
  [[ -d "$d" ]] || continue
  while IFS= read -r f; do
    hits="$(grep -a -i -m3 -E "address already in use|EADDRINUSE|Errno 98" "$f" 2>/dev/null | head -3)"
    [[ -n "$hits" ]] && EAINUSE_HITS+=("$f :: $(head -1 <<<"$hits" | cut -c1-140)")
  done < <(find "$d" -maxdepth 2 -name "*.log" -mtime -30 2>/dev/null | head -300)
done
JOURNAL_HITS="$(journalctl --since "7 days ago" -p err 2>/dev/null | grep -i -m5 -E "address already in use|EADDRINUSE" | cut -c1-140 || true)"
for h in "${EAINUSE_HITS[@]}"; do find "WARN" "EADDRINUSE" "$h"; done
[[ -n "$JOURNAL_HITS" ]] && while IFS= read -r h; do find "WARN" "EADDRINUSE-JOURNAL" "$h"; done <<<"$JOURNAL_HITS"

# ---------------------------------------------------------------- report -----
say "=== port-audit: $(date -u +%FT%TZ) on $(hostname) ==="
say "listeners: $nports distinct ports | ssot claims: ${#CLAIM_SSOT[@]} | pitchfork claims: ${#CLAIM_PF[@]} | tailscale backends: ${#CLAIM_TS[@]}"
say ""
say "--- port map (port | ssot | pitchfork | tailscale | process | verdict) ---"
for port in $(printf '%s\n' "${!PORT_PROCS[@]}" | sort -n); do
  names="$(tr ';' '\n' <<<"${PORT_PROCS[$port]}" | cut -d: -f2- | grep -v '^$' | sort -u | paste -sd, -)"
  pids="$(tr ';' '\n' <<<"${PORT_PROCS[$port]}" | cut -d: -f1 | grep -E '^[0-9]+$' | sort -u | paste -sd, -)"
  verdict="ROGUE"
  [[ -n "${SYSTEM[$port]:-}" ]]     && verdict="system:${SYSTEM[$port]}"
  [[ -n "${CLAIM_SSOT[$port]:-}" ]] && verdict="ok:ssot"
  [[ -n "${CLAIM_PF[$port]:-}" ]]   && verdict="ok:pitchfork"
  [[ -n "${CLAIM_TS[$port]:-}" ]]   && verdict="ok:tailscale"
  [[ -n "${HERD_DYN[$port]:-}" ]]   && verdict="ok:herd-dynamic"
  printf '%-6s | %-28.28s | %-22.22s | %-16.16s | %-24.24s | %s\n' \
    "$port" "${CLAIM_SSOT[$port]:--}" "${CLAIM_PF[$port]:--}" "${CLAIM_TS[$port]:--}" \
    "${names:-pid:$pids}" "$verdict"
done

say ""
say "--- findings (${#FINDINGS[@]}) ---"
if (( ${#FINDINGS[@]} == 0 )); then
  say "clean: no duplicates, no dead claims, no rogues, no bind failures in logs"
else
  for f in "${FINDINGS[@]}"; do
    printf '[%s] %s: %s\n' "${f%%|*}" "$(cut -d'|' -f2 <<<"$f")" "$(cut -d'|' -f3- <<<"$f")"
  done
fi

ncrit=$(printf '%s\n' "${FINDINGS[@]}" | grep -c '^CRIT|' || true)
npol=$(printf '%s\n' "${FINDINGS[@]}" | grep -c 'POLICY-VIOLATION' || true)
say ""
say "summary: ${#FINDINGS[@]} findings (${ncrit} critical, ${npol} port-policy violations)"

if (( JSON )); then
  python3 - "$nports" "${#CLAIM_SSOT[@]}" "${#CLAIM_PF[@]}" "${#CLAIM_TS[@]}" <<'PYEOF'
import json, sys
nports, nssot, npf, nts = map(int, sys.argv[1:5])
print(json.dumps({"ports": nports, "ssot_claims": nssot,
                  "pitchfork_claims": npf, "tailscale_backends": nts,
                  "findings_emitted": True,
                  "note": "full finding list is in the text report above"}))
PYEOF
fi

(( ${#FINDINGS[@]} > 0 )) && exit 1
exit 0
