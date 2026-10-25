// ============================================================================
// ESTATE — Peripheral Services (Optional)
// ============================================================================

import type { ServiceDef } from "../types/index.ts";

export const PERIPHERAL_SERVICES: ServiceDef[] = [
  {
    id: "axiom",
    name: "axiom",
    portKey: "OPENFANG_PORT",
    run: "exec ./stack/services/openfang.sh",
    dir: ".",
    readyHttp: "/api/health",
    group: "core",
    autoStart: true,
    mise: true,
    healthPath: "/api/health",
  },
  {
    id: "fleet-feed",
    name: "fleet-feed",
    portKey: "RUST_WEB_BACKEND_PORT",
    // rust-web's rust_algo_web/src/agents.rs, ported to TypeScript at
    // ranch/squawk/fleet-feed.ts (2026-10-02). The Rust tree had no Cargo.toml
    // left in the repo, so stack/services/rust-web.sh could only ever fall into
    // `cargo build` and fail. Same three surfaces: roster, history, live ws.
    run: "exec bun /home/toxic/estate/ranch/squawk/fleet-feed.ts",
    dir: "/home/toxic/estate/ranch/squawk",
    readyHttp: "/health",
    group: "core",
    autoStart: true,
    mise: true,
    healthPath: "/health",
  },
  {
    id: "hf-downloader",
    name: "hf-downloader",
    portKey: "HF_DOWNLOADER_PORT",
    run: "exec ./stack/services/hf-downloader-mesh.sh",
    dir: ".",
    readyHttp: "/api/health",
    group: "core",
    autoStart: true,
    mise: true,
    env: { HF_DOWNLOADER_PORT: "${HF_DOWNLOADER_PORT}" },
    healthPath: "/api/health",
  },
  {
    id: "nginx",
    name: "nginx",
    portKey: "NGINX_PORT",
    run: "exec /usr/bin/nginx -c /etc/nginx/nginx.conf -g 'daemon off; pid /tmp/nginx-pitchfork.pid;'",
    dir: ".",
    readyCmd: "ss -ltn 'sport = :62200' | grep -q LISTEN",
    group: "aux",
    autoStart: true,
    mise: false,
  },
  {
    id: "hodos",
    name: "hodos",
    portKey: "HODOS_PORT",
    // Real daemon managed by pitchfork.d/hodos.toml on :25193.
    // This peripheral entry is doc-only (not auto-started; real hodos
    // is in [daemons.hodos] in pitchfork.toml via serve.sh).
    run: "NOOP — managed by pitchfork.d/hodos.toml, see estate/pitchfork.toml [daemons.hodos]",
    dir: "/home/toxic/pens/olympus/products/hodos/proxy",
    readyHttp: "/health",
    group: "aux",
    autoStart: false,
    mise: true,
  },
  {
    id: "matter-server",
    name: "matter-server",
    portKey: "MATTER_SERVER_PORT",
    run: "exec env STORAGE_PATH=/home/toxic/.matter_data BLUETOOTH_ADAPTER=0 LOG_LEVEL=info node --enable-source-maps /home/toxic/.matter-server/app/node_modules/matter-server/dist/esm/MatterServer.js --storage-path /home/toxic/.matter_data --bluetooth-adapter 0 --port 5580",
    dir: ".",
    readyCmd: "ss -ltn 'sport = :5580' | grep -q LISTEN",
    group: "aux",
    autoStart: true,
    mise: false,
  },
  {
    id: "browserless",
    name: "browserless",
    portKey: "BROWSERLESS_PORT",
    run: "exec /home/toxic/pens/barn/browserless/server/run.sh",
    dir: ".",
    readyCmd: "ss -ltn 'sport = :25130' | grep -q LISTEN",
    group: "aux",
    autoStart: true,
    mise: false,
  },
];
