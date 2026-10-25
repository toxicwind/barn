// ============================================================================
// ESTATE — Ports Parser (config/ports.env)
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PortMap } from "../types/index.ts";

export function parsePortsEnv(root: string = process.cwd()): PortMap {
  const content = readFileSync(join(root, "config/ports.env"), "utf-8");
  const ports = new Map<string, number>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    const port = parseInt(val, 10);
    if (!Number.isNaN(port)) {
      ports.set(key, port);
    }
  }
  return ports;
}

export function getPort(ports: PortMap, key: string): number {
  const port = ports.get(key);
  if (port === undefined) {
    throw new Error(`Port key "${key}" not found in ports.env`);
  }
  return port;
}

export function validatePorts(
  ports: PortMap,
  requiredKeys: string[],
): string[] {
  return requiredKeys.filter((key) => !ports.has(key));
}
