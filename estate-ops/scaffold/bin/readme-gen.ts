#!/usr/bin/env bun
// readme-gen.ts — generate a pen's README.md from its actual product set.
//
// Discovery rules (strict, no hoisting):
//   A product directory qualifies if it contains a .git, package.json, go.mod,
//   or Cargo.toml at its top level. Nested-only artifacts do NOT qualify.
//
// Idempotent: running twice produces byte-identical output.
// Safe: never deletes or touches products/. Never rm -rf.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface ProductMeta {
  name: string;
  displayTitle: string;
  port: string;
  language: string;
  role: string;
}

// ── Filesystem helpers ───────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readSafe(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function parseJSON<T = unknown>(p: string): T | null {
  const raw = readSafe(p);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * List qualifying product subdirectories inside a pen's products/.
 * A directory qualifies if it directly contains .git, package.json, go.mod,
 * or Cargo.toml.
 */
function discoverProducts(productsDir: string): string[] {
  if (!isDir(productsDir)) return [];

  const entries = readdirSync(productsDir, { withFileTypes: true }).filter(
    (e) => e.isDirectory(),
  );

  const qualifying = entries.map((e) => join(productsDir, e.name)).filter(
    (p) =>
      existsSync(join(p, ".git")) ||
      existsSync(join(p, "package.json")) ||
      existsSync(join(p, "go.mod")) ||
      existsSync(join(p, "Cargo.toml")),
  );

  return qualifying.sort(); // deterministic order
}

// ── Metadata extraction ──────────────────────────────────────────────────────

/** Extract the display title from a README's first # heading. */
function extractDisplayTitle(readmePath: string): string {
  const raw = readSafe(readmePath);
  if (!raw) return "";

  const lines = raw.split("\n");
  for (const line of lines) {
    const m = line.match(/^#\s+(.+)$/);
    if (m) {
      return m[1].trim();
    }
  }
  return "";
}

/** Extract the one-line role: first non-empty paragraph after # heading. */
function extractRole(readmePath: string): string {
  const raw = readSafe(readmePath);
  if (!raw) return "";

  const lines = raw.split("\n");
  let foundHeading = false;
  for (const line of lines) {
    if (!foundHeading) {
      if (line.startsWith("# ")) foundHeading = true;
      continue;
    }
    // Skip blank lines and the title line itself
    if (line.trim() === "" || line.startsWith("# ")) continue;
    // First non-empty content line after heading
    const trimmed = line.replace(/^[-*>]\s*/, "").trim();
    if (trimmed) {
      // Strip inline markdown formatting for clean display
      // Strip HTML tags, markdown formatting, images, and blockquote prefixes
      const clean = trimmed
        .replace(/^[-*>]\s*/, "")           // strip blockquote/bullet prefix
        .replace(/<[^>]*>/g, "")            // strip HTML tags
        .replace(/[*_]/g, "")               // strip markdown bold/italic
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // strip image links
        .trim();

    return clean.length > 100 ? clean.slice(0, 97) + "..." : clean;
    }
  }
  return "";
}
/** Scan a product tree for port references (25xxx style). */
function extractPort(productDir: string): string {
  const servedPorts = new Set<string>();
  const allPorts = new Set<string>();

  // Walk the tree (limited depth). Only scan text/config files; skip compiled/generated.
  const visited = new Set<string>();
  const scanExt = new Set(["ts", "js", "json", "env", "toml", "yml", "yaml", "md", "sh", "py"]);

  function walk(dir: string, depth: number): void {
    if (depth > 2) return;
    if (!isDir(dir)) return;
    const skip = ["node_modules", "dist", "bazel-out", "bazel-bin", "bazel-testlogs", "bazel-tau", "__pycache__", "generated"];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (skip.includes(e.name)) continue;
        const full = join(dir, e.name);
        if (visited.has(full)) continue;
        visited.add(full);

        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile()) {
          const ext = e.name.split(".").pop()?.toLowerCase();
          if (!ext || !scanExt.has(ext)) continue;
          const content = readSafe(full);
          if (!content) continue;

          for (const line of content.split("\n")) {
            const matches = [...line.matchAll(/\b(25\d{3})\b/g)];
            for (const m of matches) {
              const port = m[1];
              allPorts.add(port);
              // Served port signals: PORT = ..., badge port-N, "port": N, serve N
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
    } catch {
      // skip
    }
  }

  walk(productDir, 0);

  if (servedPorts.size >= 1) {
    return [...servedPorts].sort().join(",");
  }
  if (allPorts.size === 1) {
    return [...allPorts][0];
  }
  return "";
}
/** Detect the dominant language from the product tree. */
function detectLanguage(productDir: string): string {
  const counts = { ts: 0, js: 0, go: 0, rust: 0, python: 0 };
  let hasGoMod = false;
  let hasCargo = false;
  let hasPackageJson = false;

  function walk(dir: string, depth: number): void {
    if (depth > 3) return;
    if (!isDir(dir)) return;
    const skip = ["node_modules", "dist", "bazel-out", "bazel-bin", "bazel-tau", "__pycache__", "generated"];
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (skip.includes(e.name)) continue;
        const full = join(dir, e.name);

        if (e.name === "go.mod") hasGoMod = true;
        if (e.name === "Cargo.toml") hasCargo = true;
        if (e.name === "package.json") hasPackageJson = true;

        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else {
          const ext = e.name.split(".").pop()?.toLowerCase();
          if (ext === "ts") counts.ts++;
          else if (ext === "js" || ext === "jsx" || ext === "mjs") counts.js++;
          else if (ext === "go") counts.go++;
          else if (ext === "rs") counts.rust++;
          else if (ext === "py") counts.python++;
        }
      }
    } catch {
      // skip
    }
  }

  walk(productDir, 0);

  // Structured manifests take priority
  if (hasGoMod) return "Go";
  if (hasCargo) return "Rust";

  // Count-based for JS/TS
  const codeCount = counts.ts + counts.js;
  if (codeCount === 0) {
    if (counts.python > 0) return "Python";
    return "—";
  }

  if (counts.ts >= counts.js) return "TypeScript";
  return "JavaScript";
}

// ── Assembly ─────────────────────────────────────────────────────────────────

/** Extract pen title from README heading, package.json description, or dir name. */
function extractPenTitle(
  penDir: string,
  penName: string,
): string {
  // Try pen-level README first heading
  const title = extractDisplayTitle(join(penDir, "README.md"));
  if (title) return title;

  // Fall back to package.json description
  const pkg = parseJSON<{ description?: string }>(join(penDir, "package.json"));
  if (pkg?.description) {
    return pkg.description;
  }

  return penName.charAt(0).toUpperCase() + penName.slice(1);
}

/** Build badges for a pen. */
function penBadges(penName: string): string {
  // Right-aligned for-the-badge style
  return `![${penName}]`;
}

/** Build badges for a product row. */
function productBadgeRow(name: string, port: string, language: string): string {
  const parts: string[] = [];
  parts.push(`![${name}]`);
  if (port) parts.push(`![port ${port}]`);
  if (language !== "—" && language !== "") parts.push(`[${language}]`);
  return parts.join(" ");
}

/** Generate the full README markdown for a pen. */
function generateReadme(penDir: string, penName: string, products: ProductMeta[]): string {
  const penTitle = extractPenTitle(penDir, penName);
  const penBlurb = penTitle;

  // Product rows sorted by name
  const sorted = [...products].sort((a, b) => a.name.localeCompare(b.name));

  // Build product table
  const tableRows = sorted.map((p) => {
    return `| ${p.name} | ${p.port || "—"} | ${p.language || "—"} | ${p.role || "—"} |`;
  });

  const table = [
    `| Product | Port | Language | Role |`,
    `| --- | --- | --- | --- |`,
    ...tableRows,
  ].join("\n");

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
  docs/         pen-owned documentation`;

  const blurb = `One of the estate's five pens (\`pens/{estate,geode,barn,ranch,olympus}\`).
Every pen has the same shape: \`products/\` for peer standalone checkouts,
\`docs/\` for pen-owned documentation, and a \`bin/\` entrypoint surface that
is symlinked into \`~/.local/bin\` and pinned by the estate-ops manifest.`;

  return [
    `# ${penTitle}`,
    "",
    blurb,
    "",
    `## Products`,
    "",
    table,
    "",
    `## Layout`,
    `\`\`\`${layout}`,
    `\`\`\``,
    "",
    `## Tooling`,
    "",
  `- **bin surface**: entrypoints symlinked into \`~/.local/bin\`, pinned by the`,
  `-  estate-ops manifest and verified by \`bin-verify.sh\`. A broken link is`,
  `-  a FAIL, never a WARN.`,
  `-  **README**: generated from the pen's own product set by`,
  `-  \`bin/readme-gen.ts\`.`,
    "",
    `## Conventions`,
    "",
    `- Submoduleless: peer repos are shallow clones, never git submodules`,
    `- Ports SSOT: \`config/ports.env\` is the single source of truth for :25xxx ports`,
    `- Bun runtime: all TS/JS products run on Bun; Go and Rust are compiled binaries`,
    "",
    `## License`,
    "",
    `Estate internal — all rights reserved.`,
    "",
  ].join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

interface GeneratorOpts {
  /** Absolute path to the pen directory */
  penDir: string;
  /** Output README path (defaults to penDir/README.md) */
  outPath?: string;
}

function generate(opts: GeneratorOpts): string {
  const penDir = opts.penDir;
  const penName = basename(penDir);
  const outPath = opts.outPath ?? join(penDir, "README.md");

  // Discover products
  const productsDir = join(penDir, "products");
  const productDirs = discoverProducts(productsDir);

  // Extract metadata for each
  const products: ProductMeta[] = productDirs.map((dir) => {
    const name = basename(dir);
    const displayTitle = extractDisplayTitle(join(dir, "README.md"));
    const port = extractPort(dir);
    const language = detectLanguage(dir);
    const role = extractRole(join(dir, "README.md"));

    return {
      name,
      displayTitle,
      port,
      language,
      role,
    };
  });

  // Generate
  const md = generateReadme(penDir, penName, products);

  // Write
  writeFileSync(outPath, md, "utf8");

  return outPath;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Bun.argv.slice(2);

  if (args.length < 1) {
    console.error(`Usage: bun readme-gen.ts <pen-dir> [output-readme]`);
    console.error("  Generates README.md for a pen from its product set.");
    process.exit(1);
  }

  const resolved = args[0].startsWith("/") ? args[0] : join(process.cwd(), args[0]);
  const outPath = args[1];

  if (!isDir(resolved)) {
    console.error(`Error: ${resolved} is not a directory`);
    process.exit(1);
  }

  const out = generate({ penDir: resolved, outPath });
  console.log(`Generated ${out}`);
}

export { generate, discoverProducts, extractPort, detectLanguage, extractDisplayTitle, extractRole, type ProductMeta };
