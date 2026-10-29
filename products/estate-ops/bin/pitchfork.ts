#!/usr/bin/env bun
/**
 * pitchfork.ts — Bun-native drop-in replacement for the legacy bash dispatch
 * shim bin/pitchfork. Thin, reliable: resolve the real pitchfork binary, apply
 * the same argv preprocessing (status->list shortcut, sovereign/ guard), then
 * exec the real binary with passthrough argv, inherited stdio, and the child's
 * exit code.
 *
 * Pure decision logic lives in pitchfork-lib.ts and is unit-tested there.
 *
 * Fleet note: keep this file exactly behavior-compatible with the old bash so
 * the whole fleet + reconcile + bin/pitchfork-restart keep working (in
 * particular `pitchfork status <name>` must still emit `PID:` / `Status:`).
 */
import { decideShim } from "./pitchfork-lib.ts";

const realArgs = process.argv.slice(2);

async function main(): Promise<void> {
  const decision = decideShim(realArgs, process.env, {});

  if (decision.kind === "no-binary") {
    process.stderr.write(decision.stderr + "\n");
    process.exit(decision.exitCode);
  }

  if (decision.kind === "refused") {
    for (const line of decision.stderr) process.stderr.write(line + "\n");
    process.exit(decision.exitCode);
  }

  // exec: inherit stdio, propagate the child's exit code, and adopt signals.
  const child = Bun.spawn([decision.bin, ...decision.argv], {
    cwd: process.cwd(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const code = await child.exited;
  if (child.signalCode) {
    process.kill(process.pid, child.signalCode);
  }
  // Re-signal ourselves for a true exec semantics on signal termination.
  process.exit(code ?? 1);
}

void main().catch((err) => {
  process.stderr.write("pitchfork: " + String(err) + "\n");
  process.exit(1);
});
