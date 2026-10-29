/**
 * index.ts — the single export surface for the provider system.
 *
 * Re-exports every provider module plus the shared contracts (types) and
 * transport/key helpers (http), and the table-driven registry. `src/providers.ts`
 * is now a thin shim that simply re-exports this barrel so legacy importers
 * (`import * as P from "./providers"`) keep working unchanged.
 */
export * from "./types";
export * from "./http";

export * from "./github";
export * from "./arxiv";
export * from "./openalex";
export * from "./semanticscholar";
export * from "./dblp";
export * from "./npm";
export * from "./stackoverflow";
export * from "./hf_papers";
export * from "./web";
export * from "./exa";
export * from "./local";
export * from "./tldr";
export * from "./pattern-borrow";

export { PROVIDERS } from "./registry";
