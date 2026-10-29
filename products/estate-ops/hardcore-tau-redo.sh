#!/usr/bin/env bash
set -euo pipefail

SOV=/home/toxic/estate
STOCK="$SOV/projects/range/ranch/tau"
OLD="$SOV/projects/tau"
LAUNCHER="$STOCK/launcher/tau"
BIN="$SOV/bin"
TAU_HOME="/home/toxic"

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
ok()   { echo -e "  ${G}✓${N} $1"; }
warn() { echo -e "  ${Y}⚠${N} $1"; }
err()  { echo -e "  ${R}✗${N} $1"; }
hdr()  { echo -e "\n${C}=== $1 ===${N}"; }

# ─────────────────────────────────────────────────────────────────────
hdr "1. Back up current state"

mkdir -p "$STOCK/launcher"
[ -f "$LAUNCHER" ] && cp "$LAUNCHER" "$LAUNCHER.bak.$(date +%s)" && ok "backed up launcher"
[ -L "$BIN/tau" ] && cp -P "$BIN/tau" "/tmp/bin-tau.symlink.bak" && ok "backed up bin/tau symlink"
[ -L "$BIN/omp" ] && cp -P "$BIN/omp" "/tmp/bin-omp.symlink.bak" && ok "backed up bin/omp symlink"

# ─────────────────────────────────────────────────────────────────────
hdr "2. Write canonical launcher (stockyard-first)"

cat > "$LAUNCHER" <<'TAU_EOF'
#!/usr/bin/env bash
# Tau Launcher — modular, multi-user, multi-LLM
#
# Canonical engine: estate/projects/range/ranch/tau
# Collapse chain (first hit wins):
#   1. $TAU_BIN (explicit override)
#   2. Installed `tau` on PATH (not this script — avoids recursion)
#   3. ./tau in current directory (local project override; regular file only)
#   4. Full compiled binary: <engine>/packages/coding-agent/dist/tau
#   5. Fallback binary:      <engine>/packages/coding-agent/dist/tau
#   6. Source mode: bun run <engine>/packages/coding-agent/src/cli.ts
#
# Launcher-native subcommands:
#   tau vendor {update|status|promote|build}   upstream patch workflow
#   tau audit                                  hyper-fix audit
#   tau tmux ...                               tmux session management
#   tau --check                                print resolution chain, exit 0
#   tau --help                                 this header
#
# Profiles: $TAU_HOME/.tau/profiles/<name>.yml
# Locking: flock on $TAU_HOME/.tau/.launcher.lock

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── HOME resolution (multi-user aware) ────────────────────────────────
resolve_home() {
    local h="${HOME:-}"
    if [ -n "$h" ] && [ -d "$h/.tau" ]; then printf '%s' "$h"; return; fi
    local user_home
    user_home="$(getent passwd "${USER:-$(id -un)}" 2>/dev/null | cut -d: -f6)"
    if [ -n "$user_home" ] && [ -d "$user_home" ]; then printf '%s' "$user_home"; return; fi
    printf '%s' "${h:-/home/toxic}"
}
TAU_HOME="$(resolve_home)"
export TAU_HOME

TAU_DIR="$TAU_HOME/.tau"
PROFILES_DIR="$TAU_DIR/profiles"
LOCK_FILE="$TAU_DIR/.launcher.lock"
CURRENT_SCHEMA=2

mkdir -p "$PROFILES_DIR"

# ── Secrets (per-user, silent if missing) ─────────────────────────────
set +u
[ -f "$TAU_HOME/.secrets" ] && { set -a; . "$TAU_HOME/.secrets" >/dev/null 2>&1; set +a; }
[ -f "$TAU_HOME/.config/claude/env" ] && { set -a; . "$TAU_HOME/.config/claude/env" >/dev/null 2>&1; set +a; }
set -u

# PI_CONFIG_DIR stays bare: engine joins onto homedir internally.
export PI_CONFIG_DIR=".tau"

# ── Engine resolution (stockyard is canonical) ────────────────────────
ESTATE_DIR="$TAU_HOME/estate"

resolve_engine() {
    local candidates=(
        "$ESTATE_DIR/projects/range/ranch/tau"
        "$ESTATE_DIR/projects/tau/engine"
        "$ESTATE_DIR/tau/engine"
    )
    for c in "${candidates[@]}"; do
        if [ -d "$c/packages/coding-agent" ]; then
            printf '%s' "$c"
            return
        fi
    done
}

ENGINE_DIR="$(resolve_engine || true)"
if [ -z "${ENGINE_DIR:-}" ]; then
    echo "tau: no engine found. Checked:" >&2
    echo "  $ESTATE_DIR/projects/range/ranch/tau" >&2
    echo "  $ESTATE_DIR/projects/tau/engine" >&2
    echo "  $ESTATE_DIR/tau/engine" >&2
    exit 1
fi
export ENGINE_DIR

# Binary priority: dist/tau > dist/tau. Source mode is the last resort.
DIST_TAU="$ENGINE_DIR/packages/coding-agent/dist/tau"
DIST_OMP="$ENGINE_DIR/packages/coding-agent/dist/tau"
ENGINE_ENTRY="$ENGINE_DIR/packages/coding-agent/src/cli.ts"

# ── Profile handling ──────────────────────────────────────────────────
TAU_PROFILE="${TAU_PROFILE:-default}"
if [ "${1:-}" = "--profile" ] && [ -n "${2:-}" ]; then
    TAU_PROFILE="$2"
    shift 2
fi

# Read schema version without rg
read_yaml_scalar() {
    local file="$1" key="$2"
    grep -E "^[[:space:]]*${key}:" "$file" 2>/dev/null | head -1 \
        | sed -E "s/^[[:space:]]*${key}:[[:space:]]*//" | awk '{print $1}' || true
}

migrate_profile() {
    local profile_file="$1"
    local version
    version="$(read_yaml_scalar "$profile_file" schema_version)"
    version="${version:-1}"

    if [ "$version" -lt "$CURRENT_SCHEMA" ]; then
        if [ "$version" -eq 1 ]; then
            if ! grep -q '^llm:' "$profile_file" 2>/dev/null; then
                printf '\nllm:\n  backend: auto\n' >> "$profile_file"
            elif ! grep -qE '^[[:space:]]+backend:' "$profile_file" 2>/dev/null; then
                printf 'llm:\n  backend: auto\n' >> "$profile_file"
            fi
            if grep -q '^schema_version:' "$profile_file" 2>/dev/null; then
                sed -i 's/^schema_version:[[:space:]]*[0-9]*/schema_version: 2/' "$profile_file"
            else
                printf 'schema_version: 2\n' >> "$profile_file"
            fi
        fi
    fi
}

load_profile() {
    local profile_file="$PROFILES_DIR/$TAU_PROFILE.yml"
    if [ ! -f "$profile_file" ]; then
        cat > "$profile_file" <<'PROFILE_EOF'
schema_version: 2
# LLM backend: auto | anthropic | openai | kimi | ollama
llm:
  backend: auto
  model: null
engine:
  args: []
PROFILE_EOF
    fi

    (
        flock -w 10 200 || { echo "tau: could not acquire profile lock" >&2; exit 1; }
        migrate_profile "$profile_file"
    ) 200>"$LOCK_FILE"

    local backend model
    backend="$(read_yaml_scalar "$profile_file" backend)"
    backend="${backend:-auto}"
    export TAU_LLM_BACKEND="$backend"

    model="$(grep -E '^[[:space:]]*model:' "$profile_file" 2>/dev/null | head -1 \
        | sed -E 's/^[[:space:]]*model:[[:space:]]*//' | awk '{print $1}' || true)"
    if [ -n "$model" ] && [ "$model" != "null" ]; then
        export TAU_LLM_MODEL="$model"
    fi
}

# Skip profile for pure resolution/info subcommands
case "${1:-}" in
    --check|--help|-h|--version|-V) : ;;
    *) load_profile ;;
esac

# ── Vendor workflow ───────────────────────────────────────────────────
vendor_cmd() {
    local subcmd="${1:-}"
    local ROOT="$ENGINE_DIR"
    local UPSTREAM_DIR="$ROOT/upstream-changes"
    local SCRIPTS_DIR="$UPSTREAM_DIR/scripts"

    case "$subcmd" in
        update|fetch|ingest)
            [ -x "$SCRIPTS_DIR/ingest.sh" ] || { echo "tau vendor: $SCRIPTS_DIR/ingest.sh missing" >&2; exit 1; }
            "$SCRIPTS_DIR/ingest.sh"
            ;;
        status)
            [ -x "$SCRIPTS_DIR/status.sh" ] || { echo "tau vendor: $SCRIPTS_DIR/status.sh missing" >&2; exit 1; }
            "$SCRIPTS_DIR/status.sh"
            ;;
        promote)
            local patch="${2:-}"
            [ -n "$patch" ] || { echo "Usage: tau vendor promote <patches/*.patch>"; exit 1; }
            [ -x "$SCRIPTS_DIR/promote.sh" ] || { echo "tau vendor: $SCRIPTS_DIR/promote.sh missing" >&2; exit 1; }
            "$SCRIPTS_DIR/promote.sh" "$patch"
            ;;
        build)
            echo "Building coding-agent binary in $ROOT..."
            ( cd "$ROOT/packages/coding-agent" && bun run scripts/build-binary.ts )
            ;;
        *)
            cat <<USAGE
Usage: tau vendor {update|status|promote|build}
  update   - Fetch upstream changes and generate patches
  status   - Show pending patches and upstream status
  promote  - Apply a patch (tau vendor promote <patch>)
  build    - Build the coding-agent binary
USAGE
            exit 1
            ;;
    esac
}

# ── Resolution info ───────────────────────────────────────────────────
print_resolution() {
    echo "tau launcher resolution:"
    echo "  TAU_HOME        = $TAU_HOME"
    echo "  ESTATE_DIR   = $ESTATE_DIR"
    echo "  ENGINE_DIR      = $ENGINE_DIR"
    echo "  DIST_TAU        = $DIST_TAU$([ -x "$DIST_TAU" ] && echo ' [ok]' || echo ' [missing]')"
    echo "  DIST_OMP        = $DIST_OMP$([ -x "$DIST_OMP" ] && echo ' [ok]' || echo ' [missing]')"
    echo "  ENGINE_ENTRY    = $ENGINE_ENTRY$([ -f "$ENGINE_ENTRY" ] && echo ' [ok]' || echo ' [missing]')"
    echo "  TAU_BIN (env)   = ${TAU_BIN:-<unset>}"
    echo "  PATH tau        = $(command -v tau 2>/dev/null || echo '<none>')"
    echo "  bun             = $(command -v bun 2>/dev/null || echo '<none>')"
    echo "  profile         = ${TAU_PROFILE:-default}"
    echo "  TAU_LLM_BACKEND = ${TAU_LLM_BACKEND:-<unset>}"
    echo "  TAU_LLM_MODEL   = ${TAU_LLM_MODEL:-<unset>}"
}

# ── Collapse chain ────────────────────────────────────────────────────
launch() {
    case "${1:-}" in
        --check)
            print_resolution
            [ -x "$DIST_TAU" ] || [ -x "$DIST_OMP" ] || [ -f "$ENGINE_ENTRY" ] || exit 1
            exit 0
            ;;
        --help|-h)
            sed -n '2,26p' "$0"
            exit 0
            ;;
        --version|-V)
            if [ -x "$DIST_TAU" ]; then exec "$DIST_TAU" --version; fi
            if [ -x "$DIST_OMP" ]; then exec "$DIST_OMP" --version; fi
            echo "tau launcher (no engine binary)"
            exit 0
            ;;
        vendor)
            vendor_cmd "${2:-}"
            return
            ;;
        audit)
            shift
            if [ -x "$SCRIPT_DIR/tau-audit.sh" ]; then exec "$SCRIPT_DIR/tau-audit.sh" "$@"
            else echo "tau: tau-audit.sh not found beside $0" >&2; exit 1; fi
            ;;
        tmux)
            shift
            if [ -x "$SCRIPT_DIR/tau-tmux.sh" ]; then exec "$SCRIPT_DIR/tau-tmux.sh" "$@"
            else echo "tau: tau-tmux.sh not found beside $0" >&2; exit 1; fi
            ;;
    esac

    # 1. Explicit override
    if [ -n "${TAU_BIN:-}" ] && [ -x "$TAU_BIN" ]; then exec "$TAU_BIN" "$@"; fi

    # 2. PATH tau (avoid recursion)
    local path_tau
    path_tau="$(command -v tau 2>/dev/null || true)"
    if [ -n "$path_tau" ] && [ "$path_tau" != "$0" ] && [ -x "$path_tau" ]; then
        if ! grep -q "Tau Launcher" "$path_tau" 2>/dev/null; then
            exec "$path_tau" "$@"
        fi
    fi

    # 3. Local ./tau (regular file, not this script)
    if [ -f "./tau" ] && [ -x "./tau" ]; then
        if [ "$(realpath ./tau 2>/dev/null)" != "$(realpath "$0" 2>/dev/null)" ]; then
            exec ./tau "$@"
        fi
    fi

    # 4. Compiled binary: tau first, then omp
    if [ -x "$DIST_TAU" ]; then exec "$DIST_TAU" "$@"; fi
    if [ -x "$DIST_OMP" ]; then exec "$DIST_OMP" "$@"; fi

    # 5. Source fallback
    if [ -f "$ENGINE_ENTRY" ] && command -v bun >/dev/null 2>&1; then
        exec bun run "$ENGINE_ENTRY" "$@"
    fi

    echo "tau: no launch target found" >&2
    echo "  TAU_BIN      = ${TAU_BIN:-<unset>}" >&2
    echo "  PATH tau     = ${path_tau:-<none>}" >&2
    echo "  DIST_TAU     = $DIST_TAU" >&2
    echo "  DIST_OMP     = $DIST_OMP" >&2
    echo "  ENGINE_ENTRY = $ENGINE_ENTRY" >&2
    echo "  bun          = $(command -v bun 2>/dev/null || echo missing)" >&2
    exit 1
}

launch "$@"
TAU_EOF

chmod +x "$LAUNCHER"
ok "wrote $LAUNCHER"

bash -n "$LAUNCHER"
ok "launcher syntax OK"

# ─────────────────────────────────────────────────────────────────────
hdr "3. Fix bin/tau and bin/omp"

ln -sfn "$LAUNCHER" "$BIN/tau"
ok "bin/tau -> $LAUNCHER"

if [ -x "$STOCK/packages/coding-agent/dist/tau" ]; then
    ln -sfn "$STOCK/packages/coding-agent/dist/tau" "$BIN/omp"
    ok "bin/omp -> $STOCK/packages/coding-agent/dist/tau"
elif [ -x "$STOCK/packages/coding-agent/dist/tau" ]; then
    ln -sfn "$STOCK/packages/coding-agent/dist/tau" "$BIN/omp"
    ok "bin/omp -> $STOCK/packages/coding-agent/dist/tau"
fi

# ─────────────────────────────────────────────────────────────────────
hdr "4. Helper scripts (audit, tmux)"

for helper in tau-audit.sh tau-tmux.sh; do
    found=""
    for c in "$OLD/launcher/$helper" \
             /home/toxic/edge-work/estate-projects/projects/tau/launcher/$helper \
             /home/toxic/oracle-hardening-wt/projects/tau/launcher/$helper; do
        [ -f "$c" ] && found="$c" && break
    done
    if [ -n "$found" ]; then
        cp "$found" "$STOCK/launcher/$helper"
        chmod +x "$STOCK/launcher/$helper"
        ok "installed $STOCK/launcher/$helper (from $found)"
    else
        warn "no $helper found anywhere — tau $helper will error until provided"
    fi
done

# ─────────────────────────────────────────────────────────────────────
hdr "5. Kill orphaned processes from projects/tau"

KILLED=0
for pid in $(pgrep -f 'projects/tau/' 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    cmd="$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 120)"
    warn "killing pid $pid: $cmd"
    kill -TERM "$pid" 2>/dev/null || true
    KILLED=$((KILLED + 1))
done
sleep 1
for pid in $(pgrep -f 'projects/tau/' 2>/dev/null); do
    kill -KILL "$pid" 2>/dev/null || true
done
[ "$KILLED" -eq 0 ] && ok "no orphans" || ok "killed $KILLED"

# ─────────────────────────────────────────────────────────────────────
hdr "6. Verify resolution chain"

"$BIN/tau" --check

echo
echo "  --- --version ---"
"$BIN/tau" --version

echo
echo "  --- --help (first 10 lines) ---"
"$BIN/tau" --help 2>&1 | head -10

# ─────────────────────────────────────────────────────────────────────
hdr "7. Cross-check with the running daemon"

echo "  chute pid: $(ss -tlnpH '( sport = :25111 )' 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)"
echo "  chute cmdline:"
for pid in $(pgrep -f 'chute.*25111' 2>/dev/null); do
    echo "    pid $pid: $(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | head -c 200)"
done

echo
echo "  pitchfork tau registration:"
cd "$SOV" && pitchfork list --json 2>/dev/null | jq -r '.[] | select(.id|test("tau")) | "    \(.id) status=\(.status) port=\(.port // "none")"' || true

# ─────────────────────────────────────────────────────────────────────
hdr "8. Symlink inventory"

echo "  bin/tau:"
ls -la "$BIN/tau"
echo "  bin/omp:"
ls -la "$BIN/omp"

hdr "DONE"
echo "  launcher : $LAUNCHER"
echo "  engine   : $STOCK"
echo "  binary   : $STOCK/packages/coding-agent/dist/tau"
echo "  rerun    : bash $BIN/hardcore-tau-redo.sh"
