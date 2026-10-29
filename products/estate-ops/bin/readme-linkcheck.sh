#!/usr/bin/env bash
# readme-linkcheck.sh — permanent, re-runnable README link checker for the estate.
#
# Scans every README (and the fleet knowledgebase) in a repo for Markdown links
# and verifies each one:
#   - relative paths resolve from the linking file (with #anchor checks in .md targets)
#   - #anchors exist as headings in the same file (GitHub slug rules)
#   - absolute /home/toxic/* and /home/hatch/* estate paths exist on this box
#     (set README_LINKCHECK_BOX=hatch|yote to skip the other box's paths)
#   - github.com/toxicwind/estate-scripts-projects blob/tree links resolve via
#     `git cat-file` against the local clone (no network needed); #L12-L31
#     line anchors are verified against the real line count
#   - other http(s) URLs are checked only with --check-external (warnings unless
#     --strict-external); skipped otherwise
#
# Submodule-aware: discovers registered submodules and checks each one inside
# its own repo root, so relative links resolve correctly per repo.
#
# Paths containing /vendor/, /scratch/, or /archive/ are excluded by default (third-party
# vendored docs, transient staging, and historical snapshots — not maintained estate docs); add more
# with --exclude SUBSTR (repeatable).
#
# Usage:
#   readme-linkcheck.sh [--root DIR] [--extra a.md,b.md] [--exclude SUBSTR]
#                       [--check-external] [--strict-external]
#
# Run it against the LIVE working tree (default: the git toplevel of your cwd),
# not a fresh `git worktree add` checkout: live untracked project directories
# (guidellm/, nim-repos/, ...) are part of the estate and only exist in the
# live tree. A bare worktree produces false "missing dir" failures for them.
#
# Exit 0 when every checkable link resolves; exit 1 with a per-link report
# (file:line [target] reason) otherwise. Warnings never fail the run.
#
# Owned by codex (readme-deconfusion lane). Re-run after any README edit.

set -u
exec python3 - "$@" <<'PYEOF'
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

ROOT_ARG = None
EXTRA = ["docs/fleet-knowledgebase.md"]
# Default-excluded: third-party vendored trees, transient scratch dirs, and
# historical archive snapshots are not maintained estate docs; their links rot
# upstream or are frozen history, and are not ours to fix.
DEFAULT_EXCLUDES = ["/vendor/", "/scratch/", "/archive/"]
EXCLUDES = []
CHECK_EXTERNAL = False
STRICT_EXTERNAL = False
BOX = os.environ.get("README_LINKCHECK_BOX", "").strip()

argv = sys.argv[1:]
i = 0
while i < len(argv):
    a = argv[i]
    if a == "--root" and i + 1 < len(argv):
        ROOT_ARG = argv[i + 1]; i += 2
    elif a == "--extra" and i + 1 < len(argv):
        EXTRA += argv[i + 1].split(","); i += 2
    elif a == "--exclude" and i + 1 < len(argv):
        EXCLUDES.append(argv[i + 1]); i += 2
    elif a == "--check-external":
        CHECK_EXTERNAL = True; i += 1
    elif a == "--strict-external":
        CHECK_EXTERNAL = True; STRICT_EXTERNAL = True; i += 1
    else:
        print(f"unknown arg: {a}", file=sys.stderr); sys.exit(2)


def sh(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


def repo_root(start):
    r = sh("git", "rev-parse", "--show-toplevel", cwd=start)
    return r.stdout.strip() if r.returncode == 0 else None


def submodule_roots(root):
    roots = []
    r = sh("git", "-C", root, "submodule", "status")
    if r.returncode == 0:
        for line in r.stdout.splitlines():
            parts = line.strip().split()
            if len(parts) >= 2:
                p = os.path.join(root, parts[1])
                if os.path.isdir(p):
                    roots.append(p)
    return roots


def slugify(title):
    title = re.sub(r"<[^>]+>", "", title)          # strip html tags
    title = title.strip().lower()
    title = re.sub(r"[^\w\s\-]", "", title, flags=re.UNICODE)
    title = re.sub(r"[\s]+", "-", title)
    return title


def heading_slugs(text):
    slugs = {}
    seen = {}
    for m in re.finditer(r"^(#{1,6})\s+(.+?)\s*#*\s*$", text, re.M):
        title = m.group(2)
        title = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", title)  # [t](u) -> t
        title = re.sub(r"`([^`]*)`", r"\1", title)              # `c` -> c
        s = slugify(title)
        n = seen.get(s, 0)
        key = s if n == 0 else f"{s}-{n}"
        seen[s] = n + 1
        slugs[key] = True
    return slugs


INLINE = re.compile(r"!?\[([^\]]*)\]\(\s*(<[^>\s]+>|(?:[^()\s]|\([^()]*\))+)(?:\s+\"[^\"]*\")?\)")
REFDEF = re.compile(r"^\s{0,3}\[([^\]]+)\]:\s*(\S+)", re.M)
REFUSE = re.compile(r"\[([^\]]+)\]\[([^\]]*)\]")
BARE = re.compile(r"https?://[^\s<>\")\]]+")


def extract_links(text):
    """Yield (lineno, target), deduplicated."""
    defs = {k.lower(): v for k, v in REFDEF.findall(text)}
    seen = set()
    def emit(lineno, target):
        key = (lineno, target)
        if key not in seen:
            seen.add(key)
            return [(lineno, target)]
        return []

    out = []
    spans = []
    for m in INLINE.finditer(text):
        lineno = text.count("\n", 0, m.start()) + 1
        spans.append(m.span())
        out += emit(lineno, m.group(2))
    for m in REFUSE.finditer(text):
        if any(s <= m.start() < e for s, e in spans):
            continue
        lineno = text.count("\n", 0, m.start()) + 1
        ref = m.group(2) or m.group(1)
        if ref.lower() in defs:
            out += emit(lineno, defs[ref.lower()])
        else:
            out += emit(lineno, f"!UNDEFINED-REF:[{ref}]")
    for m in BARE.finditer(text):
        if any(s <= m.start() < e for s, e in spans):
            continue
        lineno = text.count("\n", 0, m.start()) + 1
        url = m.group(0).rstrip(".,;:")
        out += emit(lineno, url)
    return out


class Checker:
    def __init__(self, root):
        self.root = root
        self.failures = []
        self.warnings = []
        self.checked = 0
        self._slugs = {}

    def rel(self, p):
        return os.path.relpath(p, self.root)

    def slugs_for(self, path):
        if path not in self._slugs:
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    self._slugs[path] = heading_slugs(f.read())
            except OSError:
                self._slugs[path] = {}
        return self._slugs[path]

    def fail(self, src, lineno, target, reason):
        self.failures.append(f"{self.rel(src)}:{lineno}: [{target}] {reason}")

    def warn(self, src, lineno, target, reason):
        self.warnings.append(f"{self.rel(src)}:{lineno}: [{target}] {reason}")

    # ---- target checks: return None=ok, "SKIP", or "FAIL:reason"/"WARN:reason"

    def check_anchor(self, slugs, frag):
        frag = urllib.parse.unquote(frag)
        if not frag:
            return None
        if frag not in slugs:
            return f"FAIL:anchor '#{frag}' not found"
        return None

    def resolve_ref(self, root, ref):
        # GitHub blob/<ref> URLs name the REMOTE branch; the local tracking ref
        # is authoritative. A local branch of the same name may be stale or
        # divergent (e.g. a worktree whose main never moves), so prefer
        # origin/<ref> and fall back to the local name.
        for cand in (f"origin/{ref}", ref):
            if sh("git", "-C", root, "rev-parse", "--verify", "--quiet",
                   cand).returncode == 0:
                return cand
        return None

    def check_github_sp(self, target, root):
        # github.com/toxicwind/estate-scripts-projects/(blob|tree)/<ref>/<path>[#frag]
        m = re.match(
            r"https://github\.com/toxicwind/estate-scripts-projects/(blob|tree)/([^/]+)/([^#]+)(?:#(.+))?$",
            target)
        if not m:
            return "EXTERNAL"
        kind, ref, path = m.group(1), m.group(2), m.group(3)
        frag = m.group(4) or ""
        path = urllib.parse.unquote(path)
        resolved = self.resolve_ref(root, ref)
        if not resolved:
            return f"FAIL:ref '{ref}' not present in local clone (fetch first?)"
        ref = resolved
        r = sh("git", "-C", root, "cat-file", "-t", f"{ref}:{path}")
        if r.returncode != 0:
            return f"FAIL:path '{path}' not in {ref}"
        otype = r.stdout.strip()
        if kind == "tree" and otype not in ("tree", "commit"):
            return f"FAIL:'{path}' is a {otype}, not a directory"
        if kind == "blob" and otype != "blob":
            return f"FAIL:'{path}' is a {otype}, not a file"
        if frag and kind == "blob":
            lm = re.match(r"L(\d+)(?:-L(\d+))?$", frag)
            if lm:
                r2 = sh("git", "-C", root, "cat-file", "-p", f"{ref}:{path}")
                nlines = r2.stdout.count("\n") + (0 if r2.stdout.endswith("\n") else 1)
                lo, hi = int(lm.group(1)), int(lm.group(2) or lm.group(1))
                if lo > nlines:
                    return f"FAIL:line anchor L{lo} beyond EOF ({nlines} lines in {ref}:{path})"
            elif frag not in self.slugs_for_blob(root, ref, path):
                return f"FAIL:anchor '#{frag}' not found in {ref}:{path}"
        return None

    def slugs_for_blob(self, root, ref, path):
        key = f"{root}\0{ref}:{path}"
        if key not in self._slugs:
            r = sh("git", "-C", root, "cat-file", "-p", f"{ref}:{path}")
            self._slugs[key] = heading_slugs(r.stdout) if r.returncode == 0 else {}
        return self._slugs[key]

    def check_external(self, url):
        if not CHECK_EXTERNAL:
            return "SKIP"
        try:
            req = urllib.request.Request(
                url, method="HEAD", headers={"User-Agent": "readme-linkcheck/1.0"})
            with urllib.request.urlopen(req, timeout=10) as r:
                if r.status >= 400:
                    raise IOError(f"HTTP {r.status}")
            return None
        except Exception as e:
            msg = f"external URL unreachable: {e}"
            return f"FAIL:{msg}" if STRICT_EXTERNAL else f"WARN:{msg}"

    def check_abs(self, target):
        path = target.split("#")[0].split("?")[0]
        if BOX in ("hatch", "yote"):
            other = "hatch" if BOX == "yote" else "yote"
            if path == f"/home/{other}" or path.startswith(f"/home/{other}/"):
                return "SKIP"
        if not os.path.exists(path):
            return f"FAIL:absolute path '{path}' not found on this box"
        return None

    def check_target(self, target, src, src_dir):
        if target.startswith("<") and target.endswith(">"):
            target = target[1:-1]
        if target.startswith("!UNDEFINED-REF:"):
            return f"FAIL:undefined reference {target[16:]}"
        if not target or target.startswith("mailto:"):
            return "SKIP"
        if target.startswith("#"):
            return self.check_anchor(self.slugs_for(src), target[1:])
        if re.match(r"https?://", target):
            gh = self.check_github_sp(target, self.root)
            if gh != "EXTERNAL":
                return gh
            return self.check_external(target)
        if re.match(r"[a-zA-Z][a-zA-Z0-9+.\-]*:", target):
            return "SKIP"
        if target.startswith("/"):
            return self.check_abs(target)
        # relative path, maybe with #fragment
        path, _, frag = target.partition("#")
        p = os.path.normpath(os.path.join(src_dir, urllib.parse.unquote(path)))
        if not os.path.exists(p):
            return f"FAIL:relative path '{target}' does not resolve from {self.rel(src_dir)}/"
        if frag and p.lower().endswith(".md"):
            return self.check_anchor(self.slugs_for(p), frag)
        return None

    def check_file(self, path):
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError as e:
            self.fail(path, 0, "", f"cannot read: {e}")
            return
        self.slugs_for(path)
        src_dir = os.path.dirname(path)
        for lineno, target in extract_links(text):
            self.checked += 1
            res = self.check_target(target, path, src_dir)
            if res is None or res == "SKIP":
                continue
            if res.startswith("FAIL:"):
                self.fail(path, lineno, target, res[5:])
            elif res.startswith("WARN:"):
                self.warn(path, lineno, target, res[5:])

    def discover(self):
        files = set()
        for extra in ([], ["--others", "--exclude-standard"]):
            r = sh("git", "-C", self.root, "ls-files", *extra)
            if r.returncode != 0:
                continue
            for line in r.stdout.splitlines():
                p = line.strip()
                if not p.lower().endswith(".md"):
                    continue
                base = os.path.basename(p)
                if base.upper().startswith("README") or p in EXTRA:
                    files.add(os.path.join(self.root, p))
        for e in EXTRA:
            p = os.path.join(self.root, e)
            if os.path.isfile(p):
                files.add(p)
        return sorted(f for f in files
                      if not any(x in f for x in EXCLUDES + DEFAULT_EXCLUDES)
                      and os.path.isfile(f))

    def run(self):
        for f in self.discover():
            self.check_file(f)
        return self


def main():
    start = os.path.abspath(ROOT_ARG or os.getcwd())
    main_root = repo_root(start)
    if not main_root:
        print(f"not inside a git repo: {start}", file=sys.stderr)
        return 2
    roots = [main_root] + submodule_roots(main_root)
    total_checked = 0
    all_failures = []
    all_warnings = []
    for root in roots:
        c = Checker(root).run()
        total_checked += c.checked
        all_failures += c.failures
        all_warnings += c.warnings
    # Belt-and-braces: identical findings collapse even if a file is ever
    # discovered twice (tracked + untracked, nested roots, etc.).
    all_failures = sorted(set(all_failures))
    all_warnings = sorted(set(all_warnings))
    print(f"readme-linkcheck: {total_checked} links checked across {len(roots)} repo root(s)")
    for w in all_warnings:
        print(f"  WARN {w}")
    if all_failures:
        print(f"  {len(all_failures)} BROKEN:")
        for f in all_failures:
            print(f"  FAIL {f}")
        return 1
    print("  OK — all checkable links resolve")
    return 0


sys.exit(main())
PYEOF
