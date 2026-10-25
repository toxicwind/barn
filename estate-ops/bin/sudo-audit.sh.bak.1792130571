#!/usr/bin/env bash
# sudo-audit.sh — verify the pack's action posture on this box.
#
# Checks, in order:
#   1. passwordless sudo scope for the invoking user (sudo -n true, sudo -n -l)
#   2. key paths and their permissions (~/.ssh, sudoers.d)
#   3. shared-tree ownership/permissions (/home/toxic/sovereign, /home/toxic/.tau)
#   4. pitchfork/systemd daemon management without interactive auth
#
# Usage: sudo-audit.sh [--json]
# Exit 0 = no blockers, 1 = one or more blockers found.
# Part of sovereign/projects/ops/bin/ (toxicwind/sovereign-projects).
set -u
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

blockers=()
warns=()
note()  { warns+=("$1"); }
block() { blockers+=("$1"); }

USER_NAME="$(id -un)"
HOME_DIR="$HOME"

# --- 1. sudo posture -------------------------------------------------------
if sudo -n true 2>/dev/null; then
  SUDO_NOPASS=yes
else
  SUDO_NOPASS=no
  block "sudo requires a password for $USER_NAME (sudo -n true failed)"
fi

SUDO_LIST="$(sudo -n -l 2>/dev/null || true)"
if [ -z "$SUDO_LIST" ]; then
  block "cannot list sudo privileges (sudo -n -l failed)"
else
  # Extract the command list lines after "may run the following commands"
  CMDS="$(printf '%s\n' "$SUDO_LIST" | grep -E '^\s+\(' | sed 's/^ *//')"
  [ -z "$CMDS" ] && note "no command-specific sudo entries parsed from sudo -l"
fi

NEEDS=(systemctl)
for c in "${NEEDS[@]}"; do
  if ! sudo -n -l 2>/dev/null | grep -qE "NOPASSWD:.*$c|NOPASSWD:\s*ALL"; then
    note "no explicit NOPASSWD entry for $c (blanket ALL may still cover it)"
  fi
done

# --- 2. key paths ----------------------------------------------------------
SSH_DIR="$HOME_DIR/.ssh"
if [ -d "$SSH_DIR" ]; then
  perms="$(stat -c '%a' "$SSH_DIR")"
  [ "$perms" != "700" ] && note "$SSH_DIR perms $perms (expected 700)"
  for k in "$SSH_DIR"/id_ed25519 "$SSH_DIR"/id_rsa; do
    if [ -f "$k" ]; then
      kp="$(stat -c '%a' "$k")"
      [ "$kp" != "600" ] && block "$k perms $kp (expected 600 — ssh will refuse it)"
    fi
  done
else
  note "no $SSH_DIR directory"
fi

if [ -d /etc/sudoers.d ]; then
  for f in /etc/sudoers.d/*; do
    [ -f "$f" ] || continue
    p="$(stat -c '%a' "$f")"
    [ "$p" != "440" ] && block "/etc/sudoers.d/$(basename "$f") perms $p (expected 440 — sudo ignores bad-perm files)"
  done
  if ! sudo -n visudo -c -q 2>/dev/null; then
    block "visudo -c reports sudoers syntax errors"
  fi
fi

# --- 3. shared-tree ownership ----------------------------------------------
for tree in /home/toxic/sovereign /home/toxic/.tau; do
  if [ -d "$tree" ]; then
    bad="$(find "$tree" -maxdepth 3 \( ! -user toxic -o ! -group toxic \) 2>/dev/null | head -5)"
    [ -n "$bad" ] && block "ownership drift under $tree: $(printf '%s' "$bad" | tr '\n' ' ')"
  else
    note "$tree does not exist"
  fi
done

# --- 4. daemon management without interactive auth -------------------------
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user list-units --no-pager >/dev/null 2>&1; then
    :
  else
    block "systemctl --user fails for $USER_NAME (lingering/session issue?)"
  fi
  if [ "$SUDO_NOPASS" = "yes" ]; then
    if ! sudo -n systemctl is-system-running >/dev/null 2>&1; then
      # is-system-running exits nonzero in degraded states too; treat output check only
      st="$(sudo -n systemctl is-system-running 2>/dev/null || true)"
      [ -z "$st" ] && block "passwordless systemctl cannot query system state"
    fi
  fi
else
  block "systemctl not found on PATH"
fi

PITCHFORK_FOUND=0
command -v pitchfork >/dev/null 2>&1 && PITCHFORK_FOUND=1
for pf in /home/toxic/.local/share/mise/installs/pitchfork/*/pitchfork; do
  [ -x "$pf" ] && PITCHFORK_FOUND=1 && break
done
if [ "$PITCHFORK_FOUND" = "1" ]; then
  :
else
  note "pitchfork binary not found (daemon supervision may be manual)"
fi

# --- report ----------------------------------------------------------------
if [ "$JSON" = "1" ]; then
  BLOCKERS_JSON="$(printf '%s\n' "${blockers[@]}")"
  WARNS_JSON="$(printf '%s\n' "${warns[@]}")"
  SUDO_NOPASS="$SUDO_NOPASS" BLOCKERS_JSON="$BLOCKERS_JSON" WARNS_JSON="$WARNS_JSON" \
  python3 - <<'EOF'
import json, os
def lines(v):
    v = v.strip()
    return v.split("\n") if v else []
print(json.dumps({"sudo_nopass": os.environ["SUDO_NOPASS"] == "yes",
                  "blockers": lines(os.environ["BLOCKERS_JSON"]),
                  "warnings": lines(os.environ["WARNS_JSON"])}, indent=2))
EOF
else
  echo "== sudo-audit: $USER_NAME on $(hostname) =="
  echo "passwordless sudo: $SUDO_NOPASS"
  echo "--- privilege summary ---"
  printf '%s\n' "$SUDO_LIST" | grep -E '^\s+\(' | sed 's/^/  /' || true
  echo "--- warnings (${#warns[@]}) ---"
  for w in "${warns[@]}"; do echo "  WARN: $w"; done
  echo "--- blockers (${#blockers[@]}) ---"
  for b in "${blockers[@]}"; do echo "  BLOCKER: $b"; done
fi

[ "${#blockers[@]}" -eq 0 ]
