// ============================================================================
// ESTATE — Monitoring Services
// ============================================================================

import type { ServiceDef } from "../types/index.ts";

export const MONITORING_SERVICES: ServiceDef[] = [
  {
    id: "prometheus",
    name: "prometheus",
    portKey: "PROMETHEUS_PORT",
    run: "exec ./stack/services/prometheus-hot.sh",
    dir: ".",
    readyHttp: "/-/healthy",
    group: "core",
    autoStart: true,
    mise: true,
    healthPath: "/-/healthy",
  },
  {
    id: "grafana",
    name: "grafana",
    portKey: "GRAFANA_PORT",
    run: "exec ./stack/services/grafana-mesh.sh",
    dir: ".",
    readyHttp: "/api/health",
    group: "core",
    autoStart: true,
    mise: true,
    healthPath: "/api/health",
  },
];
