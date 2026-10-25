// ============================================================================
// ESTATE — Bun Runtime Service (First-Class)
// ============================================================================

import type { ServiceDef } from "../types/index.ts";

export const BUN_RUNTIME_SERVICE: ServiceDef = {
  id: "bun-runtime",
  name: "bun-runtime",
  portKey: "BUN_RUNTIME_PORT",
  run: "exec /home/toxic/projects/bun/bun --version",
  dir: "/home/toxic/projects/bun",
  readyCmd: "/home/toxic/projects/bun/bun --version",
  group: "core",
  autoStart: false,
  mise: false,
  healthPath: "/health",
  watch: [
    "/home/toxic/projects/bun/src/**/*.ts",
    "/home/toxic/projects/bun/src/**/*.zig",
  ],
};

export const BUN_DEV_SERVICE: ServiceDef = {
  id: "bun-dev",
  name: "bun-dev-server",
  portKey: "BUN_DEV_PORT",
  run: "exec /home/toxic/projects/bun/bun --hot run /home/toxic/estate/src/index.ts",
  dir: "/home/toxic/projects/bun",
  readyCmd: "sleep 3 && echo ready",
  group: "core",
  autoStart: false,
  mise: false,
  healthPath: "/health",
};
