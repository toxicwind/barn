import { describe, expect, test, mock } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  existsSync,
  readdirSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { autoFix } from "../src/modules/autofix.js";
import { preCheck } from "../src/modules/precheck.js";
import { analyzeWithCompletions } from "../src/modules/completions.js";
import {
  scanSecrets,
  getSecretsRecord,
} from "../src/modules/secrets-scanner.js";
import { parseProjectsEnvSync } from "../src/modules/parser.js";
import {
  PROJECTS_DIR,
  ESTATE_DIR,
  RANCH_DIR,
  SECRETS_FILE,
} from "../src/modules/constants.js";

describe("parser.expandDir fallback", () => {
  test("parseProjectsEnvSync falls back to fleet roots when projects.env missing", () => {
    const paths = parseProjectsEnvSync();
    // projects.env does not exist in this env, so fallback fires.
    expect(paths).toContain(PROJECTS_DIR);
    expect(paths).toContain(ESTATE_DIR);
    // The pens/ranch fleet is expanded into individual repo dirs.
    const ranch = paths.filter((p) => p.startsWith(RANCH_DIR));
    expect(ranch.length).toBeGreaterThan(1);
  });

  test("parseProjectsEnvSync expanded ranch paths are all directories", () => {
    const paths = parseProjectsEnvSync();
    for (const p of paths.filter((p) => p.startsWith(RANCH_DIR))) {
      expect(existsSync(p)).toBe(true);
      expect(readdirSync(p).length).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("autofix", () => {
  test("autoFix removes broken symlinks and reports them", () => {
    const dir = mkdtempSync(join(tmpdir(), "maximal-autofix-"));
    const brokenTarget = join(dir, "does-not-exist");
    const brokenLink = join(dir, "broken-link");
    try {
      symlinkSync(brokenTarget, brokenLink);
    } catch (e) {
      throw new Error("symlink setup failed");
    }

    const goodTarget = join(dir, "real-file");
    writeFileSync(goodTarget, "x");
    const goodLink = join(dir, "good-link");
    try {
      symlinkSync(goodTarget, goodLink);
    } catch (e) {
      throw new Error("symlink setup failed");
    }

    const record = {
      records: [
        {
          name: "test",
          path: dir,
          area: "test",
          isGit: false,
          symlinks: [
            {
              path: brokenLink,
              target: brokenTarget,
              exists: false,
              broken: true,
            },
            { path: goodLink, target: goodTarget, exists: true, broken: false },
          ],
          issues: [],
        },
      ],
    };

    const fixes = autoFix(record as never);
    expect(fixes.length).toBe(1);
    expect(fixes[0]).toContain("broken-link");
    expect(existsSync(brokenLink)).toBe(false); // broken link removed
    expect(existsSync(goodLink)).toBe(true); // good link untouched
  });

  test("autoFix returns empty when no broken symlinks", () => {
    expect(autoFix({ records: [] })).toEqual([]);
  });
});

describe("precheck", () => {
  test("preCheck reports status for all four probes", () => {
    const checks = preCheck();
    // Always 4 checks, regardless of what exists.
    expect(checks.length).toBe(4);
    expect(checks.join("\n")).toContain("projects.env");
    expect(checks.join("\n")).toContain("PROJECTS_DIR");
    expect(checks.join("\n")).toContain("ESTATE_DIR");
    expect(checks.join("\n")).toContain(".secrets");
  });
});

describe("completions", () => {
  test("analyzeWithCompletions throws on non-ok response", async () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error patching fetch
    globalThis.fetch = mock(async () => ({ ok: false, status: 503 }));
    try {
      await expect(analyzeWithCompletions("test")).rejects.toThrow(
        /Completions API error: 503/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("analyzeWithCompletions returns content on ok", async () => {
    const originalFetch = globalThis.fetch;
    // @ts-expect-error patching fetch
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "insight" } }] }),
    }));
    try {
      expect(await analyzeWithCompletions("analyze")).toBe("insight");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("secrets-scanner", () => {
  test("scanSecrets returns record with file metadata", async () => {
    const result = await scanSecrets();
    expect(result.file).toBe(SECRETS_FILE);
    expect(typeof result.exists).toBe("boolean");
    expect(Array.isArray(result.credentials)).toBe(true);
    expect(Array.isArray(result.backups)).toBe(true);
  });

  test("getSecretsRecord returns protected credential record", () => {
    const rec = getSecretsRecord();
    expect(rec.name).toBe(".secrets");
    expect(rec.area).toBe("credentials");
    expect(rec.status).toBe("protected");
    expect(rec.isGit).toBe(false);
  });
});
