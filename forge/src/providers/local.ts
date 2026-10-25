/**
 * local.ts — in-tree AST-BM25 hybrid local code search provider.
 *
 * Signature and behavior preserved from the monolithic providers.ts. Builds
 * the BM25 index over the estate root and runs a hybrid query.
 */
import { buildIndex } from "../repo-index";
import { Bm25Index } from "../bm25";
import { ESTATE } from "../paths";
import { type CodeItem, type SourceResult } from "./types";

/** In-tree AST-BM25 hybrid local code search. */
export async function localTreeSearch(
  query: string,
  maxResults = 10,
  root = ESTATE,
): Promise<SourceResult> {
  const t0 = performance.now();
  try {
    const idx = buildIndex(root, 10_000);
    const bm = new Bm25Index(idx.files);
    const hits = bm.search(query, maxResults);
    const items: CodeItem[] = hits.map((h) => ({
      name: h.path.split("/").pop() ?? h.path,
      path: h.path,
      repo: "local/estate",
      html_url: `file://${h.path}`,
      score: h.score,
    }));
    return {
      ok: true,
      items,
      cost: "free",
      timingMs: performance.now() - t0,
      totalCount: items.length,
    };
  } catch (err) {
    return {
      ok: false,
      items: [],
      cost: "free",
      timingMs: performance.now() - t0,
      error: String(err),
    };
  }
}
