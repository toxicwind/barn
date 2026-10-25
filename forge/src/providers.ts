/**
 * providers.ts — compatibility shim.
 *
 * The monolithic provider implementation has been modularized into
 * src/providers/ (one file per source + registry + index). This file now just
 * re-exports that barrel so legacy importers (`import * as P from "./providers"`
 * in borrow.ts/cli.ts, and `../src/providers` in tests) keep resolving the same
 * names without change.
 */
export * from "./providers/index";
