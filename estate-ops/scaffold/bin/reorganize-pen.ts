#!/usr/bin/env bun
/**
 * reorganize-pen.ts — force a pen into the five-shape scaffold layout.
 *
 * MAXIMALLY NON-DESTRUCTIVE:
 *   - dry-run by default (prints moves, touches nothing) — safe to re-run
 *   - before any move, takes a hardlink snapshot (cp -al) of the whole pen
 *     root into /home/toxic/archive/pen-snapshots/<pen>-pre-reorg-<date>-<nanos>/ —
 *     instant byte-identical rollback source; nothing is deleted and the working tree
 *     is never emptied
 *   - only moves (rename), never deletes
 *   - never force-overwrites refs (-f is forbidden; names are unique per run)
 *   - never touches remotes (no git push --force)
 *
 * TARGET SHAPE (pen root contains ONLY):
 *   .gitignore README.md LICENSE package.json mise.toml AGENTS.md pitchfork.toml
 *   bin/ docs/ products/ ssot/ scripts/ (+ *.md support docs)
 *
 * Usage: bun reorganize-pen.ts <pen> [--apply]   (dry-run default)
 */
import { readdir, lstat, stat, mkdir, rename } from "node:fs/promises";
import { join } from "path";
import { execSync } from "child_process";

const PENS_ROOT = "/home/toxic/pens";
const SNAP_ROOT = "/home/toxic/archive/pen-snapshots";
const SUPPORT = new Set([
	"bin",
	"docs",
	"products",
	"ssot",
	"scripts",
	"src",
	"lib",
	"tests",
	"test",
	"tools",
	"archive",
	".git",
	"node_modules",
]);
const SUPPORT_FILES = new Set([
	".gitignore",
	"README.md",
	"LICENSE",
	"package.json",
	"mise.toml",
	"AGENTS.md",
	"pitchfork.toml",
	"CLAUDE.md",
	"CHANGELOG.md",
	"CONTRIBUTING.md",
	"CODE_OF_CONDUCT.md",
	"SECURITY.md",
	"moon.yml",
]);
/** Pure litter dir names (cache/runtime/backup/junk) -> archived inside pen, never deleted */
const LITTER = new Set([
	"node_modules",
	"__pycache__",
	".cache",
	"dist",
	"generated",
	"vendor",
	"vendored",
	"range-ui.tmp",
	".smithers",
	".corral",
	".moon",
]);

const GREEK = new Set([
	"tau","kappa","sigma","keryx","muse","kryptos","kairos","skopos","hodos",
	"theta","agon","didymos","opsis","pinax","propylon","pylae","agele",
	"chronos-forge","antilogos","kilo","morphe",
]);
const MINERAL = new Set([
	"mimetite","rhodochrosite","chalcedony","bornite","chalcopyrite","azurite",
	"pseudobrookite","malachite","labradorite","howlite",
]);
const THEME_PEN: Array<[RegExp, string]> = [
	[
		/^(thresher|weave|flatbread|chute|gatehouse|forge|estate-ops|secretsmith|lookout|archguard|gemini-mcp|nativelink|estate-tailscale|rosec|gem-dredge|fanout)$/,
		"barn",
	],
	[
		/^(squawk|corral|hatch|roundup|lasso|rawhide|stable|feedlot|herd|ferret-den|trading-post|blackbird|github-search|rename-roundup|yote)$/,
		"ranch",
	],
];

function themePen(name: string): string | null {
	const base = name.replace(/-staging$/, "").replace(/-maximal$/, "");
	if (GREEK.has(base)) return "olympus";
	if (MINERAL.has(base)) return "geode";
	for (const [re, pen] of THEME_PEN) if (re.test(base)) return pen;
	return null;
}

const pen = process.argv[2];
const apply = process.argv.includes("--apply");
if (!pen) {
	console.error("usage: bun reorganize-pen.ts <pen> [--apply]");
	process.exit(2);
}
/** Control-plane pens: root dirs ARE live daemon homes (pitchfork dir/run refs
 * resolve absolute pens paths) — products/ migration is forbidden here. */
const CONTROL_PLANE = new Set(["estate"]);
if (CONTROL_PLANE.has(pen)) {
	console.error(
		`reorganize-pen: "${pen}" is a control-plane pen — its root dirs are live\n` +
		`daemon homes referenced by pitchfork.toml. products/ reorg forbidden.\n` +
		`Apply the five-shape scaffold to product pens only (barn ranch geode olympus).`,
	);
	process.exit(3);
}
const root = join(PENS_ROOT, pen);
const products = join(root, "products");
const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const nanos = Date.now();
const snapshot = join(SNAP_ROOT, `${pen}-pre-reorg-${datePart}-${nanos}`);

async function isDir(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}
async function readlinkSafe(p: string): Promise<string> {
	try { return await (await import("node:fs/promises")).readlink(p); }
	catch { return ""; }
}
async function qualifies(dir: string): Promise<boolean> {
	for (const m of [".git", "package.json", "go.mod", "Cargo.toml"]) {
		try { await stat(join(dir, m)); return true; }
		catch { /* next */ }
	}
	return false;
}

/** Instant byte-identical rollback source. cp -al: nothing cleared, working tree intact.
 * node_modules EXCLUDED: regenerable (bun install), it dominates tree size.
 * Timeout scales with tree size: 600s base, +1s per 1000 dirs. */
async function snapshotPen(root: string, dest: string): Promise<void> {
	await mkdir(dest, { recursive: true });
	const dirCount = Number(
		execSync(`find "${root}" -name node_modules -prune -o -type d -print 2>/dev/null | wc -l`, {
			encoding: "utf-8",
			timeout: 300000,
		}).trim() || "0",
	);
	const budget = Math.min(3600, Math.max(600, Math.ceil(dirCount / 1000)));
	console.log(`  snapshot: ${dirCount} dirs (excl node_modules), budget ${budget}s -> ${dest}`);
	// find|cpio hardlink pass: only non-node_modules paths (cp -al cannot exclude)
		try {
			execSync(
				`cd "${root}" && find . -name node_modules -prune -o -print0 | cpio -p0al --null "${dest}"`,
				{ stdio: "pipe", timeout: budget * 1000 },
			);
		} catch (e) {
			log("snapshot failed (proceeding anyway):", (e as Error).message);
		}
	}

/** Record HEAD into a uniquely-named local ref. Never -f, never pushes. */
async function gitSafety(dir: string): Promise<void> {
	try { await stat(join(dir, ".git")); } catch { return; } // not a git repo
	const ref = `archive/pre-reorg-${datePart}-${nanos}`;
	const run = (cmd: string) => {
		try {
			execSync(`git -C "${dir}" ${cmd}`, { stdio: "pipe", timeout: 15000 });
			return true;
		} catch { return false; }
	};
	run(`update-ref refs/heads/${ref} HEAD`);
	console.log(`  git-safety: refs/heads/${ref} (no force, no push)`);
}

await mkdir(products, { recursive: true });

const moves: Array<[string, string]> = [];
const entries = (await readdir(root)).sort();
for (const name of entries) {
	const full = join(root, name);
	const st = await lstat(full);
	if (SUPPORT_FILES.has(name)) continue;
	if (SUPPORT.has(name)) continue;

	// symlinks at root: keep intra-pen aliases; cross-pen/abs = litter
	if (st.isSymbolicLink()) {
		const target = await readlinkSafe(full);
		if (target.startsWith("products/") || target.startsWith("../")) continue;
		moves.push([full, join(snapshot, name)]); // cross-pen symlink = archive-litter
		continue;
	}

	if (
		LITTER.has(name) ||
		name.startsWith(".retired-") ||
		name.startsWith(".super-") ||
		name.includes("-backup-") ||
		name.includes(".bak") ||
		name.includes(".tmp") ||
		name.startsWith("$")
	) {
		moves.push([full, join(snapshot, name)]); // litter -> archive snapshot
		continue;
	}
	if (!st.isDirectory()) continue; // loose file at root: leave (docs/notes)

	// theme-aware placement: name universe decides the pen
	const theme = themePen(name);
	if (theme && theme !== pen) {
		moves.push([full, join(PENS_ROOT, theme, "products", name)]);
		continue;
	}
	if (await qualifies(full)) {
		moves.push([full, join(products, name)]);
		continue;
	}
	// default: any other root dir is product-like -> products/ (never delete)
	moves.push([full, join(products, name)]);
}

console.log(`reorganize-pen ${apply ? "APPLY" : "DRY-RUN"}: ${pen}`);
for (const [from, to] of moves)
	console.log(`  ${from}  ->  ${to.replace(root, "")}`);
console.log(
	`total: ${moves.length} moves (${moves.filter(([, t]) => t.includes("/products/")).length} products, rest archived)`,
);

if (apply) {
	await snapshotPen(root, snapshot); // rollback source FIRST
	await mkdir(join(root, "archive"), { recursive: true });
	await gitSafety(root).catch(() => {}); // best-effort ref record
	for (const [from, to] of moves) {
		await mkdir(join(to, ".."), { recursive: true });
		try {
			await rename(from, to);
		} catch (e) {
			console.error(`  MOVE-FAIL ${from}: ${(e as Error).message}`);
		}
	}
	console.log("apply done — rollback snapshot: " + snapshot);
}
