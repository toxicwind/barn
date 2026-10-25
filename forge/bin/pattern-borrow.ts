#!/usr/bin/env bun
/**
 * pattern-borrow — dedicated CLI tool to borrow code & patterns across GitHub,
 * arXiv, Hugging Face, OpenAlex, Semantic Scholar, and local sources.
 *
 * Built directly on Bun 1.4 for pattern-forge.
 */

import { borrow, renderBorrow, type SourceName } from "../src/borrow";

const args = process.argv.slice(2);

function showHelp() {
  console.log(`
pattern-borrow (Bun 1.4 / pattern-forge)

Usage:
  pattern-borrow "<query>" [options]
  bun bin/pattern-borrow.ts "<query>" [options]

Options:
  --top <N>          Number of ranked results to display (default: 10)
  --per-source <N>   Number of candidates to fetch per source (default: 5)
  --skip <sources>   Comma-separated sources to skip (github, local, arxiv, etc.)
  --json             Output raw JSON result
  --help, -h         Show this help message
`);
}

async function main() {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    showHelp();
    process.exit(0);
  }

  let query = "";
  let top = 10;
  let perSource = 5;
  let skipList: string[] = [];
  let isJson = false;
  let quiet = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--top" || arg === "-n") {
      top = Number(args[++i]) || 5;
    } else if (arg === "--per-source") {
      perSource = Number(args[++i]) || 3;
    } else if (arg === "--skip") {
      skipList = (args[++i] || "").split(",").map((s) => s.trim().toLowerCase());
    } else if (arg === "--json") {
      isJson = true;
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
      process.env.FORGE_QUIET = "1";
    } else if (!arg.startsWith("--") && !query) {
      query = arg;
    }
  }

  if (!query) {
    console.error("Error: query string is required.");
    process.exit(1);
  }

  const skip = new Set<SourceName>(skipList as SourceName[]);

  const result = await borrow(query, {
    perSource,
    skip,
  });

  if (isJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const rendered = renderBorrow(result, top);
    if (quiet) {
      // Print only top titles and URLs without noisy headers/abstracts
      for (const [idx, item] of result.ranked.slice(0, top).entries()) {
        const title = (item.item as any).name || (item.item as any).title || "item";
        const url = (item.item as any).html_url || (item.item as any).url || "";
        console.log(`${idx + 1}. [${item.source}] ${title} -> ${url}`);
      }
    } else {
      console.log(rendered);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
