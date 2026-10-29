#!/bin/sh
# push-guard.sh -- fast-fail pre-push / CI pre-flight guard for Go repos.
#
# Four checks, in order; the first failure wins and prints the exact error:
#   0. secret scan        -- gitleaks (official 222-rule config) over each push
#                            range (merge-base..head), staged diff in worktree
#                            mode, worktree scan for new branches. Backstop for
#                            the 2026-09-17 hodos key-pool leak (29 GitHub
#                            secret-scanning alerts from committed API keys).
#                            Prints only the file name, never the match
#                            (gitleaks --redact). Reviewed paths stay approved
#                            in the ignore memory (~/.config/push-guard/ignore);
#                            `push-guard.sh ignore <path>...` records them.
#   1. git diff --check   -- conflict markers (<<<<<<< ======= >>>>>>>) + whitespace
#                            errors, filtered: trailing whitespace is NOT an error
#                            in prose files or on whitespace-only lines. See the
#                            filter_check1 comment for the full reasoning.
#   2. gofmt (exact)      -- Go parse errors AND unformatted files. The naive
#                            `gofmt -l . | wc -l` pattern misses parse errors
#                            (gofmt prints them to stderr, exits 2, lists nothing).
#                            This is exactly what broke herd's Linux CI on
#                            2026-09-18 (runs 35400989022 / 35401074912: conflict
#                            markers left in mesh/gateway/astmatrix.go:93-104).
#   3. go vet             -- scoped to changed packages, run per enclosing Go module.
#
# Usage:
#   push-guard.sh pre-push                        # git pre-push hook: ref lines on stdin
#   PUSH_GUARD_RANGE='base...head' push-guard.sh  # CI / explicit range
#   push-guard.sh                                 # worktree mode: staged+unstaged vs HEAD
#   push-guard.sh ignore <path>...              # remember approved paths by hand
#   PUSH_GUARD_IGNORE=/path/to/file ...         # override the ignore memory file
#   PUSH_GUARD_SKIP=1 ...                         # emergency bypass (loud, never silent)
#
# Adopted 2026-09-18, debate d867e8f6. Ignore-memory + placeholder auto-clear 2026-09-21 (Chris: approval is durable).
# Canonical source: toxicwind/sovereign-projects:bin/push-guard.sh (mirrored at tools/push-guard.sh).
# Live fleet copy: /home/toxic/bin/push-guard.sh -- refresh with: install -Dm755 <repo-copy> /home/toxic/bin/push-guard.sh
# Pre-push install one-liner:
#   install -Dm755 /home/toxic/bin/pre-push "$(git rev-parse --git-dir)/hooks/pre-push"

set -eu

ZERO40='0000000000000000000000000000000000000000'
EMPTY_TREE='4b825dc642cb6eb9a060e54bf8d69288fbee4904'

START_MS="$(date +%s%N | cut -c1-13)"
log()  { printf 'push-guard: %s\n' "$*"; }
fail() { printf 'push-guard: FAIL: %s\n' "$*" >&2; exit 1; }
now_ms() { date +%s%N | cut -c1-13; }

# --- emergency override: loud, never silent ---------------------------------
if [ "${PUSH_GUARD_SKIP:-0}" = "1" ]; then
    log 'BYPASSED via PUSH_GUARD_SKIP=1 -- proceeding UNGUARDED (this line is the audit trail)'
    exit 0
fi

command -v git >/dev/null 2>&1 || fail 'git not found on PATH'
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail 'not inside a git work tree'
cd "$ROOT"

TMPD="$(mktemp -d)" || fail 'mktemp failed'
trap 'rm -rf "$TMPD"' EXIT INT TERM
RANGES="$TMPD/ranges"; FILES="$TMPD/files"; GOFILES="$TMPD/gofiles"; PKGS="$TMPD/pkgs"; UNTRACKED="$TMPD/untracked"
: > "$RANGES"; : > "$FILES"; : > "$GOFILES"; : > "$PKGS"; : > "$UNTRACKED"

# --- durable ignore memory ---------------------------------------------------
# Reviewed/approved paths live in ${PUSH_GUARD_IGNORE:-$HOME/.config/push-guard/ignore}
# (one repo-relative path per line; '#' comments and blanks ignored). An entry
# matches a changed file exactly, or as a trailing path suffix ("/<entry>"),
# so entries survive repo-root renames. `push-guard.sh ignore <path>...`
# remembers paths by hand; the gitleaks secret scan skips remembered paths.
# Chris 2026-09-21: approval is durable, the guard remembers -- it survives
# reboots because it lives in a real file.
IGNORE_FILE="${PUSH_GUARD_IGNORE:-$HOME/.config/push-guard/ignore}"
mkdir -p "$(dirname "$IGNORE_FILE")" 2>/dev/null || true
[ -f "$IGNORE_FILE" ] || : > "$IGNORE_FILE" || true
is_ignored() { # $1 = repo-relative path -> 0 if remembered
    p="$1"
    [ -f "$IGNORE_FILE" ] || return 1
    while IFS= read -r raw || [ -n "$raw" ]; do
        pat="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
        case "$pat" in ''|\#*) continue ;; esac
        case "$p" in "$pat"|*/"$pat") return 0 ;; esac
    done < "$IGNORE_FILE"
    return 1
}
remember_ignore() { # $1 = repo-relative path; append once
    p="$1"
    is_ignored "$p" && return 0
    printf '%s\n' "$p" >> "$IGNORE_FILE"
    log "ignore memory: remembered $p"
}

add_range() { printf '%s\n' "$1" >> "$RANGES"; }

norm_range() { # $1 = "base...head" | "base..head" | single rev -> normalized "base...head"
    spec="$1"
    case "$spec" in
        *...*)
            base="${spec%%...*}"; head="${spec##*...}" ;;
        *..*)
            base="${spec%%..*}"; head="${spec##*..}" ;;
        *)
            head="$spec"
            if git rev-parse --verify --quiet "$spec^" >/dev/null 2>&1; then
                base="$spec^"
            else
                base="$EMPTY_TREE"
            fi ;;
    esac
    [ "$base" = "$ZERO40" ] && base="$EMPTY_TREE"
    if [ "$base" = "$EMPTY_TREE" ]; then
        # empty tree is not a commit: three-dot symmetric difference fails;
        # two-dot direct diff against the empty tree is exact for new branches.
        printf '%s..%s' "$base" "$head"
    else
        printf '%s...%s' "$base" "$head"
    fi
}

# --- collect change ranges ---------------------------------------------------
MODE="${1:-range}"
if [ "$MODE" = "ignore" ]; then
    # remember approved paths by hand: push-guard.sh ignore <path>...
    shift
    [ "$#" -gt 0 ] || fail 'usage: push-guard.sh ignore <repo-relative-path> [...]'
    for p in "$@"; do
        case "$p" in ./*) p="${p#./}" ;; esac
        remember_ignore "$p"
    done
    log "ignore memory file: $IGNORE_FILE"
    exit 0
elif [ "$MODE" = "pre-push" ]; then
    # git pre-push stdin: "<local ref> <local sha> <remote ref> <remote sha>" per line
    seen=0
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        seen=1
        # word-split the four fields (refnames never contain spaces)
        # shellcheck disable=SC2086
        set -- $line
        local_ref="${1:-?}"; local_sha="${2:-}"; remote_sha="${4:-}"
        [ -z "$local_sha" ] && continue
        if [ "$local_sha" = "$ZERO40" ]; then
            log "ref $local_ref deleted -- nothing to guard"
            continue
        fi
        add_range "$(norm_range "$remote_sha...$local_sha")"
    done
    [ "$seen" -eq 1 ] || { log 'no ref updates on stdin -- nothing to guard'; exit 0; }
elif [ -n "${PUSH_GUARD_RANGE:-}" ]; then
    add_range "$(norm_range "$PUSH_GUARD_RANGE")"
else
    log 'worktree mode: guarding staged + unstaged changes vs HEAD'
fi

# --- check 0: secret scan (gitleaks) -------------------------------------------
# Real secret detection via gitleaks with the official 222-rule config
# ($GITLEAKS_CONFIG, default ~/.config/gitleaks/gitleaks.toml). Replaces the
# old hand-rolled regex, which false-positived on test fixtures and missed
# whole secret families. Backstop for the 2026-09-17 hodos key-pool leak
# (29 GitHub secret-scanning alerts from committed API keys).
# Runs per push range as merge-base..head via `detect --log-opts`; worktree
# mode scans the staged diff via `protect --staged`. New-branch pushes
# (empty-tree base) fall back to a worktree scan -- an over-approximation
# that never misses. Only file names are printed, never match text
# (gitleaks --redact). Reviewed paths stay approved in the durable ignore
# memory (~/.config/push-guard/ignore); `push-guard.sh ignore <path>...`
# records them. A repo-local .gitleaksignore fingerprint baseline is also
# honored by gitleaks automatically. Any other hit refuses the push.
t0="$(now_ms)"
GITLEAKS_BIN="${GITLEAKS_BIN:-gitleaks}"
GITLEAKS_CONFIG="${GITLEAKS_CONFIG:-$HOME/.config/gitleaks/gitleaks.toml}"
command -v "$GITLEAKS_BIN" >/dev/null 2>&1 || fail "secret scan: $GITLEAKS_BIN not found on PATH (override with GITLEAKS_BIN)"
[ -f "$GITLEAKS_CONFIG" ] || fail "secret scan: gitleaks config missing: $GITLEAKS_CONFIG (override with GITLEAKS_CONFIG)"
gl_findings() { # gitleaks args... -> repo-relative file per finding, sorted -u
    rm -f "$TMPD/gl.json"
    "$GITLEAKS_BIN" "$@" --config "$GITLEAKS_CONFIG" --source "$ROOT" \
        --no-banner --redact --report-format json --report-path "$TMPD/gl.json" >/dev/null 2>&1 || true
    [ -s "$TMPD/gl.json" ] || return 0
    grep -o '"File": *"[^"]*"' "$TMPD/gl.json" 2>/dev/null \
        | sed -e 's/^"File": *"//' -e 's/"$//' -e "s|^$ROOT/||" | sort -u
}
: > "$TMPD/glfiles_all"
if [ -s "$RANGES" ]; then
    while IFS= read -r r; do
        [ -z "$r" ] && continue
        case "$r" in
            "$EMPTY_TREE"..*)
                log 'check 0: new-branch range -- worktree scan (over-approximation, never misses)'
                gl_findings detect --no-git >> "$TMPD/glfiles_all" ;;
            *)
                base="${r%%...*}"; tip="${r##*...}"
                mb="$(git merge-base "$base" "$tip" 2>/dev/null || true)"
                [ -n "$mb" ] || mb="$base"
                gl_findings detect --log-opts="$mb..$tip" >> "$TMPD/glfiles_all" ;;
        esac
    done < "$RANGES"
else
    log 'check 0: worktree mode -- scanning staged diff'
    gl_findings protect --staged >> "$TMPD/glfiles_all"
fi
sort -u "$TMPD/glfiles_all" -o "$TMPD/glfiles_all"
SECRET_HITS="$TMPD/secrethits"; : > "$SECRET_HITS"
while IFS= read -r f; do
    [ -z "$f" ] && continue
    if is_ignored "$f"; then
        log "check 0: $f in ignore memory -- skipped"
        continue
    fi
    printf '%s\n' "$f" >> "$SECRET_HITS"
done < "$TMPD/glfiles_all"
if [ -s "$SECRET_HITS" ]; then
    fail "secret scan: possible committed secret -- refusing to push. File(s): $(tr '\n' ' ' < "$SECRET_HITS"). After review, remember them: push-guard.sh ignore <path>..."
fi
log "check 0 (secret scan): PASS ($(( $(now_ms) - t0 )) ms)"
# --- check 1: conflict markers + whitespace errors ---------------------------
# `git diff --check` reports three unrelated things as one undifferentiated
# error class. Treating all of them as fatal made this guard refuse pushes over
# content that is correct, which is worse than a guard that is merely strict.
# The output is therefore filtered below. Two exemptions, both deliberate:
#
#   (a) PROSE FILES (.md/.markdown/.txt) -- trailing whitespace is not an error.
#       In Markdown two trailing spaces ARE a hard line break: they are rendered
#       content, not sloppy spacing. THIRD-PARTY-NOTICES.txt is a plain-text
#       file whose licence blocks are Markdown, so it belongs in this class too.
#       Stripping those spaces to satisfy the check would destroy real
#       formatting in a legal-notice artefact.
#
#   (b) WHITESPACE-ONLY LINES -- a line made only of spaces/tabs is a blank
#       line. There is no content for whitespace to trail after, so "trailing
#       whitespace" does not meaningfully describe it. git reports it anyway.
#
# Conflict markers are NEVER exempt, in any file type. Trailing whitespace on a
# line that does have real content is still an error everywhere outside prose.
#
# This is a refinement of check 1, not a second allowlist. The path-based ignore
# memory (~/.config/push-guard/ignore) is unchanged and remains the right tool
# for a reviewed one-off file. It is deliberately not used for
# THIRD-PARTY-NOTICES.txt: ignoring that path wholesale would also suppress
# conflict markers in it, which is exactly the blanket suppression to avoid.
filter_check1() {
    awk '
        /^[^+ -].*:[0-9]+: / {
            hdr = $0
            path = hdr; sub(/:[0-9]+:.*$/, "", path)
            msg  = hdr; sub(/^.*:[0-9]+: /, "", msg)
            content = ""
            if ((getline content) <= 0) { print hdr; next }
            body = substr(content, 2)          # strip the leading "+"
            keep = 1
            if (msg !~ /conflict marker/) {
                if (path ~ /\.(md|markdown|txt)$/) keep = 0   # (a) prose
                else if (body ~ /^[[:space:]]*$/)   keep = 0   # (b) blank line
            }
            if (keep) { print hdr; print content }
            next
        }
        { print }
    '
}

t0="$(now_ms)"
if [ -s "$RANGES" ]; then
    while IFS= read -r r; do
        [ -z "$r" ] && continue
        # Findings go to stdout; git's own diagnostics ("exhaustive rename
        # detection was skipped...") go to stderr and are NOT findings. Merging
        # them with 2>&1 makes this check fail on a clean tree, because a
        # non-empty stderr alone used to be read as "something was found".
        out="$(git diff --check "$r" -- 2>/dev/null | filter_check1)" || true
        [ -n "$out" ] && fail "conflict markers / whitespace errors in range $r:
$out"
    done < "$RANGES"
else
    out="$(git diff --check -- 2>/dev/null | filter_check1)" || true
    [ -n "$out" ] && fail "conflict markers / whitespace errors (unstaged):
$out"
    out="$(git diff --check --cached -- 2>/dev/null | filter_check1)" || true
    [ -n "$out" ] && fail "conflict markers / whitespace errors (staged):
$out"
    # untracked files are invisible to plain `git diff` -- check each against /dev/null
    git ls-files --others --exclude-standard -z | tr '\0' '\n' > "$UNTRACKED" 2>/dev/null || true
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        out="$(git diff --check --no-index /dev/null "$f" 2>/dev/null | filter_check1)" || true
        [ -n "$out" ] && fail "conflict markers / whitespace errors (untracked: $f):
$out"
    done < "$UNTRACKED"
fi
log "check 1 (git diff --check): PASS ($(( $(now_ms) - t0 )) ms)"

# --- collect changed files ----------------------------------------------------
if [ -s "$RANGES" ]; then
    while IFS= read -r r; do
        [ -z "$r" ] && continue
        git diff --name-only --diff-filter=ACMRT "$r" -- >> "$FILES" 2>/dev/null || true
    done < "$RANGES"
else
    git diff --name-only HEAD -- >> "$FILES" 2>/dev/null || true
    cat "$UNTRACKED" >> "$FILES" 2>/dev/null || true
fi
sort -u "$FILES" -o "$FILES"
grep '\.go$' "$FILES" > "$GOFILES" || true

if [ ! -s "$GOFILES" ]; then
    log 'no Go files changed -- gofmt/go vet skipped'
    log "ALL CHECKS PASS: total $(( $(now_ms) - START_MS )) ms"
    exit 0
fi
log "$(wc -l < "$GOFILES" | tr -d ' ') Go file(s) changed"

# --- check 2: gofmt -- exact (parse errors fail, not just -l output) -----------
t0="$(now_ms)"
if ! command -v gofmt >/dev/null 2>&1; then
    log 'gofmt not found -- Go checks SKIPPED (diff --check above still enforced)'
    log "CHECKS DONE (partial): total $(( $(now_ms) - START_MS )) ms"
    exit 0
fi
set +e
gofmt_out="$(xargs -a "$GOFILES" gofmt -l -- 2>&1)"
gofmt_code=$?
set -e
[ "$gofmt_code" -ne 0 ] && fail "gofmt parse errors (exit $gofmt_code):
$gofmt_out"
[ -n "$gofmt_out" ] && fail "gofmt: these files need formatting:
$gofmt_out"
log "check 2 (gofmt): PASS ($(( $(now_ms) - t0 )) ms)"

# --- check 3: go vet -- scoped to changed packages, run inside each enclosing Go module
# Monorepo fix (2026-09-19): the old code  `go vet <pkgs>` from the repo root,
# so in a monorepo without a root go.mod every pattern failed with
# "directory prefix ... does not contain main module" noise instead of real
# diagnostics. Each changed file is now mapped to its enclosing module (nearest
# go.mod walking up, capped at $ROOT) and vetted there with a module-relative
# package pattern. Files outside any module are reported and skipped.
t0="$(now_ms)"
if ! command -v go >/dev/null 2>&1; then
    log 'go not found -- go vet SKIPPED (diff --check + gofmt above still enforced)'
else
    MODPKGS="$TMPD/modpkgs"   # TAB-separated "moddir<TAB>./relpkg" lines
    : > "$MODPKGS"
    skipped_nomodule=0
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        case "$(dirname "$f")" in .) fdir="$ROOT";; *) fdir="$ROOT/$(dirname "$f")";; esac
        # nearest go.mod walking up from the file's dir, never above $ROOT
        moddir=""
        cur="$fdir"
        while :; do
            if [ -f "$cur/go.mod" ]; then moddir="$cur"; break; fi
            case "$cur" in
                "$ROOT") break ;;
                "$ROOT"/*) cur="$(dirname "$cur")" ;;
                *) break ;;
            esac
        done
        if [ -z "$moddir" ]; then
            log "warning: no enclosing go.mod for $f -- go vet skipped for this file"
            skipped_nomodule=$((skipped_nomodule + 1))
            continue
        fi
        rel="${fdir#$moddir}"   # "" or "/sub/dir"
        rel="${rel#/}"          # "" or "sub/dir"
        case "$rel" in "") p='./';; *) p="./$rel";; esac
        printf '%s\t%s\n' "$moddir" "$p" >> "$MODPKGS"
    done < "$GOFILES"
    sort -u "$MODPKGS" -o "$MODPKGS"
    cut -f1 "$MODPKGS" | sort -u > "$TMPD/moddirs"
    vet_failed=0
    vet_report=""
    while IFS= read -r md; do
        [ -z "$md" ] && continue
        awk -F'	' -v m="$md" '$1 == m { print $2 }' "$MODPKGS" | sort -u > "$TMPD/vetpkgs"
        log "vetting $(tr '\n' ' ' < "$TMPD/vetpkgs")in module $md"
        set +e
        out="$(cd "$md" && xargs -a "$TMPD/vetpkgs" go vet 2>&1)"
        code=$?
        set -e
        if [ "$code" -ne 0 ]; then
            vet_failed=1
            vet_report="${vet_report}--- module $md (exit $code):\n$out\n"
        fi
    done < "$TMPD/moddirs"
    [ "$vet_failed" -ne 0 ] && fail "go vet failed on changed packages:\n$vet_report"
    [ "$skipped_nomodule" -gt 0 ] && log "check 3 note: $skipped_nomodule file(s) outside any Go module were not vetted"
fi
log "check 3 (go vet): PASS ($(( $(now_ms) - t0 )) ms)"

log "ALL CHECKS PASS: total $(( $(now_ms) - START_MS )) ms"
