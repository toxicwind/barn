/**
 * ML Dictionary & Vocabulary Indexer
 *
 * Implements a semantic token dictionary, n-gram indexing, and
 * fast term vectorization in Bun 1.4 TypeScript for pattern-forge.
 */

export interface TokenEntry {
  term: string;
  frequency: number;
  idf: number;
  category: "ml" | "nlp" | "systems" | "tooling" | "general";
  synonyms: string[];
}

export class MLDictionary {
  private vocab: Map<string, TokenEntry> = new Map();
  private totalDocs = 0;

  constructor() {
    this.seedDefaultMLTerms();
  }

  private seedDefaultMLTerms(): void {
    const defaultTerms: Array<[string, "ml" | "nlp" | "systems" | "tooling", string[]]> = [
      ["transformer", "nlp", ["attention", "bert", "gpt", "decoder"]],
      ["attention", "nlp", ["self-attention", "cross-attention", "flash-attention"]],
      ["embedding", "nlp", ["vector", "representation", "latent"]],
      ["token", "nlp", ["subword", "bpe", "wordpiece", "tiktoken"]],
      ["vocabulary", "nlp", ["lexicon", "dictionary", "tokens"]],
      ["sandboxing", "systems", ["isolation", "seccomp", "namespaces", "container"]],
      ["deadline", "systems", ["timeout", "budget", "wall-clock", "expiration"]],
      ["guardrail", "ml", ["policy", "sanitizer", "firewall", "moderation"]],
      ["hook", "tooling", ["interception", "callback", "trap", "instrumentation"]],
      ["observability", "systems", ["telemetry", "tracing", "profiling", "metrics"]],
      ["shell", "tooling", ["bash", "zsh", "repl", "command-line"]],
      ["injection", "systems", ["sanitization", "escaping", "validation"]],
      ["fine-tuning", "ml", ["lora", "qlora", "sft", "rlhf", "dpo"]],
      ["inference", "systems", ["generation", "forward-pass", "latency", "throughput"]],
      ["quantization", "systems", ["gguf", "awq", "gptq", "bitsandbytes"]],
      ["mcp", "tooling", ["model-context-protocol", "tools", "gateway", "rpc"]],
      ["rag", "nlp", ["retrieval", "hybrid-search", "bm25", "vector-db"]],
      ["semantic", "nlp", ["similarity", "meaning", "embedding-distance"]],
      ["context", "nlp", ["context-window", "prompt", "kv-cache"]],
      ["latency", "systems", ["ttft", "tps", "response-time", "p99"]],
    ];

    for (const [term, category, synonyms] of defaultTerms) {
      this.vocab.set(term, {
        term,
        frequency: 1,
        idf: 1.0,
        category,
        synonyms,
      });
    }
  }

  /**
   * Tokenize and normalize text into dictionary keys
   */
  public tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  /**
   * Ingest a corpus document to update frequencies and compute IDF
   */
  public ingest(documentText: string): void {
    this.totalDocs++;
    const tokens = new Set(this.tokenize(documentText));

    for (const t of tokens) {
      const entry = this.vocab.get(t);
      if (entry) {
        entry.frequency++;
      } else {
        this.vocab.set(t, {
          term: t,
          frequency: 1,
          idf: 0,
          category: "general",
          synonyms: [],
        });
      }
    }

    // Recompute IDF across the vocabulary
    for (const entry of this.vocab.values()) {
      entry.idf = Math.log(1 + this.totalDocs / (1 + entry.frequency));
    }
  }

  /**
   * Look up a term in the dictionary with synonym expansions
   */
  public lookup(term: string): TokenEntry | undefined {
    return this.vocab.get(term.toLowerCase());
  }

  /**
   * Expand query tokens using ML domain synonyms
   */
  public expandQuery(query: string): string[] {
    const tokens = this.tokenize(query);
    const expanded = new Set<string>(tokens);

    for (const t of tokens) {
      const entry = this.vocab.get(t);
      if (entry && entry.synonyms.length > 0) {
        for (const syn of entry.synonyms) {
          expanded.add(syn);
        }
      }
    }

    return Array.from(expanded);
  }

  /**
   * Size of the active vocabulary
   */
  public get size(): number {
    return this.vocab.size;
  }

  /** Query expansion: for each known term in the query, add 1-2 synonyms. */
  expand(query: string, maxTerms = 4): string {
    const words = query.toLowerCase().split(/[^a-z0-9.-]+/).filter(Boolean);
    const extras = new Set<string>();
    for (const [term, _cat, syns] of this.seedDefaultMLTerms === undefined ? [] : []) void [term, _cat, syns];
    for (const w of words) {
      const entry = this.vocab.get(w) ?? this.vocab.get(w.replace(/s$/, ""));
      if (entry) for (const s of entry.synonyms.slice(0, 2)) extras.add(s);
      if (extras.size >= maxTerms) break;
    }
    return extras.size ? `${query} ${[...extras].join(" ")}` : query;
  }
}
