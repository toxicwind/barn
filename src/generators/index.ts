// ============================================================================
// RETIRED 2026-09-14 — DO NOT RUN.
// pitchfork.toml and mise.toml are now the source of truth, edited directly.
// Running this generator OVERWRITES pitchfork.toml and DESTROYS native additions
// (coyote env, free-zed-gateway, tau path fix, dnsmasq, hand-tuned readiness).
// Audit 2026-09-14: generator defines 36 services, pitchfork has 28 daemons.
// 11 generator-only services are superseded (llama.cpp forks -> herd), dev-only,
// or not running. 3 pitchfork daemons (dnsmasq, free-zed-gateway, tau-code) were
// added natively post-generator. Generator sources kept for reference only.
// Open: fate of antigravity-cli, pi-agent, pi-web-dashboard, qed, zedra-host
// (defined in generator, not in pitchfork, not observed running).
// ============================================================================
// ============================================================================
// ESTATE — Generator Index
// ============================================================================

import { join } from "node:path";
import { ALL_SERVICES } from "../services/index.ts";
import type { Generator, TemplateContext } from "../types/index.ts";
import { parsePortsEnv } from "../utils/ports.ts";
import { miseGenerator } from "./mise.ts";
import { pitchforkGenerator } from "./pitchfork.ts";

const GENERATORS: Generator[] = [pitchforkGenerator, miseGenerator];

export async function generateAll(root: string = process.cwd()): Promise<void> {
  console.log(
    "🔧 Generating estate configs from ports.env + service definitions...",
  );

  // Deduplicate services by id (keep the first occurrence)
  const seen = new Set<string>();
  const uniqueServices = ALL_SERVICES.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });

  // Build context
  const ports = parsePortsEnv(root);
  const portsRecord: Record<string, number> = {};
  for (const [k, v] of ports) portsRecord[k] = v;

  // Validate all required ports exist
  const requiredKeys = uniqueServices.map((s) => s.portKey);
  const missing = requiredKeys.filter((k) => !ports.has(k));
  if (missing.length > 0) {
    console.error("❌  Missing port keys:", missing.join(", "));
    process.exit(1);
  }

  const ctx: TemplateContext = {
    ports: portsRecord,
    services: uniqueServices, // use deduplicated list
    groups: { core: uniqueServices.map((s) => s.id) },
    timestamp: new Date().toISOString(),
    sovRoot: root,
  };

  // Run all generators
  for (const gen of GENERATORS) {
    const output = gen.generate(ctx);
    const outputPath = join(root, gen.outputPath);
    await Bun.write(outputPath, output);
    console.log(`✅  ${gen.name} generated (${output.length} chars)`);
  }

  console.log("\n📊 Summary:");
  console.log(`  Services: ${uniqueServices.length}`);
  console.log(
    `  Auto-start: ${uniqueServices.filter((s) => s.autoStart).length} always-on`,
  );
  console.log(
    `  On-demand: ${uniqueServices.filter((s) => !s.autoStart).length} triggered`,
  );
  console.log(`  Ports loaded: ${ports.size}`);
  console.log(`  Generators: ${GENERATORS.length}`);
}
