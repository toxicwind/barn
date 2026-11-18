/**
 * Judge Model Fix Tool — reusable, importable tool to fix tau judge model configuration
 * 
 * Usage:
 *   import { fixJudgeModel, verifyJudgeModel } from './fix-judge-model.ts';
 *   await fixJudgeModel({ typeSafeKey: 'sk-typesafe-...' });
 */

import { readFile, writeFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_PATH = "/home/toxic/.tau/agent/config.yml";
const REAL_JUDGE = "typesafe/jev-latest";
const FALLBACK_JUDGES = [
  "typesafe/jev-latest",
  "freeinference/deepseek-v4-flash",
  "freeinference/qwen3.6-35b",
  "freeinference/glm-5.3-flash",
];

export interface FixResult {
  changes: string[];
  dryRun: boolean;
}

export interface VerifyResult {
  valid: boolean;
  issues: string[];
  config: any;
}

async function loadConfig(path: string = CONFIG_PATH): Promise<any> {
  const content = await readFile(path, "utf-8");
  return parse(content);
}

async function saveConfig(config: any, path: string = CONFIG_PATH): Promise<void> {
  const content = stringify(config);
  await writeFile(path + ".tmp", content, "utf-8");
  const { rename } = await import("node:fs/promises");
  await rename(path + ".tmp", path);
}

export async function fixJudgeModel(options: { typeSafeKey?: string; configPath?: string; dryRun?: boolean } = {}): Promise<FixResult> {
  const { typeSafeKey, configPath = CONFIG_PATH, dryRun = false } = options;
  const config = await loadConfig(configPath);
  
  const changes: string[] = [];
  
  // 1. Fix judge role
  if (config.modelRoles?.judge !== REAL_JUDGE) {
    changes.push(`modelRoles.judge: ${config.modelRoles?.judge} → ${REAL_JUDGE}`);
    if (!dryRun) config.modelRoles.judge = REAL_JUDGE;
  }
  
  // 2. Fix fallback chains for judge
  if (config.retry?.fallbackChains) {
    if (config.retry.fallbackChains.judge) {
      const current = config.retry.fallbackChains.judge;
      if (JSON.stringify(current) !== JSON.stringify(FALLBACK_JUDGES)) {
        changes.push(`retry.fallbackChains.judge: updated to prioritize ${REAL_JUDGE}`);
        if (!dryRun) config.retry.fallbackChains.judge = FALLBACK_JUDGES;
      }
    } else {
      changes.push(`retry.fallbackChains.judge: added`);
      if (!dryRun) config.retry.fallbackChains.judge = FALLBACK_JUDGES;
    }
  }
  
  // 3. Update default fallback chain
  if (config.retry?.fallbackChains?.default) {
    const current = config.retry.fallbackChains.default;
    const hasRealJudge = current.some((m: string) => m.startsWith("typesafe/"));
    if (!hasRealJudge) {
      changes.push(`retry.fallbackChains.default: prepended ${REAL_JUDGE}`);
      if (!dryRun) config.retry.fallbackChains.default = [REAL_JUDGE, ...current];
    }
  }
  
  if (!dryRun) {
    await saveConfig(config, configPath);
  }
  
  return { changes, dryRun };
}

export async function verifyJudgeModel(configPath: string = CONFIG_PATH): Promise<VerifyResult> {
  const config = await loadConfig(configPath);
  const issues: string[] = [];
  
  if (config.modelRoles?.judge !== REAL_JUDGE) {
    issues.push(`modelRoles.judge is "${config.modelRoles?.judge}", expected "${REAL_JUDGE}"`);
  }
  
  const judgeChain = config.retry?.fallbackChains?.judge || [];
  if (judgeChain[0] !== REAL_JUDGE) {
    issues.push(`retry.fallbackChains.judge[0] is "${judgeChain[0]}", expected "${REAL_JUDGE}"`);
  }
  
  const defaultChain = config.retry?.fallbackChains?.default || [];
  if (!defaultChain.some((m: string) => m.startsWith("typesafe/"))) {
    issues.push(`retry.fallbackChains.default missing typesafe/ model`);
  }
  
  return { valid: issues.length === 0, issues, config };
}

export async function addTypeSafeKey(key: string): Promise<void> {
  const { execSync } = await import("child_process");
  execSync(`echo "${key}" | secretsmith set --stdin TYPE_SAFE_API_KEY`, { stdio: "inherit" });
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const typeSafeKey = args.find(a => a.startsWith("--key="))?.split("=")[1];
  
  console.log("=== Judge Model Fix ===");
  console.log(`Config: ${CONFIG_PATH}`);
  console.log(`Dry run: ${dryRun}`);
  
  if (dryRun) {
    const config = await loadConfig();
    console.log("\nCurrent judge:", config.modelRoles?.judge);
    console.log("Current judge fallback chain:", config.retry?.fallbackChains?.judge);
    console.log("Current default fallback chain:", config.retry?.fallbackChains?.default);
  } else {
    const result = await fixJudgeModel({ typeSafeKey, dryRun: false });
    console.log("\nChanges applied:");
    for (const c of result.changes) console.log(`  - ${c}`);
    
    if (typeSafeKey) {
      await addTypeSafeKey(typeSafeKey);
      console.log("TypeSafe key added to keyring");
    }
    
    const verification = await verifyJudgeModel();
    console.log("\nVerification:", verification.valid ? "✅ PASSED" : "❌ FAILED");
    for (const issue of verification.issues) console.log(`  - ${issue}`);
  }
}