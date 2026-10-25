// ============================================================================
// ESTATE — Core Types
// ============================================================================

export type Group =
  | "core"
  | "main"
  | "agent"
  | "agents"
  | "mcp"
  | "infra"
  | "monitoring"
  | "aux";

export interface PortMap extends Map<string, number> {}

export interface ServiceDef {
  id: string;
  name: string;
  portKey: string;
  run: string;
  dir?: string;
  depends?: string[];
  readyHttp?: string;
  readyCmd?: string;
  readyPort?: boolean;
  env?: Record<string, string | number>;
  mise?: boolean;
  retry?: boolean;
  group: Group;
  autoStart?: boolean;
  healthPath?: string;
  watch?: string[];
  user?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  isMcpStdio?: boolean;
}

export interface TemplateContext {
  ports: Record<string, number>;
  services: ServiceDef[];
  groups: Record<string, string[]>;
  timestamp: string;
  sovRoot: string;
}

export interface Generator {
  name: string;
  generate(ctx: TemplateContext): string;
  outputPath: string;
}
