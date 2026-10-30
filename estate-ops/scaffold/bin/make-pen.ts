#!/usr/bin/env bun
/**
 * make-pen.ts — instantiate the five estate pens from this scaffold.
 *
 * The estate has FIVE pens, all the same shape:
 *
 *   pens/<pen>/
 *     .gitignore   kitchen-sink `*` + whitelist (submoduleless doctrine)
 *     README.md    role, member table, ports, languages
 *     LICENSE
 *     package.json
 *     mise.toml
 *     AGENTS.md
 *     bin/         entrypoint symlink surface
 *     products/    peer standalone product checkouts (auto-ignored)
 *     docs/        pen-owned documentation (auto-ignored unless whitelisted)
 *
 *   pens/estate    the control plane (config, pitchfork, services, state)
 *   pens/geode     the inference plane (mimetite, chalcopyrite, …)
 *   pens/barn      ops tooling (thresher, weave, secretsmith, …)
 *   pens/ranch     fleet/model components
 *   pens/olympus   Greek-named products (tau, kappa, sigma, …)
 *
 * WHY THIS EXISTS
 * ---------------
 * The estate used to be `/home/toxic/estate` (a control plane holding
 * symlinks into `pens/`) plus a flat `pens/` of loose product dirs. Two
 * consequences, both bad:
 *
 *   1. RECURSION — `estate/ranch -> pens/ranch` and `estate/olympus ->
 *      pens/olympus` were git-tracked symlinks (mode 120000), so the control
 *      plane pointed into the thing it was supposed to govern.
 *   2. NO UNIFORM SHAPE — `olympus` had `products/` + top-level alias
 *      symlinks, `barn` was flat, `ranch` was flat with 60+ loose dirs.
 *
 * Five pens, one shape, no symlinks, no recursion.
 *
 * SAFETY (2026-10-25)
 * -------------------
 * The first version of this script had `--force` do `rm -rf <pen>`, which
 * destroyed `pens/barn` — 13 products and 127 estate-ops binaries — and broke
 * 53 `~/.local/bin` symlinks. That was unrecoverable from git because barn's
 * products were never tracked (kitchen-sink ignore).
 *
 * So `--force` now means: **overwrite the pen's METADATA files only.** It
 * NEVER removes `products/`, `docs/`, or anything else. There is no code path
 * that deletes a pen. To truly reset a pen, a human does it deliberately.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

const here = import.meta.dir; // Bun-native: no fileURLToPath ceremony
const PENS_ROOT = resolve(here, "../../.."); // pens/

interface Options {
  pen: string;
  title: string;
  blurb: string;
  force: boolean;
}

function parseArgs(): Options {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const pen = get("--pen", "");
  if (!pen) {
    console.error("usage: make-pen.ts --pen <name> --title <Title> --blurb <text>");
    process.exit(2);
  }
  return {
    pen,
    title: get("--title", pen),
    blurb: get("--blurb", ""),
    force: argv.includes("--force"),
  };
}

/** The kitchen-sink ignore: everything ignored, then the pen's own surface whitelisted. */
function gitignore(title: string): string {
  return `# .gitignore — ${title} pen.
#
# Submoduleless by design: product checkouts live under products/ as peer
# standalone clones and are NEVER tracked by this repo. No gitlinks (mode
# 160000), no nested .git pollution in the index.
*
!.gitignore
!README.md
!LICENSE
!package.json
!mise.toml
!AGENTS.md
!bin/
!bin/**
!docs/
!docs/**
`;
}

function readme(o: Options): string {
  return `# ${o.title}

${o.blurb}

One of the estate's five pens (\`pens/{estate,geode,barn,ranch,olympus}\`).
Every pen has the same shape: \`products/\` for peer standalone checkouts,
\`docs/\` for pen-owned documentation, and a \`bin/\` entrypoint surface that
is symlinked into \`~/.local/bin\` and pinned by the estate-ops manifest.

## Products

| Product | Subdir | Port | Language | Notes |
|---|---|---|---|---|
| — | \`<product>/\` | — | — | — |

## Layout

\`\`\`text
${o.pen}/
  .gitignore    kitchen-sink \`*\` + whitelist (submoduleless doctrine)
  README.md     this file — role, member table, ports, languages
  LICENSE
  package.json
  mise.toml
  AGENTS.md
  bin/          entrypoint symlink surface -> ~/.local/bin
  products/     peer standalone checkouts (auto-ignored, never tracked)
  docs/         pen-owned documentation
\`\`\`

## Tooling

- **bin surface**: entrypoints symlinked into \`~/.local/bin\`, pinned by
  \`pens/barn/estate-ops/bin/manifest.yaml\` and verified by
  \`pens/barn/estate-ops/bin/bin-verify.sh\`. A broken link is a FAIL, never a WARN.
- **README**: generated from the pen's own product set by
  \`pens/barn/estate-ops/scaffold/bin/readme-gen.ts\`; regenerate with
  \`bun run readme\`.
- **manifest**: regenerate with
  \`pens/barn/estate-ops/bin/manifest-gen.py\`.

## Conventions

- Products are **peer standalone checkouts**, referenced-not-owned. This repo
  tracks only its own metadata, \`bin/\`, and \`docs/\`.
- Daemon ids use **dashes, never underscores** (\`config-naming-conventions.md\`).
- Ports are declared in the control plane's \`config/ports.env\` as
  \`UPPER_SNAKE_*_PORT=<25xxx>\` — that file is the numeric SSOT.
- Runtime language across the estate is **Bun/TypeScript**.

## License

Apache-2.0 unless a product states otherwise. Confidential products keep
their own license and their own visibility.
`;
}

function packageJson(o: Options): string {
  return (
    JSON.stringify(
      {
        name: o.pen,
        version: "0.0.0",
        private: true,
        type: "module",
        scripts: {
          test: "bun test",
          check: "bunx oxlint . && bunx oxfmt --check '*.ts'",
          lint: "bunx oxlint .",
          readme: "bun ./bin/readme-gen.ts",
        },
      },
      null,
      2,
    ) + "\n"
  );
}

function miseToml(o: Options): string {
  return `# mise.toml — runtime/language versions for the ${o.title} pen.
[tools]
bun = "1.4.4"
`;
}

function agentsMd(o: Options): string {
  return `# AGENTS.md — ${o.title} (\`pens/${o.pen}\`)

> **Part of the estate's pens family** (\`pens/{estate,geode,barn,ranch,olympus}\`).
> A pens repo is a **thin coordinator**, not a product monorepo. It owns only
> its own metadata, \`bin/\`, and \`docs/\`. Products are peer standalone
> checkouts, referenced-not-owned.

## This repo is submoduleless by design

There are **no submodules** here. The repo's \`.gitignore\` is the kitchen-sink:
\`*\` with a whitelist. Any product checkout dropped into \`products/\` is
**auto-ignored** — nothing to register, no gitlink, no nested \`.git\` in the
index.

\`\`\`
*
!.gitignore
!README.md
!LICENSE
!package.json
!mise.toml
!AGENTS.md
!bin/
!bin/**
!docs/
!docs/**
\`\`\`

## Rules

1. **Never** \`git submodule add\` and never commit a gitlink (mode 160000).
2. A product is a peer clone: \`git clone <url> products/<name>\`. It brings
   its own history and its own remote.
3. The pen repo's \`git status\` must stay clean regardless of what the
   products are doing.
4. \`bin/\` entries are symlinked into \`~/.local/bin\` and pinned by the
   estate-ops manifest; \`bin-verify.sh\` treats a broken link as FAIL.
5. Runtime language is **Bun/TypeScript**.
6. Secrets never live in this repo. They live in the secretsmith keyring.

## Where things go

- **A new product** → \`products/<name>/\`, plus a row in this pen's README
  member table and an entry in the estate-ops bin manifest.
- **Pen-owned documentation** → \`docs/\`.
- **Estate-wide documentation** (architecture, daemons, conventions) →
  \`pens/estate/docs/\`.
`;
}

async function writeFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, content); // Bun-native atomic write
}

async function main(): Promise<void> {
  const o = parseArgs();
  const root = join(PENS_ROOT, o.pen);
  const products = join(root, "products");

  // SAFETY: never delete a pen. --force only overwrites metadata.
  try {
    const existing = await readdir(products);
    if (existing.length > 0 && !o.force) {
      console.log(
        `[make-pen] ${root}/products/ already has ${existing.length} entries — ` +
          `pass --force to rewrite the pen METADATA (products are never touched).`,
      );
      return;
    }
  } catch {
    // products/ does not exist yet — fresh pen, fine.
  }

  await mkdir(products, { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });

  await writeFile(join(root, ".gitignore"), gitignore(o.title));
  await writeFile(join(root, "README.md"), readme(o));
  await writeFile(join(root, "package.json"), packageJson(o));
  await writeFile(join(root, "mise.toml"), miseToml(o));
  await writeFile(join(root, "AGENTS.md"), agentsMd(o));

  console.log(`✔ pen scaffold ready: pens/${o.pen}`);
  console.log(`  · metadata written; products/ left untouched`);
  console.log(`  · next: git init && git add .gitignore README.md LICENSE package.json mise.toml AGENTS.md bin/ docs/ && git commit`);
  console.log(`  · clone products into products/<name>/ (auto-ignored)`);
}

await main();
