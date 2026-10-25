import { writeFileSync } from "fs";
import { localAudit } from "./local-audit.js";
import { preCheck } from "./modules/precheck.js";
import { autoFix } from "./modules/autofix.js";
import { analyzeWithCompletions } from "./modules/completions.js";
import { exportParquet } from "./modules/parquet.js";

const JSON_OUT = process.argv.includes("--json") ? "output/local-audit.json" : null;
const PARQUET_PATH = process.argv.includes("--parquet") ? "local-repos.parquet" : null;
const AUTOFIX = process.argv.includes("--fix");
const COMPLETIONS = process.argv.includes("--completions");

async function main(): Promise<void> {
  const checks = preCheck();
  if (checks.length > 0) console.log("Pre-check:\n" + checks.join("\n"));

  const result = await localAudit([], { type: "full", autoFix: AUTOFIX, preCheck: false, completions: COMPLETIONS });

  if (result.total === 0) {
    console.error("No repositories found.");
    process.exit(1);
  }

  console.log(`\nAudit completed in ${result.durationMs.toFixed(2)}ms`);
  console.log(`Found ${result.total} projects`);

  if (AUTOFIX) {
    const fixes = autoFix(result);
    if (fixes.length > 0) {
      console.log("\nAuto-fixes applied:");
      for (const fix of fixes) console.log(`  - ${fix}`);
    } else {
      console.log("\nNo auto-fixes needed.");
    }
  }

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
    console.log(`\nJSON results written to ${JSON_OUT}`);
  }

  if (PARQUET_PATH) {
    await exportParquet(result, PARQUET_PATH);
    console.log(`Parquet results written to ${PARQUET_PATH}`);
  }

  const byArea: Record<string, number> = {};
  for (const record of result.records) {
    byArea[record.area] = (byArea[record.area] || 0) + 1;
  }
  console.log("\nBy area:");
  for (const [area, count] of Object.entries(byArea)) {
    console.log(`  ${area}: ${count}`);
  }

  if (COMPLETIONS && result.records.length > 0) {
    try {
      const insight = await analyzeWithCompletions(`Analyze ${result.records.length} repos for security issues.`);
      console.log(`\nCompletions insight: ${insight.slice(0, 200)}`);
    } catch (e) {
      console.log(`Completions failed: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
