#!/usr/bin/env python3
"""
manifest-gen.py - Scan the estate bin surface and emit manifest.yaml.

Scans:
  1. ~/.local/bin - ALL entries (the ONE bin surface per plan)
     Symlinks -> links section; regular files -> bins section
  2. Product bin/ dirs - curated CLI entrypoints (from product-bin-dirs.txt)

Output format: matches bin-verify.sh expected schema
  schema, stale_paths, dirs, bins (name/dir/kind/shebang/syntax/notes),
  links (name/target/pens_proximity), archived

Usage:
  python3 manifest-gen.py [manifest_path]
  Default: writes to pens/barn/estate-ops/bin/manifest.yaml
"""

import hashlib
import os
import sys
from datetime import datetime, timezone

HOME = os.path.expanduser("~")
LOCAL_BIN = os.path.join(HOME, ".local/bin")
PENS_ROOT = os.path.join(HOME, "pens")
SOVEREIGN = os.path.join(HOME, "pens", "geode", "skills")  # skills home moved to the geode pen (2026-10-25)
PRODUCT_BIN_LIST = os.path.join(HOME, "pens/barn/estate-ops/product-bin-dirs.txt")

SHEBANG_LANG_MAP = {
    "bash": "bash",
    "sh": "sh",
    "python": "python",
    "python3": "python",
    "bun": "bun",
    "node": "node",
    "ruby": "ruby",
}

# Files excluded from product bin scan
EXCLUDE_NAMES = {
    "manifest-gen.py",
    "manifest-git-hook",
    "product-bin-dirs.txt",
    "frida-compile",
    "claude-react-loop.py.bak-20261019-raccoon-hardening",
}

def _should_exclude(name):
    """Check if a filename should be excluded from bin scanning."""
    if name in EXCLUDE_NAMES:
        return True
    if name.startswith("."):
        return True
    if name.endswith("~"):
        return True
    if name.endswith(".bak"):
        return True
    if ".bak-" in name:
        return True
    return False


def md5sum(path):
    h = hashlib.md5()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def first_shebang(path):
    try:
        with open(path, "rb") as f:
            line = f.readline().decode("utf-8", "replace").rstrip("\r\n")
        return line if line.startswith("#!") else None
    except OSError:
        return None


def detect_lang(shebang):
    """Extract the actual interpreter from shebang. Handles #!/bin/bash and #!/usr/bin/env bash."""
    if not shebang:
        return None
    body = shebang[2:].strip()
    parts = body.split()
    if not parts:
        return None
    prog_path = parts[0]
    prog = os.path.basename(prog_path)
    # Handle env-style: skip 'env' to get the real program
    if prog == "env" and len(parts) > 1:
        prog = os.path.basename(parts[1])
    return SHEBANG_LANG_MAP.get(prog)


def is_binary_file(path):
    try:
        with open(path, "rb") as f:
            return b"\x00" in f.read(8192)
    except OSError:
        return False


def classify_file(path):
    if is_binary_file(path):
        return "binary"
    if first_shebang(path):
        return "script"
    return "data"


def scan_local_bin():
    entries = []
    if not os.path.isdir(LOCAL_BIN):
        return entries
    for name in sorted(os.listdir(LOCAL_BIN)):
        full = os.path.join(LOCAL_BIN, name)
        if os.path.islink(full):
            try:
                raw = os.readlink(full)
            except OSError:
                raw = "?"
            if not raw.startswith("/"):
                resolved = os.path.normpath(os.path.join(LOCAL_BIN, raw))
            else:
                resolved = os.path.normpath(raw)
            entries.append({
                "name": name,
                "type": "link",
                "target": resolved,
                "broken": not os.path.exists(full),
            })
            # The link lives in ~/.local/bin (the ONE bin surface). Emit the
            # path relative to $HOME so the verifier resolves it the same way
            # regardless of what SOV is set to.
            entries[-1]["name"] = "~/.local/bin/" + name
        elif os.path.isfile(full) and not _should_exclude(name):
            kind = classify_file(full)
            sheb = first_shebang(full)
            lang = detect_lang(sheb) if sheb else None
            entries.append({
                "name": name,
                "path": full,
                "type": kind,
                "shebang": sheb,
                "lang": lang,
                "executable": os.access(full, os.X_OK),
                "size": os.path.getsize(full),
                "md5": md5sum(full),
            })
    return entries


def load_product_bin_dirs():
    if not os.path.isfile(PRODUCT_BIN_LIST):
        return []
    with open(PRODUCT_BIN_LIST) as f:
        return [l.strip() for l in f if l.strip() and not l.startswith("#")]


def scan_product_bin(dirs_to_scan):
    entries = []
    for rel_dir in dirs_to_scan:
        full_dir = os.path.join(HOME, rel_dir)
        if not os.path.isdir(full_dir):
            continue
        for name in sorted(os.listdir(full_dir)):
            if _should_exclude(name):
                continue
            full = os.path.join(full_dir, name)
            if os.path.islink(full) or not os.path.isfile(full):
                continue
            kind = classify_file(full)
            sheb = first_shebang(full)
            lang = detect_lang(sheb) if sheb else None
            entries.append({
                "name": name,
                "path": full,
                "dir_rel": rel_dir,
                "type": kind,
                "shebang": sheb,
                "lang": lang,
                "executable": os.access(full, os.X_OK),
                "size": os.path.getsize(full),
                "md5": md5sum(full),
            })
    return entries


def is_pens_proximate(path):
    return (
        path.startswith(PENS_ROOT)
        or path.startswith(SOVEREIGN)
        or os.path.join(HOME, ".local/share") in path
        or os.path.join(HOME, ".venv") in path
        or os.path.join(HOME, ".bun") in path
    )


def yaml_scalar(val):
    if val is None:
        return "null"
    if isinstance(val, bool):
        return "true" if val else "false"
    if isinstance(val, int):
        return str(val)
    s = str(val)
    if (
        not s
        or any(c in s for c in ":{}[],&*?|->!%@`#'\"")
        or s.startswith(('"', "'", "null", "true", "false", "[", "#"))
    ):
        s = s.replace("\\", "\\\\").replace('"', '\\"')
        return '"' + s + '"'
    return s


def note_for(name, entry):
    parts = []
    if entry.get("type") == "link":
        t = entry.get("target", "")
        if is_pens_proximate(t):
            rel = os.path.relpath(t, HOME)
            parts.append("symlink -> " + rel)
        else:
            parts.append("symlink (external)")
        if entry.get("broken"):
            parts.append("BROKEN")
    else:
        kind = entry.get("type", "")
        if kind == "binary":
            parts.append("binary")
        elif kind == "script":
            lang = entry.get("lang", "")
            if lang:
                parts.append("script (" + lang + ")")
            else:
                parts.append("script (unknown)")
        else:
            parts.append("data file")
        if entry.get("executable"):
            parts.append("executable")
        if entry.get("size") and entry.get("size") > 10000000:
            parts.append(str(entry["size"] // (1024 * 1024)) + "MB")
    return "; ".join(parts)


def yaml_emit(links, bins, manifest_path):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = []
    lines.append("# =============================================================================")
    lines.append("# Generated by manifest-gen.py - DO NOT EDIT BY HAND")
    lines.append("# Generated: " + now)
    lines.append("# Scan surface: ~/.local/bin + product bin/ dirs under pens/")
    lines.append("# Verified by bin-verify.sh (exit != 0 on any FAIL)")
    lines.append("# =============================================================================")
    lines.append("")
    lines.append("schema: estate-bin-manifest/1")
    lines.append("")
    lines.append("stale_paths:")
    for s in [
        "estate-merge-stash-20260914",
        "/home/toxic/projects/ik_llama.cpp-main",
        "/home/toxic/workspace/tau-launcher-build",
        "/home/toxic/projects/tau",
        "projects/tau",
    ]:
        lines.append("  - " + yaml_scalar(s))
    lines.append("")

    # links
    lines.append("links:")
    for e in links:
        lines.append("  - name: " + yaml_scalar(e["name"]))
        lines.append("    target: " + yaml_scalar(e["target"]))
        if e.get("broken"):
            lines.append("    broken: true")
        lines.append("    pens_proximity: " + yaml_scalar(is_pens_proximate(e["target"])))
    lines.append("")

    # bins
    lines.append("bins:")
    for e in bins:
        rel_path = os.path.relpath(e["path"], HOME)
        kind = e["type"]
        lang = e.get("lang")
        note = note_for(e["name"], e)
        lines.append("  - name: " + yaml_scalar(e["name"]))
        lines.append("    dir: " + yaml_scalar(os.path.dirname(rel_path)))
        lines.append("    kind: " + yaml_scalar(kind))
        if e.get("shebang"):
            lines.append("    shebang: " + yaml_scalar(e["shebang"]))
        if lang:
            lines.append("    syntax: " + yaml_scalar(lang))
        if e.get("md5"):
            lines.append("    md5: " + yaml_scalar(e["md5"]))
        if e.get("size"):
            lines.append("    size: " + yaml_scalar(e["size"]))
        if note:
            lines.append("    notes: " + yaml_scalar(note))
        lines.append("    pens_proximity: " + yaml_scalar(is_pens_proximate(e["path"])))
    lines.append("")

    # archived
    lines.append("archived:")
    for a in [
        {"name": "tau-old", "to": "pens/barn/estate-ops/archived/tau-old"},
        {"name": "omp-old", "to": "pens/barn/estate-ops/archived/omp-old"},
        {"name": "pi-old", "to": "pens/barn/estate-ops/archived/pi-old"},
    ]:
        lines.append("  - name: " + yaml_scalar(a["name"]))
        lines.append("    to: " + yaml_scalar(a["to"]))
        lines.append("    kept: false")
    lines.append("")

    # dirs
    lines.append("dirs:")
    # estate/bin was retired 2026-10-27 (its contents live in
    # pens/barn/estate-ops/bin now). ~/.local/bin is the ONE bin surface.
    for d in [".local/bin"]:
        lines.append("  - " + yaml_scalar(d))
    lines.append("")

    content = "\n".join(lines) + "\n"
    with open(manifest_path, "w") as f:
        f.write(content)
    return content


def main():
    manifest_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        HOME, "pens/barn/estate-ops/bin/manifest.yaml"
    )

    print("manifest-gen: scanning " + LOCAL_BIN, file=sys.stderr)
    local = scan_local_bin()
    print("  -> " + str(len(local)) + " entries", file=sys.stderr)

    links = [e for e in local if e.get("type") == "link"]
    bins = [e for e in local if e.get("type") in ("script", "binary", "data")]

    prod_dirs = load_product_bin_dirs()
    if prod_dirs:
        print("manifest-gen: scanning product bin/ dirs", file=sys.stderr)
        prod = scan_product_bin(prod_dirs)
        bins.extend(prod)
        print("  -> " + str(len(prod)) + " product entries", file=sys.stderr)

    broken = [e for e in links if e.get("broken")]
    if broken:
        print("manifest-gen: WARNING " + str(len(broken)) + " broken symlink(s)", file=sys.stderr)
        for e in broken:
            print("  " + e["name"] + " -> " + e["target"], file=sys.stderr)

    print("manifest-gen: writing to " + manifest_path, file=sys.stderr)
    content = yaml_emit(links, bins, manifest_path)
    lc = content.count("\n")
    print("manifest-gen: DONE " + str(len(links)) + " links, " + str(len(bins)) + " bins, " + str(lc) + " lines", file=sys.stderr)


if __name__ == "__main__":
    main()
