#!/usr/bin/env bun
/**
 * pattern-borrow.ts — GitHub-wide + in-tree pattern ranker / borrower (Forge modular integration).
 *
 * Delegates directly to the modular Forge provider in
 * `grasp-hub/skills/04_code_intelligence/code-patterns/src/providers/pattern-borrow.ts`.
 *
 * CLI:
 *   bun run scripts/pattern-borrow.ts [patterns...] [--top N] [--per-page N]
 *                              [--weights k=v,...] [--text] [--local-only] [--interactive] [--help]
 */
import { parseArgs } from "node:util";
import {
  DEFAULT_PATTERN_WEIGHTS,
  type PatternFactor,
  type PatternWeights,
  patternBorrow,
  rankPatternRows,
  collectTopPatternRepos,
  renderPatternBorrow,
} from "../grasp-hub/skills/04_code_intelligence/code-patterns/src/providers/pattern-borrow";

export {
  DEFAULT_PATTERN_WEIGHTS,
  type PatternFactor,
  type PatternWeights,
  patternBorrow,
  rankPatternRows,
  collectTopPatternRepos,
  renderPatternBorrow,
};

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      top: { type: "string" },
      perPage: { type: "string" },
      "per-page": { type: "string" },
      weights: { type: "string" },
      text: { type: "boolean" },
      "local-only": { type: "boolean" },
      interactive: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    console.log(
      `Usage: bun run pattern-borrow.ts [patterns...] [--top N] [--per-page N] [--weights k=v,...] [--text] [--local-only] [--interactive] (default output: JSON)`,
    );
    process.exit(0);
  }

  const W: PatternWeights = { ...DEFAULT_PATTERN_WEIGHTS };
  if (typeof values.weights === "string" && values.weights) {
    for (const kv of values.weights.split(",")) {
      const [k, v] = kv.split("=");
      if (k && v && k in DEFAULT_PATTERN_WEIGHTS) {
        W[k as PatternFactor] = Number(v);
      }
    }
  }

  const top = Number(values.top ?? (positionals.length ? positionals.length : 5));
  const perPage = Number(values.perPage ?? values["per-page"] ?? 5);

  const result = await patternBorrow({
    patterns: positionals.length ? positionals : undefined,
    top,
    perPage,
    weights: W,
    localOnly: values["local-only"] === true,
  });

  console.log(renderPatternBorrow(result, values.text === true));

  if (values.interactive) {
    console.log(
      "\ninteractive: type 'w factor=weight' (e.g. 'w bugRel=0.4'), 'p' to reprint, 'q' quit",
    );
    process.stdin.on("data", (d: Buffer) => {
      const line = d.toString().trim();
      if (line === "q") process.exit(0);
      if (line === "p") {
        rankPatternRows(result.rows, W);
        result.topRepos = collectTopPatternRepos(result.rows, top, top);
        console.log(renderPatternBorrow(result, values.text === true));
        return;
      }
      const m = line.match(/^w\s+(\w+)=([\d.]+)$/);
      if (m && m[1] && m[1] in DEFAULT_PATTERN_WEIGHTS) {
        W[m[1] as PatternFactor] = Number(m[2]);
        rankPatternRows(result.rows, W);
        result.topRepos = collectTopPatternRepos(result.rows, top, top);
        console.log(renderPatternBorrow(result, values.text === true));
      }
    });
  }
}
