#!/usr/bin/env bun
// readme-gen.ts — thin per-pen entrypoint that delegates to the MASTER generator.
// The estate's one README generator is pens/toolkit/readme-gen.ts (driven by the
// product registry + git remotes + ports SSOT). This shim exists so
// `bun run readme` / `bun bin/readme-gen.ts` work from any pen; it is NOT a
// second generator.
import { execSync } from "node:child_process";
import { dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pen = basename(dirname(dirname(fileURLToPath(import.meta.url))));
const master = process.env.PENS_README_GEN || "/home/toxic/pens/toolkit/readme-gen.ts";
try {
  execSync(`bun ${master} --pen ${pen}`, { stdio: "inherit" });
} catch (e) {
  // master exits 2 on unknown pen or 1 on missing root — surface and re-raise
  process.exit((e as { status?: number }).status ?? 1);
}