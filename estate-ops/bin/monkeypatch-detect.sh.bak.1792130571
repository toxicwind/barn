#!/usr/bin/env bash
# monkeypatch-detect.sh — hunt non-durable fixes across the estate.
#
# Chris's standing rule: NO MONKEYPATCHING. Every fix must live in real
# files (code, configs, systemd units), committed, and must survive a full
# bridge restart and a full yote reboot. This script finds the violations:
#
#   1. /tmp scripts doing production jobs (load-bearing scratch that dies on reboot)
#   2. shell exports (.bashrc/.profile) that belong in real config (env files, systemd)
#   3. hand-started daemons (nohup/setsid) with no pitchfork/systemd unit
#   4. patched files outside any repo (node_modules patches, stray .bak next to live files)
#   5. symlinks pointing into /tmp (or other ephemeral dirs)
#
# Output: each finding with WHAT / WHERE / SUGGESTED DURABLE HOME.
# Exit code: 1 if any findings, 0 if clean.
#
# Usage: monkeypatch-detect.sh [--quiet] [--json]
#   --quiet  only print findings (skip section headers when clean)
#   --json   machine-readable output (one JSON object per line)
#
# Durable home: /home/toxic/sovereign/projects/ops/bin/monkeypatch-detect.sh
# (sovereign-projects, canonical main). Safe to run anytime, read-only:
# it never modifies, kills, or restarts anything.

set -u
QUIET=0
JSON=0
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=1 ;;
    --json)  JSON=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
  esac
done

FINDINGS=0
N=0

emit() { # emit <category> <what> <where> <home>
  local cat="$1" what="$2" where="$3" home="$4"
  FINDINGS=1
  N=$((N+1))
  if (( JSON )); then
    printf '{"n":%d,"category":"%s","what":%s,"where":%s,"durable_home":%s}\n' \
      "$N" "$cat" "$(printf '%s' "$what" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$where" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
      "$(printf '%s' "$home" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
  else
    printf 'FINDING #%d [%s]\n  what: %s\n  where: %s\n  durable home: %s\n\n' "$N" "$cat" "$what" "$where" "$home"
  fi
}

section() { (( QUIET )) || (( JSON )) || printf '\n=== %s ===\n' "$1"; }

HOME_DIR="${HOME:-/home/toxic}"
SOV="${SOVEREIGN_DIR:-/home/toxic/sovereign}"

# ---------------------------------------------------------------- 1. /tmp production scripts
section "/tmp scripts doing production jobs"
# Recently-touched, non-trivial scripts in /tmp (top 2 levels). Load-bearing
# scratch: dies on reboot, invisible to git, unreviewed.
if [ -d /tmp ]; then
  while IFS= read -r f; do
    [ -e "$f" ] || continue
    sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
    (( sz < 300 )) && continue
    case "$f" in
      */.triage-stage/*|*/.X*|*/pymp-*|*/torchinductor_*|*/ssh-*|*/systemd-*) continue ;;
    esac
    # referenced by any scheduler/supervisor config? then it is load-bearing
    refs=""
    for cfg in "$HOME_DIR/.config/systemd/user" "$SOV/pitchfork.toml" /etc/crontab; do
      [ -e "$cfg" ] && grep -qF "$f" "$cfg" 2>/dev/null && refs="$refs $(basename "$cfg")"
    done
    if [ -n "${CRONHINT:-}" ]; then :; fi
    crontab -l 2>/dev/null | grep -qF "$f" && refs="$refs crontab"
    if [ -n "$refs" ]; then
      emit "tmp-production-script" "script in /tmp referenced by:$refs (load-bearing, dies on reboot)" "$f" \
        "move into owning repo (sovereign-projects or the service's repo), reference the repo path from config, commit"
    else
      emit "tmp-scratch-script" "non-trivial script living in /tmp (>300B, recently touched)" "$f" \
        "if one-off: delete after use; if reused: move into sovereign-projects (projects/ops/bin or the owning project), commit"
    fi
  done < <(find /tmp -maxdepth 2 \( -name '*.sh' -o -name '*.py' -o -name '*.js' -o -name '*.ts' \) -newermt '7 days ago' -type f 2>/dev/null)
  # stale backups of live configs sitting in /tmp = the fix happened, the evidence didn't land
  while IFS= read -r f; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    case "$base" in
      *secret*|*credential*|*.pem|*.key)
        emit "tmp-secrets-backup" "backup of a secrets/credential file in /tmp (must never be committed)" "$f" \
          "verify the live file is good, then shred it: shred -u '$f'. Never git-add." ;;
      *)
        emit "tmp-config-backup" ".bak of a live config left in /tmp (the change may not be committed)" "$f" \
          "diff against the live file; commit the live change in its repo; delete the /tmp backup" ;;
    esac
  done < <(find /tmp -maxdepth 1 \( -name '*.bak' -o -name '*.bak-*' -o -name '*.orig' \) -type f 2>/dev/null)
fi

# ---------------------------------------------------------------- 2. shell exports audit
section "shell exports that belong in real config"
# Service-affecting env vars exported from interactive shell dotfiles: they
# apply to shells, not to daemons, and they paper over missing real config.
for rc in "$HOME_DIR/.bashrc" "$HOME_DIR/.profile" "$HOME_DIR/.zshrc" "$HOME_DIR/.bash_profile"; do
  [ -f "$rc" ] || continue
  while IFS= read -r line; do
    var=$(printf '%s' "$line" | sed -E 's/^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/')
    case "$var" in
      # secrets: NEVER commit; they belong in a vault/env file with tight perms
      *_KEY|*_TOKEN|*_SECRET|*_PASSWORD|*_AUTH)
        emit "shell-secret-export" "secret exported from interactive shell rc ($var)" "$rc" \
          "keep OUT of git; move to ~/.secrets or a systemd EnvironmentFile=/run/secrets/... with 0600 perms (already the pattern for openfang-run.sh)" ;;
      # service env that daemons need: belongs in the daemon's own config
      *PORT*|*HOST*|*URL*|*ENDPOINT*|*MODEL*|*INTAKE*|*ENABLE*|*DISABLE*|*DEBUG)
        case "$var" in PATH|HOME|USER|SHELL|LANG|LC_*|TERM|EDITOR|PAGER|FZF_*|LESS*|GREP*|GCC_*|CLICOLOR) continue ;; esac
        emit "shell-service-export" "service env var in interactive shell rc ($var) — daemons do not inherit it" "$rc" \
          "pitchfork.toml [daemons.*] env = {...}, systemd Environment=, or a committed env file sourced by the daemon entrypoint" ;;
    esac
  done < <(grep -E '^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=' "$rc" 2>/dev/null)
done

# ---------------------------------------------------------------- 3. hand-started daemons
section "hand-started daemons (no unit)"
# Long-running processes that look like services but are not supervised.
# Ground truth: the pitchfork supervisor's own child PIDs, plus basenames
# extracted from pitchfork.toml run lines (definitions can be stale, so
# the live supervisor tree wins over the toml text).
SUP_PIDS=$(pgrep -f "pitchfork supervisor" 2>/dev/null | tr '\n' ' ' || true)
PF_BINS=""
if [ -f "$SOV/pitchfork.toml" ]; then
  PF_BINS=$(grep -E '^\s*run\s*=' "$SOV/pitchfork.toml" | grep -oE '[^"'"'"' ]+\.(py|js|ts|sh)\b' | xargs -n1 basename 2>/dev/null | sort -u | tr '\n' ' ' || true)
fi
# allowlist: platform plumbing, shells, the detector's own toolchain
ALLOW_RE='^(tailscaled|sshd|systemd|dbus|pipewire|pulseaudio|at-spi|gpg-agent|ssh-agent|tmux|screen|bash|zsh|fish|sh|sudo|su|crond|cron|node|bun|deno|python3?|perl|awk|find|grep|sleep|tail|less|vim?|nvim|emacs|git|ssh|scp|rsync|curl|wget|tar|make|cc1|ld|as|nvidia|hypr|sway|waybar|wofi|kitty|alacritty|foot|wezterm|xdg|gvfs|udisks|polkit|rtkit|upower|boltd|fwupd|ModemManager|NetworkManager|wpa_supplicant|bluetoothd|avahi|cupsd|colord|accounts-daemon|geoclue|power-profiles|snapd|docker|containerd|runc|kubelet|prometheus|grafana|node_exporter)(\s|$)'
while IFS= read -r line; do
  # ps: pid ppid etime args
  pid=$(printf '%s' "$line" | awk '{print $1}')
  ppid=$(printf '%s' "$line" | awk '{print $2}')
  etime=$(printf '%s' "$line" | awk '{print $3}')
  args=$(printf '%s' "$line" | cut -d' ' -f4-)
  comm=$(printf '%s' "$args" | awk '{print $1}' | xargs basename 2>/dev/null)
  # skip short-lived and allowlisted
  case "$etime" in *-*|*:*:*) : ;; *) continue ;; esac   # need >= ~1h (HH:MM:SS or D-..)
  printf '%s' "$comm" | grep -Eq "$ALLOW_RE" && continue
  # skip anything supervised: child of the live pitchfork supervisor, or
  # basename-matches a script/binary named in pitchfork.toml run lines
  supervised=0
  case " $SUP_PIDS " in *" $ppid "*) supervised=1 ;; esac
  if (( ! supervised )) && [ -n "$PF_BINS" ]; then
    for b in $PF_BINS; do
      case "$args" in *"$b"*) supervised=1; break ;; esac
    done
  fi
  (( supervised )) && continue
  case "$args" in
    *pitchfork*|*monkeypatch-detect*|*ps\ -*) continue ;;
  esac
  # heuristic: detached (ppid 1) or double-forked service-ish things under /home
  case "$args" in
    *"$HOME_DIR"*|*/home/*|*nohup*|*setsid*)
      emit "hand-started-daemon" "long-running ($etime) process not traced to pitchfork/systemd (pid $pid, ppid $ppid): $args" "ps" \
        "add a [daemons.*] section to $SOV/pitchfork.toml (or a systemd user unit), start via pitchfork-restart, kill the hand-started instance only after the supervised one is verified healthy" ;;
  esac
done < <(ps -eo pid,ppid,etime,args --no-headers 2>/dev/null)

# ---------------------------------------------------------------- 4. patches outside any repo
section "patched files outside any repo"
# node_modules is the classic monkeypatch zone: a debug/edit there dies on reinstall.
if [ -d "$HOME_DIR/node_modules" ]; then
  while IFS= read -r f; do
    # install-batch artifacts are not patches: skip files touched within 5 min
    # of their own package's package.json (one npm install writes them together)
    pkgdir=$(dirname "$f")
    while [ "$pkgdir" != "$HOME_DIR" ] && [ ! -f "$pkgdir/package.json" ]; do
      pkgdir=$(dirname "$pkgdir")
    done
    if [ -f "$pkgdir/package.json" ]; then
      fm=$(stat -c %Y "$f" 2>/dev/null || echo 0)
      pm=$(stat -c %Y "$pkgdir/package.json" 2>/dev/null || echo 0)
      d=$(( fm - pm )); [ "$d" -lt 0 ] && d=$(( -d ))
      [ "$d" -lt 300 ] && continue
    fi
    emit "node_modules-patch" "file inside node_modules modified in last 14d (dies on npm reinstall)" "$f" \
      "clean revert (npm pack / reinstall the package); if it was a real fix, patch the owning repo or vendor a fork; document the incident in sovereign-projects"
  done < <(find "$HOME_DIR"/node_modules "$HOME_DIR"/*/node_modules -maxdepth 4 -type f -newermt '14 days ago' \
    ! -name '*.log' ! -path '*/.cache/*' 2>/dev/null | head -200)
  # .bak/.orig sitting next to node_modules sources = a patch happened here
  while IFS= read -r f; do
    emit "node_modules-backup" "backup file next to a node_modules source (evidence of an in-place patch)" "$f" \
      "diff vs the live file; revert or upstream the fix; delete the backup"
  done < <(find "$HOME_DIR" -maxdepth 4 \( -name '*.bak' -o -name '*.orig' -o -name '*.rej' \) -path '*node_modules*' 2>/dev/null | head -10)
fi
# /tmp backups that mirror repo paths (e.g. smithers-index.js.bak)
while IFS= read -r f; do
  base=$(basename "$f" | sed -E 's/\.(bak|bak-.*|orig)$//')
  emit "tmp-mirror-backup" "/tmp backup of what looks like a live source file ($base)" "$f" \
    "diff against the live file; the live change must be reverted or committed in its owning repo; delete the /tmp copy"
done < <(find /tmp -maxdepth 1 -type f \( -name '*-index.js.bak' -o -name '*.js.bak' -o -name '*.py.bak' -o -name '*.ts.bak' \) 2>/dev/null)

# ---------------------------------------------------------------- 5. symlinks to /tmp
section "symlinks pointing at ephemeral dirs"
while IFS= read -r l; do
  tgt=$(readlink "$l")
  case "$tgt" in
    /tmp/*|/var/tmp/*)
      emit "tmp-symlink" "symlink -> ephemeral target ($tgt)" "$l" \
        "point at a durable path inside a repo or /home/toxic/<service>/, commit the target, recreate the link from a setup script" ;;
  esac
done < <(find "$HOME_DIR" -maxdepth 3 -type l 2>/dev/null | grep -v -E '^\/(proc|sys|dev)' | head -40)
# symlinks inside the sovereign repo that escape the repo = invisible dependency
if [ -d "$SOV" ]; then
  while IFS= read -r l; do
    tgt=$(readlink -f "$l" 2>/dev/null)
    case "$tgt" in
      "$SOV"/*) : ;;
      *) emit "repo-escape-symlink" "symlink inside sovereign repo points outside ($tgt)" "$l" \
           "vendor the target into the repo or replace with a committed setup step" ;;
    esac
  done < <(find "$SOV" -type l -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -20)
fi

# ---------------------------------------------------------------- verdict
if (( JSON )); then
  printf '{"verdict":"%s","findings":%d}\n' "$([ "$FINDINGS" -eq 1 ] && echo DIRTY || echo CLEAN)" "$N"
else
  if (( FINDINGS )); then
    printf '\n%d finding(s): NON-DURABLE FIXES PRESENT (exit 1)\n' "$N"
  elif (( ! QUIET )); then
    printf '\nClean: no monkeypatches detected (exit 0)\n'
  fi
fi
exit "$FINDINGS"
