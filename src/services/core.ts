// ============================================================================
// ESTATE — Core Infrastructure Services
// ============================================================================
import type { ServiceDef } from "../types/index.ts";
export const CORE_SERVICES: ServiceDef[] = [
  {
    id: "herd",
    name: "herd",
    portKey: "HERD_PORT",
    run: "exec ./stack/services/herd.sh --host 127.0.0.1 --port ${HERD_PORT}",
    dir: "/home/toxic/estate",
    readyHttp: "/health",
    group: "core",
    autoStart: true,
    mise: true,
    healthPath: "/health",
  },
  {
    id: "qdrant",
    name: "qdrant",
    portKey: "QDRANT_PORT",
    run: "exec /home/toxic/.cargo/bin/qdrant-server --config-path ./qdrant-config.yaml",
    dir: ".",
    readyHttp: "/",
    group: "core",
    autoStart: true,
    mise: false,
    healthPath: "/",
  },
  {
    id: "redis",
    name: "redis",
    portKey: "REDIS_PORT",
    run: "exec redis-server --port ${REDIS_PORT} --bind 0.0.0.0 --dir ./data --dbfilename redis.rdb",
    dir: ".",
    readyPort: true,
    group: "core",
    autoStart: true,
    mise: false,
    healthPath: "/health",
  },
  {
    id: "tau",
    name: "tau",
    portKey: "PI_AGENT_PORT",
    // pi-agent was renamed tau (AFKS commit f88a84a). The engine lives at
    // /home/toxic/tau and its config root is .tau, not .pi -- an absolute
    // PI_CONFIG_DIR doubles to $HOME/$HOME/... (pi-utils/src/dirs.ts:112).
    run: "exec /home/toxic/.bun/bin/bun run /home/toxic/tau/packages/coding-agent/src/cli.ts --session-dir /home/toxic/.tau/agent/sessions",
    dir: "/home/toxic/estate",
    group: "core",
    autoStart: false,
    mise: false,
    healthPath: "/health",
  },
];
