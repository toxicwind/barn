#!/usr/bin/env bun
// readme-gen.ts — generate a pen's README.md from its actual product set.
//
// Discovery rules (strict, no hoisting):
//   A product directory qualifies if it contains .git, package.json, go.mod,
//   or Cargo.toml at its top level. Nested-only artifacts do NOT qualify.
//   A `*-guide` standalone repo at the pen root (own .git) also qualifies.
//
// Idempotent: running twice produces byte-identical output.
// Safe: never deletes or touches products/. Never rm -rf.
//
// Bun-native (1.4.4): zero node:fs SYNC imports. Bun.file / Bun.write for
// I/O; node:fs/promises readdir/stat (async, 97.5% suite compat); Bun.argv CLI.
// Emits github-md-guide-compliant READMEs (header block, ToC, deep links).

import { join, basename } from "node:path";
import { readdir, stat } from "node:fs/promises"; // async node:fs — 97.5% own-suite compat on Bun 1.4

// ── Types ────────────────────────────────────────────────────────────────────

interface ProductMeta {
  name: string;
  displayTitle: string;
  port: string;
  language: string;
  role: string;
}

// ── Bun-native filesystem helpers ───────────────────────────────────────────

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readSafe(p: string): Promise<string | null> {
  try {
    return await Bun.file(p).text();
  } catch {
    return null;
  }
}

async function parseJSON<T = unknown>(p: string): Promise<T | null> {
  const raw = await readSafe(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Synchronous-style, Bun-native: does any of the given paths exist? */
async function anyExists(paths: string[]): Promise<boolean> {
  for (const p of paths) {
    try {
      await stat(p);
      return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

/** Child subdirectory names (fs/promises readdir — async, Bun first-class). */
async function subdirNames(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    const out: string[] = [];
    for (const n of names) {
      if (await isDir(join(dir, n))) out.push(n);
    }
    return out.sort();
  } catch {
    return [];
  }
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * List qualifying product subdirectories inside a pen's products/.
 * A directory qualifies if it directly contains .git, package.json, go.mod,
 * or Cargo.toml.
 *
 * Guides are ALSO products: a `*-guide` standalone repo living at the pen
 * root (github-md-guide/, bash-style-guide/ …) has its own .git — it counts.
 */
async function discoverProducts(productsDir: string): Promise<string[]> {
  const names = await subdirNames(productsDir);
  const qualifying: string[] = [];
  for (const n of names) {
    const p = join(productsDir, n);
    if (await anyExists([join(p, ".git"), join(p, "package.json"), join(p, "go.mod"), join(p, "Cargo.toml")])) {
      qualifying.push(p);
    }
  }
  return qualifying.sort(); // deterministic order
}

/**
 * List standalone product/guide dirs at the PEN ROOT itself (not under
 * products/). A `*-guide` repo, a product that predates the products/ layout,
 * or any dir with its own .git qualifies. Auto-ignored by the kitchen-sink
 * .gitignore — discovery is filesystem truth, not index state.
 */
async function discoverRootProducts(penDir: string): Promise<string[]> {
  const names = await subdirNames(penDir);
  const out: string[] = [];
  for (const n of names) {
    if (["git", "products", "bin", "docs", "node_modules"].includes(n)) continue;
    const p = join(penDir, n);
    try {
      await stat(join(p, ".git"));
      out.push(p);
    } catch {
      /* not a standalone repo */
    }
  }
  return out.sort();
}

/** List pen root docs/ files (deep-linkable doc index). */
async function discoverDocs(penDir: string): Promise<string[]> {
  const d = join(penDir, "docs");
  try {
    const names = await readdir(d);
    return names.filter((n) => /\.md$/i.test(n)).sort();
  } catch {
    return [];
  }
}

// ── Metadata extraction ──────────────────────────────────────────────────────

/** Extract the display title from a README's first # heading. */
async function extractDisplayTitle(readmePath: string): Promise<string> {
  const raw = await readSafe(readmePath);
  if (!raw) return "";

  for (const line of raw.split("\n")) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) return m[1].trim();
  }
  return "";
}

/** Extract the one-line role: first non-empty paragraph after # heading. */
async function extractRole(readmePath: string): Promise<string> {
  const raw = await readSafe(readmePath);
  if (!raw) return "";

  let foundHeading = false;
  for (const line of raw.split("\n")) {
    if (!foundHeading) {
      if (line.startsWith("# ")) foundHeading = true;
      continue;
    }
    if (line.trim() === "" || line.startsWith("# ")) continue;
    const trimmed = line.replace(/^[-*>]\s*/, "").trim();
    if (trimmed) {
      const clean = trimmed
        .replace(/^[-*>]\s*/, "")
        .replace(/<[^>]*>/g, "")
        .replace(/[*_]/g, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .trim();
      return clean.length > 100 ? clean.slice(0, 97) + "..." : clean;
    }
  }
  return "";
}

/** Scan a product tree for port references (25xxx style). */
async function extractPort(productDir: string): Promise<string> {
  const servedPorts = new Set<string>();
  const allPorts = new Set<string>();

  const visited = new Set<string>();
  const scanExt = new Set(["ts", "js", "json", "env", "toml", "yml", "yaml", "md", "sh", "py"]);
  const skip = new Set(["node_modules", "dist", "bazel-out", "bazel-bin", "bazel-testlogs", "bazel-tau", "__pycache__", "generated"]);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 2 || visited.has(dir)) return;
    visited.add(dir);
    if (!(await isDir(dir))) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (skip.has(n)) continue;
      const full = join(dir, n);
      if (visited.has(full)) continue;
      visited.add(full);
      if (await isDir(full)) {
        await walk(full, depth + 1);
        continue;
      }
      const ext = n.split(".").pop()?.toLowerCase();
      if (!ext || !scanExt.has(ext)) continue;
      const content = await readSafe(full);
      if (!content) continue;
      for (const line of content.split("\n")) {
        for (const m of line.matchAll(/\b(25\d{3})\b/g)) {
          const port = m[1];
          allPorts.add(port);
          if (
            /PORT\s*(?:=|:)\s*["']?\s*(25\d{3})/i.test(line) ||
            /ESTATE_(?:ROUTER_)?PORT\s*[=:]?\s*["']?\s*(25\d{3})/.test(line) ||
            /port-(\d{5})/.test(line) ||
            /"port"\s*:\s*["']?(25\d{3})["']?/.test(line) ||
            /serve\s+(25\d{3})/i.test(line)
          ) {
            servedPorts.add(port);
          }
        }
      }
    }
  }

  await walk(productDir, 0);

  if (servedPorts.size >= 1) return [...servedPorts].sort().join(",");
  if (allPorts.size === 1) return [...allPorts][0];
  return "";
}

/** Detect the dominant language from the product tree. */
async function detectLanguage(productDir: string): Promise<string> {
  const counts = { ts: 0, js: 0, go: 0, rust: 0, python: 0 };
  let hasGoMod = false;
  let hasCargo = false;

  const skip = new Set(["node_modules", "dist", "bazel-out", "bazel-bin", "bazel-tau", "__pycache__", "generated"]);
  const visited = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || visited.has(dir)) return;
    visited.add(dir);
    if (!(await isDir(dir))) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (skip.has(n)) continue;
      const full = join(dir, n);
      if (visited.has(full)) continue;
      visited.add(full);

      if (n === "go.mod") hasGoMod = true;
      if (n === "Cargo.toml") hasCargo = true;

      if (await isDir(full)) {
        await walk(full, depth + 1);
      } else {
        const ext = n.split(".").pop()?.toLowerCase();
        if (ext === "ts") counts.ts++;
        else if (ext === "js" || ext === "jsx" || ext === "mjs") counts.js++;
        else if (ext === "go") counts.go++;
        else if (ext === "rs") counts.rust++;
        else if (ext === "py") counts.python++;
      }
    }
  }

  await walk(productDir, 0);

  if (hasGoMod) return "Go";
  if (hasCargo) return "Rust";

  const codeCount = counts.ts + counts.js;
  if (codeCount === 0) {
    if (counts.python > 0) return "Python";
    return "—";
  }
  return counts.ts >= counts.js ? "TypeScript" : "JavaScript";
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** Extract pen title from README heading, package.json description, or dir name. */
async function extractPenTitle(penDir: string, penName: string): Promise<string> {
  const title = await extractDisplayTitle(join(penDir, "README.md"));
  if (title) return title;
  const pkg = await parseJSON<{ description?: string }>(join(penDir, "package.json"));
  if (pkg?.description) return pkg.description;
  return penName.charAt(0).toUpperCase() + penName.slice(1);
}

/** GitHub anchor slug (renderer-generated form: lowercase, spaces→-, strip punct). */
function anchorSlug(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

/** Generate the full README markdown for a pen — github-md-guide maximal. */
function generateReadme(
  penDir: string,
  penName: string,
  penTitle: string,
  products: ProductMeta[],
  rootProducts: ProductMeta[],
  docs: string[],
): string {
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));
  const rootSorted = [...rootProducts].sort((a, b) => a.name.localeCompare(b.name));

  const tableRows = sorted
    .map((p) => `| [**${p.name}**](${p.name}/) | ${p.port || "—"} | ${p.language || "—"} | ${p.role || "—"} |`)
    .join("\n");

  const hasTable = sorted.length > 0;
  const productSection = hasTable
    ? `## 📦 Products\n\n| Product | Port | Language | Role |\n| --- | --- | --- | --- |\n${tableRows}\n`
    : "";

  const guideRows = rootSorted
    .filter((p) => p.name.endsWith("-guide"))
    .map((p) => `| [**${p.name}**](${p.name}/) | ${p.port || "—"} | ${p.language || "—"} | ${p.role || "—"} |`)
    .join("\n");
  const guideSection = guideRows
    ? `## 📚 Guides\n\n| Guide | Port | Language | Role |\n| --- | --- | --- | --- |\n${guideRows}\n`
    : "";

  const docLinks = docs.map((d) => `- [\`${d}\`](docs/${d})`).join("\n");
  const docsSection = docLinks ? `## 📄 Docs\n\n${docLinks}\n` : "";

  const layout = `text
${penName}/
  .gitignore    kitchen-sink \`*\` + whitelist (submoduleless doctrine)
  README.md     this file — role, member table, ports, languages
  LICENSE
  package.json
  mise.toml
  AGENTS.md
  bin/          entrypoint symlink surface -> ~/.local/bin
  products/     peer standalone checkouts (auto-ignored, never tracked)
  docs/         pen-owned documentation
  *-guide/      standalone guide repos (own .git, auto-ignored)`;

  const toc = [
    ...(hasTable ? ["[📦 Products](#-products)"] : []),
    ...(guideSection ? ["[📚 Guides](#-guides)"] : []),
    ...(docsSection ? ["[📄 Docs](#-docs)"] : []),
    "[🗂 Layout](#-layout)",
    "[⚙️ Tooling](#️-tooling)",
    "[📐 Conventions](#-conventions)",
    "[🛡 License](#-license)",
  ].join(" · ");

  return `<div align="center">

# ${penTitle}

**pens/${penName}** — one of the estate's pens. Every pen is a thin
coordinator: \`products/\` for peer standalone checkouts, \`docs/\` for
pen-owned documentation, \`*-guide/\` for standalone guide repos, and a
\`bin/\` entrypoint surface pinned by the estate-ops manifest.

<p align="center">${toc}</p>

</div>

---
${productSection}
${guideSection}
${docsSection}
## 🗂 Layout

\`\`\`${layout}
\`\`\`

## ⚙️ Tooling

- **bin surface**: entrypoints symlinked into \`~/.local/bin\`, pinned by the
  estate-ops manifest and verified by \`bin-verify.sh\`. A broken link is
  a **FAIL, never a WARN**.
- **README**: generated from the pen's actual product set by
  \`bun bin/readme-gen.ts\` (Bun-native, idempotent).
- **SSOT**: config surfaces import into \`estate/config/<pen>\` via
  \`bin/ssot-sync.sh\` (secretsmith keyring is the secret SSOT).

## 📐 Conventions

- Submoduleless: peer repos are shallow clones, never git submodules
- Ports SSOT: \`config/ports.env\` is the single source of truth for :25xxx ports
- Bun runtime: all TS/JS products run on Bun; Go and Rust are compiled binaries
- Guides live in this pen as standalone \`*-guide\` repos (own .git)

## 🛡 License

Estate internal — all rights reserved.
`;
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface GeneratorOpts {
  /** Absolute path to the pen directory */
  penDir: string;
  /** Output README path (defaults to penDir/README.md) */
  outPath?: string;
}

async function generate(opts: GeneratorOpts): Promise<string> {
  const penDir = opts.penDir;
  const penName = basename(penDir);
  const outPath = opts.outPath ?? join(penDir, "README.md");

  // Actual pen title (async — passes straight into the assembly).
  const penTitle = await extractPenTitle(penDir, penName);

  // Discover products (products/) + root standalone repos (*-guide + peers).
  const productDirs = await discoverProducts(join(penDir, "products"));
  const rootDirs = await discoverRootProducts(penDir);
  const docs = await discoverDocs(penDir);

  const describe = async (dir: string): Promise<ProductMeta> => {
    const name = basename(dir);
    const [displayTitle, port, language, role] = await Promise.all([
      extractDisplayTitle(join(dir, "README.md")),
      extractPort(dir),
      detectLanguage(dir),
      extractRole(join(dir, "README.md")),
    ]);
    return { name, displayTitle, port, language, role };
  };

  const products = await Promise.all(productDirs.map(describe));
  const rootProducts = await Promise.all(rootDirs.map(describe));

  // Generate + write (Bun.write is atomic, no sync fs).
  const md = generateReadme(penDir, penName, penTitle, products, rootProducts, docs);
  await Bun.write(outPath, md);
  return outPath;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: bun readme-gen.ts <pen-dir> [output-readme]");
    console.error("  Generates README.md for a pen from its product set.");
    process.exit(1);
  }
  const resolved = args[0].startsWith("/") ? args[0] : join(process.cwd(), args[0]);
  const outPath = args[1];
  if (!(await isDir(resolved))) {
    console.error(`Error: ${resolved} is not a directory`);
    process.exit(1);
  }
  const out = await generate({ penDir: resolved, outPath });
  console.log(`Generated ${out}`);
}

export { generate, discoverProducts, extractPort, detectLanguage, extractDisplayTitle, extractRole, type ProductMeta, isDir };