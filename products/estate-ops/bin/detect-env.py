#!/usr/bin/env python3
"""detect-env — statically detect the env vars each product actually reads.

Kills the global ports.env bucket: instead of one stale inventory, every
product self-declares via AST-lite static scan. Reads every source file and
collects env-access patterns:

  process.env.X | os.environ["X"] | getenv("X") | secretsmith get --label X
  ${X} in template strings | X = env.get("X") | dbus env lookups

Usage:
  detect-env [--product pens/ranch/products/<name> ...]
             [--pen ranch]          # all products in a pen
             [--json]               # emit env-manifest.json per product
"""
import os, re, sys, json, glob

ENV_PATTERNS = [
    # process.env.X (JS/TS/Bun)
    re.compile(r"process\.env\.([A-Za-z_][A-Za-z0-9_]*)"),
    # os.environ["X"] / ["X"]  (python)
    re.compile(r"os\.environ\s*\[\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]\s*\]"),
    re.compile(r"os\.getenv\s*\(\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]"),
    # Bun.env.X
    re.compile(r"Bun\.env\.([A-Za-z_][A-Za-z0-9_]*)"),
    # import.meta.env.X (vite)
    re.compile(r"import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)"),
    # env.X (deno/others where env is the object)
    re.compile(r"\benv\.([A-Za-z_][A-Za-z0-9_]{2,})\b"),
    # getenv("X")
    re.compile(r"getenv\(\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]"),
    # #[from(env=...)]  rust
    re.compile(r"from\(\s*env\s*=\s*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]"),
    # secretsmith get --label X / get KEY (label is the env var)
    re.compile(r"secretsmith\s+get\s+--label\s+['\"]?([A-Z0-9_]{4,})['\"]?", re.I),
    # ${X} / ${X:...} in strings (shell/template)
    re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)[:}?]"),
]

def scan_files(product_dir: str):
    vars_found = {}
    files = []
    for root, dirs, fs in os.walk(product_dir):
        if any(x in root for x in ["node_modules", ".git", "dist", "target", ".venv", "__pycache__", ".ffs"]):
            dirs[:] = [d for d in dirs if d not in ("node_modules", ".git", "dist", "target", ".venv", "__pycache__", ".ffs")]
            continue
        for f in fs:
            if f.endswith((".ts", ".js", ".mjs", ".py", ".rs", ".go", ".sh", ".toml", ".json", ".tsx", ".env.example")):
                files.append(os.path.join(root, f))
    for p in files:
        try:
            src = open(p, encoding="utf-8", errors="replace").read()
        except Exception:
            continue
        for re_ in ENV_PATTERNS:
            for m in re_.finditer(src):
                name = m.group(1)
                if len(name) < 3 or name.lower() in ("env", "this", "node", "deno", "inner", "value", "key"):
                    continue
                if re.match(r"^\d", name):
                    continue
                rel = os.path.relpath(p, product_dir)
                vars_found.setdefault(name, set()).add(rel)
    return vars_found, files

def main():
    args = sys.argv[1:]
    source = list(args)  # work copy (we mutate)
    emit_json = "--json" in source
    def take(flag) -> str | None:
        if flag in source:
            i = source.index(flag)
            if i + 1 < len(source):
                v = source[i + 1]
                del source[i:i + 2]
                return v
            del source[i]
        return None
    pen = take("--pen") or None
    # positional products = anything not a flag
    products = [a for a in source if not a.startswith("--")]
    if pen and not products:
        base = f"/home/toxic/pens/{pen}/products"
        if os.path.isdir(base):
            products = [os.path.join(base, d) for d in os.listdir(base) if os.path.isdir(os.path.join(base, d))]
    if not products:
        # default: the products we know matter
        products = [
            "/home/toxic/pens/ranch/products/android-fleet",
            "/home/toxic/pens/ranch/products/squawk",
            "/home/toxic/pens/olympus/products/tau",
            "/home/toxic/pens/olympus/products/mneme",
        ]
    for prod in products:
        if not os.path.isdir(prod):
            print(f"[skip] {prod}")
            continue
        vars_found, files = scan_files(prod)
        name = os.path.basename(prod.rstrip("/"))
        print(f"\n== {name} ({os.path.dirname(prod)}) — {len(files)} files, {len(vars_found)} env vars ==")
        if emit_json:
            manifest = {
                "product": name,
                "path": prod,
                "files": len(files),
                "detected_at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
                "env_vars": {k: sorted(v) for k, v in sorted(vars_found.items())},
            }
            out = os.path.join(prod, "env-manifest.detected.json")
            with open(out, "w") as f:
                json.dump(manifest, f, indent=2)
            print(f"  wrote {out}")
        for k in sorted(vars_found):
            print(f"  {k:30s} <- {len(vars_found[k])} sites ({sorted(vars_found[k])[0]}{', ...' if len(vars_found[k])>1 else ''})")

if __name__ == "__main__":
    main()