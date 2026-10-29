#!/usr/bin/env node
// chute — TCP <-> stdio ACP passage for the herd.
// Entry point. Thin dispatcher over src/.
//
// Usage:
//   chute [--port N] [--check] -- <cmd> [args...]
//
// See README.md for protocol behavior and design notes.

import { parseArgs } from "./src/args.mjs";
import { runCheck } from "./src/check.mjs";
import { createChuteServer } from "./src/server.mjs";
import { log } from "./src/log.mjs";

async function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (!parsed.valid) {
    if (parsed.error) log("", parsed.error);
    else log("", "usage: chute [--port N] [--check] -- <cmd> [args...]");
    process.exit(2);
  }

  if (parsed.check) {
    const r = await runCheck();
    process.stdout.write(JSON.stringify(r) + "\n");
    process.exit(r.ready ? 0 : 1);
  }

  createChuteServer({ port: parsed.port, cmd: parsed.cmd }).listen();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log("", sig + " received, exiting");
      process.exit(0);
    });
  }
}

main().catch((e) => {
  log("", "fatal: " + e.message);
  process.exit(1);
});
