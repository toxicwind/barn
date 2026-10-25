// llama-server model registry — first class, no Ollama indirection
// Models are loaded directly by llama-server with --model /path/to/gguf

export interface LlamaModel {
  id: string;
  name: string;
  ggufPath: string; // Absolute path on server filesystem
  contextWindow: number;
  quantization: string; // Q4_K_M, Q5_K_S, etc
  vramGB: number; // Estimated VRAM at full context
  description: string;
  chatTemplate?: string; // --chat-template name
  draftModel?: string; // DFlash speculative decoding model path
  cacheTypeK?: string; // --cache-type-k (e.g., "f16", "q4_0", "q8_0")
  flashAttn?: boolean; // --flash-attn
}

export const llamaModels: LlamaModel[] = [
  // Qwen family — primary for sm_86 / RTX 3090 24GB
  {
    id: "qwen3.6-27b-q5",
    name: "Qwen 3.6 27B Q5_K_S",
    ggufPath: "~/models/Qwen3.6-27B-Q5_K_S.gguf",
    contextWindow: 262144,
    quantization: "Q5_K_S",
    vramGB: 14,
    description:
      "DeltaNet hybrid, 262K context, polyglot. Primary model for 24GB VRAM.",
    chatTemplate: "qwen",
    cacheTypeK: "f16",
    flashAttn: true,
  },
  {
    id: "qwen3.6-27b-dflash",
    name: "Qwen 3.6 27B + DFlash drafter",
    ggufPath: "~/models/Qwen3.6-27B-Q5_K_S.gguf",
    contextWindow: 262144,
    quantization: "Q5_K_S + Q4_K_M drafter",
    vramGB: 18, // 14GB main + 4GB drafter
    description:
      "Speculative decoding with DFlash. Up to 4.4x speedup, 67-89% acceptance.",
    chatTemplate: "qwen",
    draftModel: "~/models/Qwen3.6-27B-DFlash-Q4_K_M.gguf",
    cacheTypeK: "turbo3_tcq", // Reduces KV cache by ~50%
    flashAttn: true,
  },
  // Meta Llama family
  {
    id: "llama3.1-70b-q4",
    name: "Llama 3.1 70B Q4_K_M",
    ggufPath: "~/models/Llama-3.1-70B-Q4_K_M.gguf",
    contextWindow: 128000,
    quantization: "Q4_K_M",
    vramGB: 40, // Too big for single 24GB, needs split
    description:
      "Meta Llama 3.1 70B. Requires tensor split across 2x GPUs or CPU offload.",
    chatTemplate: "llama3",
    flashAttn: true,
  },
  {
    id: "llama3.2-3b-q8",
    name: "Llama 3.2 3B Q8_0",
    ggufPath: "~/models/Llama-3.2-3B-Q8_0.gguf",
    contextWindow: 128000,
    quantization: "Q8_0",
    vramGB: 3.5,
    description: "Fast edge model. Fits on low-VRAM nodes, CDP/WebGPU workers.",
    chatTemplate: "llama3",
    flashAttn: true,
  },
  {
    id: "llama4-maverick-17b-128e",
    name: "Llama 4 Maverick 17B 128E",
    ggufPath: "~/models/Llama-4-Maverick-17B-128E-Q4_K_M.gguf",
    contextWindow: 262000,
    quantization: "Q4_K_M",
    vramGB: 12,
    description:
      "MoE architecture. 17B active params, 128E total. Best quality/VRAM ratio.",
    chatTemplate: "llama4",
    flashAttn: true,
  },
  // Small / edge models for CDP nodes
  {
    id: "phi-3-mini",
    name: "Phi-3 Mini 3.8B",
    ggufPath: "~/models/Phi-3-mini-4k-instruct-Q4_K_M.gguf",
    contextWindow: 4096,
    quantization: "Q4_K_M",
    vramGB: 2.5,
    description: "Microsoft Phi-3. Fast, small context. Browser/CDP friendly.",
    chatTemplate: "phi3",
  },
  {
    id: "gemma-2b",
    name: "Gemma 2B",
    ggufPath: "~/models/gemma-2b-it-Q4_K_M.gguf",
    contextWindow: 8192,
    quantization: "Q4_K_M",
    vramGB: 1.5,
    description:
      "Google Gemma 2B. Tiny, fast. WebGPU inference in Chrome tabs.",
    chatTemplate: "gemma",
  },
  // StrangeMerges — custom merged model
  {
    id: "StrangeMerges_19",
    name: "StrangeMerges 19",
    ggufPath: "~/models/StrangeMerges_19-Q4_K_M.gguf",
    contextWindow: 128000,
    quantization: "Q4_K_M",
    vramGB: 8,
    description: "Custom merged model for estate inference. 7B active.",
    chatTemplate: "chatml",
    flashAttn: true,
  },
];

export function findModel(id: string): LlamaModel | undefined {
  return llamaModels.find((m) => m.id === id);
}

export function modelsForVRAM(vramGB: number): LlamaModel[] {
  return llamaModels
    .filter((m) => m.vramGB <= vramGB)
    .sort((a, b) => b.vramGB - a.vramGB);
}
