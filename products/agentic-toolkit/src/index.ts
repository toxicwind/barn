/**
 * Agentic Toolkit — reusable, importable tools for tau/kappa Pens operations
 * 
 * Main entry point exporting all modular features:
 * - Provider Audit: LLM provider health checks
 * - Judge Model Fix: tau judge model configuration
 * - Session Logger: background chat session tracking
 */

export * from "./provider-audit.ts";
export * from "./fix-judge-model.ts";
export * from "./session-logger.ts";

// Toolkit metadata
export const TOOLKIT_VERSION = "1.0.0";
export const TOOLKIT_NAME = "agentic-toolkit";

// Re-export commonly used types
export type { 
  ProviderConfig, 
  ProviderResult, 
  EndpointResult, 
  AuditOptions 
} from "./provider-audit.ts";

export type { 
  FixResult, 
  VerifyResult 
} from "./fix-judge-model.ts";

export type { 
  LogEntry, 
  SessionLoggerOptions 
} from "./session-logger.ts";