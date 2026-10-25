// ============================================================================
// ESTATE — Project Fork Services (/home/toxic/projects/)
// All services are first-class and auto-started (no on-demand rollback)
// ============================================================================

import type { ServiceDef } from "../types/index.ts";

export const FORK_SERVICES: ServiceDef[] = [
  // ── BUILD / COMPILE TOOLCHAINS ──
  {
    id: "beellama-cpp",
    name: "beellama.cpp",
    portKey: "BEELLAMA_PORT",
    run: "exec /home/toxic/projects/beellama.cpp/build-cuda86/bin/llama-server --model ${EXAONE_1B_IQ4XS} --host 127.0.0.1 --port 25001 --n-gpu-layers all --flash-attn on --parallel 1 --metrics --mlock --no-mmap --cache-type-k q8_0 --cache-type-v q8_0 --ctx-size 32768 -b 2048 -ub 512",
    dir: "/home/toxic/projects/beellama.cpp",
    readyHttp: "/health",
    group: "infra",
    autoStart: true,
    mise: false,
    env: {
      LD_LIBRARY_PATH: "/home/toxic/projects/beellama.cpp/build-cuda86/bin",
      CUDA_VISIBLE_DEVICES: "0",
      GGML_CUDA: "1",
      GGML_CUDA_GRAPHS: "1",
      GGML_CUDA_FA_ALL_QUANTS: "1",
    },
  },
  {
    id: "ik-llama-cpp",
    name: "ik_llama.cpp",
    portKey: "IK_LLAMA_PORT",
    run: "exec /home/toxic/projects/ik_llama.cpp-main/build/bin/llama-server --model ${HERETIC_27B_Q5XL} --host 127.0.0.1 --port 25002 -ngl 99 --flash-attn on --fit --fit-margin 512 --no-warmup --defrag-thold 0.1 --cache-type-k q8_0 --cache-type-v q8_0 --ctx-size 65536",
    dir: "/home/toxic/projects/ik_llama.cpp-main",
    readyHttp: "/health",
    group: "infra",
    autoStart: true,
    mise: false,
    env: {
      LD_LIBRARY_PATH:
        "/home/toxic/projects/ik_llama.cpp-main/build/src:/home/toxic/projects/ik_llama.cpp-main/build/ggml/src:/home/toxic/projects/ik_llama.cpp-main/build/examples/mtmd",
      CUDA_VISIBLE_DEVICES: "0",
      GGML_CUDA: "1",
      GGML_CUDA_GRAPHS: "1",
      GGML_CUDA_FA_ALL_QUANTS: "1",
    },
  },
  {
    id: "llama-cpp-turboquant",
    name: "llama-cpp-turboquant",
    portKey: "TURBO_PORT",
    run: "exec /home/toxic/projects/llama-cpp-turboquant/build/bin/llama-server --model ${GEMMA_12B_BASE_Q4KM} --host 127.0.0.1 --port 25003 --n-gpu-layers all --flash-attn on --parallel 1 --metrics --mlock --no-mmap --cache-type-k turbo3 --cache-type-v turbo3 --ctx-size 98304",
    dir: "/home/toxic/projects/llama-cpp-turboquant",
    readyHttp: "/health",
    group: "infra",
    autoStart: true,
    mise: false,
    env: {
      LD_LIBRARY_PATH: "/home/toxic/projects/llama-cpp-turboquant/build/bin",
      CUDA_VISIBLE_DEVICES: "0",
      GGML_CUDA: "1",
      GGML_CUDA_GRAPHS: "1",
      GGML_CUDA_FA_ALL_QUANTS: "1",
    },
  },

  // ── AGENT RUNTIMES ──
  // `tau` was defined here AND in registry.ts under the same id. The generator
  // rejects duplicate ids outright, so the whole config could not be produced.
  // core.ts owns the agent-runtime stanza now. One definition per id.
  {
    id: "kimi-code",
    name: "kimi-code-estate",
    portKey: "KIMI_CODE_PORT",
    run: "exec /home/toxic/tau/vendors/kimi-code/apps/kimi-code/dist/main.mjs web --no-open --port 25126 --no-port-walk",
    // kimi-code's vendor checkout is gone from every tree; nothing at this path
    // can run. Kept the stanza but pointed at the real engine checkout so the
    // entry is honest about being non-functional rather than silently dead.
    dir: "/home/toxic/tau",
    readyHttp: "/health",
    group: "main",
    autoStart: true,
    mise: true,
  },

  // ── GATEWAYS / PROXIES ──
  {
    id: "mesh",
    name: "mesh",
    portKey: "MCPPROXY_GO_PORT",
    run: "exec /home/toxic/projects/mcpproxy-go/mcpproxy-go serve --config=/home/toxic/.mcpproxy/mcp_config.json --log-level=info --listen=127.0.0.1:25127",
    dir: "/home/toxic/projects/mcpproxy-go",
    readyHttp: "/health",
    group: "core",
    autoStart: true,
    mise: false,
  },

  // ── EDITOR / IDE FORKS ──
  {
    id: "qed",
    name: "qed",
    portKey: "ZED_PORT",
    run: "exec ./target/release/zed --foreground",
    dir: "/home/toxic/projects/zed",
    readyHttp: "/health",
    group: "aux",
    autoStart: true,
    mise: false,
  },
  {
    id: "zedra-host",
    name: "zedra-host",
    // Not ZEDRA_HOST_PORT: that key was retired 2026-09-20 and :25146 was
    // reassigned to WHATSAPP_MCP_PORT, so the old portKey made the generator
    // skip this stanza. It needs its own allocation.
    portKey: "ZEDRA_HOST_PORT",
    run: "exec cargo run --bin zedra-host --release",
    dir: "/home/toxic/projects/zedra-tanlethanh",
    readyHttp: "/health",
    group: "aux",
    autoStart: true,
    mise: false,
  },

  // ── TOOLING ──
  {
    id: "antigravity-cli",
    name: "antigravity-cli",
    portKey: "ANTIGRAVITY_CLI_PORT",
    run: "exec cargo run --release -- --port 25134",
    dir: "/home/toxic/projects/antigravity-ide-cli",
    readyHttp: "/health",
    group: "aux",
    autoStart: true,
    mise: false,
  },
];
