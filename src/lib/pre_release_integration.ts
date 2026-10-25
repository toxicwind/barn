// ============================================================================
// ESTATE — Pre-Release Integration Engine
// Pattern: Dynamic Configuration Resolution for Staging & Canary Overrides
// Note: Production logic is integrated DIRECTLY into code.
// This module manages temporary pre-release staging overrides without monkey patching.
// ============================================================================

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

export interface IntegrationMetadata {
  target: string;
  version?: string;
  author?: string;
  reason?: string;
  enabled?: boolean;
  timestamp?: string;
}

export interface IntegrationModule<T = unknown> {
  TARGET: string;
  VERSION?: string;
  AUTHOR?: string;
  REASON?: string;
  ENABLED?: boolean;
  filePath: string;
  impl: T;
}

export class PreReleaseIntegrationRegistry extends EventEmitter {
  private readonly integrationDir: string;
  private readonly overrides = new Map<string, IntegrationModule>();
  private watcher: fs.FSWatcher | null = null;
  private isLoaded = false;

  constructor(integrationDir?: string) {
    super();
    this.integrationDir =
      integrationDir ||
      path.resolve(process.env.ESTATE_ROOT || process.cwd(), "integrations");
  }

  /**
   * Resolve an implementation at runtime with fallback to direct code implementation.
   */
  public resolve<T>(targetPath: string, defaultImpl: T): T {
    if (!this.isLoaded) {
      this.loadAllSync();
    }
    const module = this.overrides.get(targetPath);
    if (module && module.ENABLED !== false) {
      return module.impl as T;
    }
    return defaultImpl;
  }

  /**
   * Persist a pre-release integration module to disk.
   */
  public async persistIntegration(
    targetPath: string,
    sourceCode: string,
    meta?: IntegrationMetadata,
  ): Promise<string> {
    if (!fs.existsSync(this.integrationDir)) {
      fs.mkdirSync(this.integrationDir, { recursive: true });
    }

    const safeName = targetPath.replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `${safeName}.ts`;
    const filePath = path.join(this.integrationDir, fileName);

    const banner =
      `// ============================================================================\n` +
      `// Pre-Release Integration: ${targetPath}\n` +
      `// Author: ${meta?.author ?? "estate"}\n` +
      `// Reason: ${meta?.reason ?? "pre-release staging override"}\n` +
      `// Date: ${meta?.timestamp ?? new Date().toISOString()}\n\n` +
      `export const TARGET = "${targetPath}";\n` +
      `export const VERSION = "${meta?.version ?? "1.0.0"}";\n` +
      `export const AUTHOR = "${meta?.author ?? "estate"}";\n` +
      `export const REASON = "${meta?.reason ?? "pre-release staging"}";\n` +
      `export const ENABLED = ${meta?.enabled ?? true};\n\n`;

    await Bun.write(filePath, banner + sourceCode);
    await this.loadIntegration(filePath);
    this.emit("integration:persisted", { target: targetPath, filePath });
    return filePath;
  }

  /**
   * Load a single integration file dynamically into memory.
   */
  public async loadIntegration(filePath: string): Promise<boolean> {
    try {
      const url = `${path.resolve(filePath)}?t=${Date.now()}`;
      const mod = await import(url);

      const target = mod.TARGET as string;
      const impl = mod.impl;

      if (!target || impl === undefined) {
        console.warn(
          `[integration] Skipping ${filePath}: missing TARGET or impl export`,
        );
        return false;
      }

      this.overrides.set(target, {
        TARGET: target,
        VERSION: mod.VERSION,
        AUTHOR: mod.AUTHOR,
        REASON: mod.REASON,
        ENABLED: mod.ENABLED !== false,
        filePath,
        impl,
      });

      this.emit("integration:loaded", { target, filePath });
      return true;
    } catch (err) {
      console.error(
        `[integration] Failed to load module from ${filePath}:`,
        err,
      );
      return false;
    }
  }

  /**
   * Load all pre-release integration files from disk on boot.
   */
  public async loadAll(): Promise<void> {
    if (!fs.existsSync(this.integrationDir)) {
      this.isLoaded = true;
      return;
    }

    const files = fs.readdirSync(this.integrationDir);
    for (const file of files) {
      if (
        (file.endsWith(".ts") || file.endsWith(".js")) &&
        !file.endsWith(".disabled")
      ) {
        await this.loadIntegration(path.join(this.integrationDir, file));
      }
    }
    this.isLoaded = true;
  }

  /**
   * Synchronous load on first access if not yet async-loaded.
   */
  public loadAllSync(): void {
    if (this.isLoaded) return;
    if (!fs.existsSync(this.integrationDir)) {
      this.isLoaded = true;
      return;
    }

    try {
      const files = fs.readdirSync(this.integrationDir);
      for (const file of files) {
        if (
          (file.endsWith(".ts") || file.endsWith(".js")) &&
          !file.endsWith(".disabled")
        ) {
          const filePath = path.join(this.integrationDir, file);
          try {
            const content = fs.readFileSync(filePath, "utf-8");
            const targetMatch = content.match(
              /export\s+const\s+TARGET\s*=\s*["']([^"']+)["']/,
            );
            if (targetMatch?.[1]) {
              const target = targetMatch[1];
              this.overrides.set(target, {
                TARGET: target,
                filePath,
                impl: null,
                ENABLED: true,
              });
            }
          } catch {
            // Non-blocking sync read
          }
        }
      }
    } catch (e) {
      console.error("[integration] Synchronous directory read error:", e);
    }
    this.isLoaded = true;
  }

  /**
   * Start watching the integration directory for live updates.
   */
  public startWatcher(): fs.FSWatcher {
    if (this.watcher) return this.watcher;
    if (!fs.existsSync(this.integrationDir)) {
      fs.mkdirSync(this.integrationDir, { recursive: true });
    }

    this.watcher = fs.watch(
      this.integrationDir,
      { persistent: false },
      async (_event, filename) => {
        if (!filename) return;
        if (filename.endsWith(".ts") || filename.endsWith(".js")) {
          const fullPath = path.join(this.integrationDir, filename);
          if (fs.existsSync(fullPath)) {
            await this.loadIntegration(fullPath);
          }
        }
      },
    );

    if (
      this.watcher &&
      typeof (this.watcher as unknown as { unref: () => void }).unref ===
        "function"
    ) {
      (this.watcher as unknown as { unref: () => void }).unref();
    }

    return this.watcher;
  }
}

// Global Singleton Instance
export const preReleaseIntegration = new PreReleaseIntegrationRegistry();
