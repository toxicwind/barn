#!/usr/bin/env bun
// estate bin/ffs-bun.ts — Bun wrapper around the estate bin/ffs Go binary.
// Replaces shell shims and enables Bun-native error handling + JSON piping.

import { spawnSync } from "child_process";
import { existsSync } from "fs";

const FFS_BIN = "/home/toxic/estate/bin/ffs";

async function main(): Promise<number> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: ffs-bun <command> [options]");
    console.error("");
    console.error("Commands: find, glob, grep, multi-grep, read, outline, symbol, callers, callees, refs, flow, siblings, deps, impact, index, map, overview, mention, guide, help");
    console.error("");
    console.error("All args forwarded to estate/bin/ffs Go binary.");
    return 1;
  }

  // Verify ffs binary exists
  if (!existsSync(FFS_BIN)) {
    process.stderr.write(`ffs-bun: ${FFS_BIN} not found\n`);
    return 127;
  }

  // Use Bun's native spawn (sync for CLI forwarding)
  const result = spawnSync(FFS_BIN, args, {
    stdio: "inherit",
    cwd: process.cwd(),
  });

  return result.status ?? 1;
}

const exitCode = await main();
process.exit(exitCode);
