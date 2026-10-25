// ============================================================================
// ESTATE — GHAS Stack Services
// ============================================================================

import type { ServiceDef } from "../types/index.ts";

export const GHAS_SERVICES: ServiceDef[] = [
  {
    id: "search-api",
    name: "search-api",
    portKey: "GHAS_API_PORT",
    run: "exec bun --hot run apps/api/src/server.ts",
    dir: "/home/toxic/projects/github-advanced-search-mcp",
    readyHttp: "/health",
    group: "core",
    autoStart: true,
    mise: true,
    env: { GHAS_API_PORT: 25112 },
    healthPath: "/health",
  },
  {
    id: "search-ui",
    name: "search-ui",
    portKey: "GHAS_FRONTEND_PORT",
    run: "exec ./node_modules/.bin/next dev -p 25114",
    dir: "/home/toxic/projects/github-advanced-search-mcp/apps/frontend",
    readyHttp: "/",
    group: "core",
    autoStart: true,
    mise: true,
    env: { GHAS_FRONTEND_PORT: "25114" },
    healthPath: "/",
  },
];
