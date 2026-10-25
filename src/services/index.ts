import type { ServiceDef } from "../types/index.ts";
import { BUN_RUNTIME_SERVICE } from "./bun-runtime.ts";
import { CORE_SERVICES } from "./core.ts";
import { FORK_SERVICES } from "./forks.ts";
import { GHAS_SERVICES } from "./ghas.ts";
import { MONITORING_SERVICES } from "./monitoring.ts";
import { PERIPHERAL_SERVICES } from "./peripheral.ts";
export const ALL_SERVICES: ServiceDef[] = [
  ...CORE_SERVICES,
  ...GHAS_SERVICES,
  ...MONITORING_SERVICES,
  ...PERIPHERAL_SERVICES,
  ...FORK_SERVICES,
  BUN_RUNTIME_SERVICE,
];
export const ALL_SERVICE_IDS = ALL_SERVICES.map((s) => s.id);
export function getServiceById(id: string) {
  return ALL_SERVICES.find((s) => s.id === id);
}
