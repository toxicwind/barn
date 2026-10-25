#!/usr/bin/env bash
#
# stale-hunter.sh — automatic triage of stale herd worktree/merge litter.
#
# Rebuilds the 2026-09-20 ember herd-triage as a repeatable tool. For each
# candidate dir under ROOT it reports:
#   size | files | newest mtime | live proc cwd? | inbound symlinks? | git state
# and recommends ARCHIVE vs LEAVE.
#
# Usage:
#   stale-hunter.sh [ROOT]              report only (default /home/toxic/sovereign)
#   stale-hunter.sh --json [ROOT]       one JSON object per line on stdout
#   stale-hunter.sh --apply DIR [ROOT]  report AND mv ARCHIVE-verdict dirs into DIR
#                                       (never rm; archive preserves relative paths)
#
# Safety: report mode touches nothing. --apply only uses mv. .archive-* dirs
# are never candidates. Candidate patterns cover the known litter family:
# wt-*, merge-*, readmefix-herd*, modelpush-*, bench-wt-*, *merge-stash*, mesh-bruteforce-*.
#
# Exit: 0 always (triage is informational); 2 on bad args.

set -u

ROOT="/home/toxic/sovereign"
APPLY_DIR=""
JSON=0
LIVE_DAYS=7

usage() {
  sed -n '2,20p' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) [ $# -ge 2 ] || { echo "stale-hunter: --apply needs DIR" >&2; exit 2; }
             APPLY_DIR="$2"; shift 2 ;;
    --json)  JSON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "stale-hunter: unknown flag $1" >&2; exit 2 ;;
    *) ROOT="$1"; shift ;;
  esac
done

[ -d "$ROOT" ] || { echo "stale-hunter: ROOT not a dir: $ROOT" >&2; exit 2; }

# ---- candidate discovery -------------------------------------------------
shopt -s nullglob
declare -a CANDS=()
for pat in 'wt-*' 'merge-*' 'readmefix-herd*' 'modelpush-*' 'bench-wt-*' '*merge-stash*' 'mesh-bruteforce-*'; do
  for d in "$ROOT"/$pat; do
    [ -d "$d" ] || continue
    case "$d" in */.archive-*) continue ;; esac
    base="$(basename "$d")"
    if [ -d "$d/herd" ]; then
      CANDS+=("$d/herd")
    elif [[ "$base" == *herd* ]]; then
      CANDS+=("$d")
    fi
  done
done
# dedupe (patterns can overlap)
declare -A SEEN=()
declare -a UNI=()
for c in "${CANDS[@]}"; do
  [ -n "${SEEN[$c]:-}" ] && continue
  SEEN[$c]=1
  UNI+=("$c")
done
CANDS=("${UNI[@]}")

# ---- precompute: all symlinks under ROOT (one find, reused per candidate) --
declare -a LINKS=()
while IFS= read -r l; do LINKS+=("$l"); done < <(find "$ROOT" -maxdepth 5 -type l 2>/dev/null)

# ---- precompute: registered worktrees of ROOT (if ROOT is a git repo) -----
WT_LIST=""
if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  WT_LIST="$(git -C "$ROOT" worktree list --porcelain 2>/dev/null | grep '^worktree ' | cut -d' ' -f2- || true)"
fi

now_epoch="$(date +%s)"
cutoff_epoch=$(( now_epoch - LIVE_DAYS * 86400 ))

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

n_archive=0; n_leave=0
declare -a APPLY_OK=()

report_row() { # path size files newest_human live_procs inbound_links git_state registered verdict reasons
  local path="$1" size="$2" files="$3" newest="$4" live="$5" inbound="$6"
  local gstate="$7" reg="$8" verdict="$9" reasons="${10}"
  if [ "$JSON" -eq 1 ]; then
    printf '{"path":"%s","size":"%s","files":%s,"newest_mtime":"%s","live_proc_cwd":%s,"inbound_symlinks":%s,"git_state":"%s","registered_worktree":%s,"verdict":"%s","reasons":"%s"}\n' \
      "$(json_escape "$path")" "$(json_escape "$size")" "$files" "$newest" "$live" "$inbound" \
      "$gstate" "$reg" "$verdict" "$(json_escape "$reasons")"
  else
    printf '%-58s | %-7s | %6s files | newest %-10s | procs %-2s | links %-2s | git %-11s | reg %-3s | %s %s\n' \
      "$path" "$size" "$files" "$newest" "$live" "$inbound" "$gstate" "$reg" "$verdict" "$reasons"
  fi
}

[ "$JSON" -eq 0 ] && printf '%-58s | %-7s | %6s       | %-16s | %-8s | %-9s | %-15s | %-7s | verdict\n' \
  "path" "size" "files" "newest" "procs" "links" "git" "reg"

for c in "${CANDS[@]}"; do
  size="$(du -sh "$c" 2>/dev/null | cut -f1)"
  files="$(find "$c" -type f 2>/dev/null | wc -l)"
  newest_epoch="$(find "$c" -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1 | cut -d. -f1)"
  if [ -n "$newest_epoch" ]; then
    newest_human="$(date -u -d "@$newest_epoch" '+%Y-%m-%d' 2>/dev/null || echo '?')"
  else
    newest_human="none"; newest_epoch=0
  fi

  # live process with cwd inside candidate?
  live=0; live_pid=""
  for cw in /proc/[0-9]*/cwd; do
    t="$(readlink "$cw" 2>/dev/null)" || continue
    case "$t" in "$c"|"$c"/*)
      live=$((live + 1))
      [ -z "$live_pid" ] && live_pid="${cw#/proc/}" && live_pid="${live_pid%/cwd}"
      ;;
    esac
  done

  # symlinks anywhere under ROOT pointing into candidate?
  inbound=0; inbound_first=""
  for l in "${LINKS[@]}"; do
    tgt="$(readlink "$l" 2>/dev/null)" || continue
    case "$tgt" in "$c"|"$c"/*)
      inbound=$((inbound + 1))
      [ -z "$inbound_first" ] && inbound_first="$l"
      ;;
    esac
  done

  # git state: broken worktree gitfile vs healthy repo vs plain dir
  gstate="plain-dir"
  if [ -e "$c/.git" ]; then
    if git -C "$c" rev-parse --git-dir >/dev/null 2>&1; then gstate="git-ok"; else gstate="git-broken"; fi
  elif git -C "$c" rev-parse --show-toplevel >/dev/null 2>&1; then
    gstate="inside-repo"
  fi

  reg="no"
  if [ -n "$WT_LIST" ]; then
    while IFS= read -r w; do
      [ "$w" = "$c" ] && reg="yes"
    done <<< "$WT_LIST"
  fi

  verdict="ARCHIVE"; reasons=""
  if [ "$live" -gt 0 ]; then verdict="LEAVE"; reasons="$reasons live-proc-cwd($live_pid)"; fi
  if [ "$inbound" -gt 0 ]; then verdict="LEAVE"; reasons="$reasons inbound-symlink($inbound_first)"; fi
  if [ "$reg" = "yes" ]; then verdict="LEAVE"; reasons="$reasons registered-worktree"; fi
  if [ "$newest_epoch" -ge "$cutoff_epoch" ] && [ "$newest_epoch" -ne 0 ]; then
    verdict="LEAVE"; reasons="$reasons recent-mtime"
  fi
  reasons="${reasons# }"

  report_row "$c" "${size:-?}" "$files" "$newest_human" "$live" "$inbound" "$gstate" "$reg" "$verdict" "$reasons"

  if [ "$verdict" = "ARCHIVE" ]; then n_archive=$((n_archive + 1)); else n_leave=$((n_leave + 1)); fi

  # --apply: mv ARCHIVE-verdict dirs, preserving path relative to ROOT
  if [ -n "$APPLY_DIR" ] && [ "$verdict" = "ARCHIVE" ]; then
    rel="${c#$ROOT/}"
    dest="$APPLY_DIR/$rel"
    mkdir -p "$(dirname "$dest")"
    if mv "$c" "$dest" 2>/dev/null; then
      APPLY_OK+=("$c -> $dest")
    else
      echo "stale-hunter: APPLY FAILED for $c" >&2
    fi
  fi
done

if [ "$JSON" -eq 0 ]; then
  echo "---"
  echo "candidates: ${#CANDS[@]} | ARCHIVE: $n_archive | LEAVE: $n_leave"
  if [ -n "$APPLY_DIR" ]; then
    echo "applied moves into $APPLY_DIR:"
    for m in "${APPLY_OK[@]}"; do echo "  $m"; done
  fi
fi
