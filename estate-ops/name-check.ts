#!/usr/bin/env bun
// name-check.ts — Estate name availability checker (comprehensive)
// Usable as CLI:  bun run name-check.ts <candidate>
// Usable as lib:  import { checkName } from "./name-check.ts";
// Excludes nothing — every real conflict is reported (deps included).

import { $ } from "bun";

export interface Conflict {
	source: string;
	match: string;
}

export interface NameCheckResult {
	candidate: string;
	conflicts: Conflict[];
	free: boolean;
}

const ESTATE = "/home/toxic/estate";

async function grepLines(file: string, pattern: string): Promise<string[]> {
	try {
		const proc = await $`grep -i ${pattern} ${file}`.quiet().nothrow();
		return proc.exitCode === 0 ? proc.stdout.toString().trim().split("\n").filter(Boolean) : [];
	} catch {
		return [];
	}
}

async function listDir(path: string): Promise<string[]> {
	try {
		const proc = await $`ls ${path}`.quiet().nothrow();
		return proc.exitCode === 0 ? proc.stdout.toString().trim().split("\n").filter(Boolean) : [];
	} catch {
		return [];
	}
}

export async function checkName(candidate: string): Promise<NameCheckResult> {
	const lower = candidate.toLowerCase();
	const upper = candidate.toUpperCase();
	const conflicts: Conflict[] = [];

	const collect = (source: string, matches: string[]) => {
		for (const m of matches) conflicts.push({ source, match: m });
	};

	// 1. Pitchfork daemons (pitchfork.toml + pitchfork.d/*.toml)
	const pfToplevel = await grepLines(`${ESTATE}/pitchfork.toml`, `daemons\\.[^]]*${lower}`);
	const pfDotd = await $`grep -ri ${candidate} ${ESTATE}/pitchfork.d/`.quiet().nothrow();
	if (pfToplevel.length) collect("Pitchfork daemons (pitchfork.toml)", pfToplevel);
	if (pfDotd.exitCode === 0 && pfDotd.stdout.toString().trim())
		collect("Pitchfork daemons (pitchfork.d/)", pfDotd.stdout.toString().trim().split("\n"));

	// 2. Ranch folders (recursive, but as dir basenames — vendor content counts)
	const ranchProc = await $`find ${ESTATE}/ranch -type d -iname "*${candidate}*"`.quiet().nothrow();
	if (ranchProc.exitCode === 0 && ranchProc.stdout.toString().trim())
		collect("Ranch dirs", ranchProc.stdout.toString().trim().split("\n").slice(0, 50));

	// 3. Port vars (config/ports.env)
	const ports = await grepLines(`${ESTATE}/config/ports.env`, `${lower.toUpperCase()}_`);
	if (ports.length) collect("Port vars (ports.env)", ports);

	// 4. Mise tasks
	const mise = await grepLines(`${ESTATE}/mise.toml`, `\\[tasks\\.[^]]*${lower}[^]]*\\]`);
	if (mise.length) collect("Mise tasks", mise);

	// 5. Service scripts
	const services = (await listDir(`${ESTATE}/stack/services`)).filter((f) => f.toLowerCase().includes(lower));
	if (services.length) collect("Service scripts", services);

	// 6. Estate config dirs/files
	const configs = (await listDir(`${ESTATE}/config`)).filter((f) => f.toLowerCase().includes(lower));
	if (configs.length) collect("Config entries", configs);

	// 7. Binaries
	const bins = (await listDir("/home/toxic/.local/bin")).filter((f) => f.toLowerCase().includes(lower));
	if (bins.length) collect("Binaries (~/.local/bin)", bins);

	// 8. Mise-installed tools
	const miseInstalls = (await listDir("/home/toxic/.local/share/mise/installs")).filter((f) =>
		f.toLowerCase().includes(lower),
	);
	if (miseInstalls.length) collect("Mise installs", miseInstalls);

	return { candidate, conflicts, free: conflicts.length === 0 };
}

function printResult(res: NameCheckResult): void {
	console.log(`=== Checking '${res.candidate}' ===\n`);
	if (res.conflicts.length === 0) {
		console.log("✅ FREE across all checked sources");
	} else {
		const bySource = new Map<string, string[]>();
		for (const c of res.conflicts) {
			const list = bySource.get(c.source) ?? [];
			list.push(c.match);
			bySource.set(c.source, list);
		}
		for (const [source, matches] of bySource) {
			console.log(`${source}:`);
			for (const m of matches.slice(0, 10)) console.log(`  - ${m}`);
			if (matches.length > 10) console.log(`  … +${matches.length - 10} more`);
		}
		console.log(`\n❌ ${res.conflicts.length} conflict(s) found`);
	}
}

if (import.meta.main) {
	const candidate = process.argv[2];
	if (!candidate) {
		console.error("Usage: bun run name-check.ts <candidate>");
		process.exit(1);
	}
	printResult(await checkName(candidate));
	process.exit((await checkName(candidate)).free ? 0 : 1);
}
