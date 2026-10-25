/**
 * pitchfork-lib.test.ts — unit tests for the pure pitchfork dispatch core.
 * Run: `bun test bin/pitchfork-lib.test.ts`.
 */
import { expect, test, describe } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  pitchforkCandidates,
  resolvePitchforkBin,
  NO_BINARY_MESSAGE,
  normalizeStatusToList,
  sovereignShort,
  sovereignToEstate,
  extractListIds,
  sovereignRefusalLines,
  decideLifecycleArgs,
  decideShim,
  isLifecycleSubcommand,
} from "./pitchfork-lib.ts";

describe("pitchforkCandidates", () => {
  test("prioritizes mise-managed installs (global marshaller + version scan) over stale copies", () => {
    const home = "/home/x";
    // With no mise install present, the set is the local copy + archive fallbacks.
    expect(pitchforkCandidates(home)).toEqual([
      "/home/x/.local/bin/pitchfork-bin",
      "/home/x/archive/home-dirs-2026/.local/bin/pitchfork-bin",
    ]);
  });

  test("prefers mise 'global' marshaller when it exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-lib-"));
    const marshaller =
      tmp + "/.local/share/mise/installs/pitchfork/global/pitchfork";
    mkdirSync(marshaller.replace(/\/pitchfork$/, ""), { recursive: true });
    writeFileSync(marshaller, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(marshaller, 0o755);
    expect(pitchforkCandidates(tmp)[0]).toBe(marshaller);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("scans any mise install column (version-agnostic), not just 2.25.0", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-lib-"));
    const newer =
      tmp + "/.local/share/mise/installs/pitchfork/2.26.0/pitchfork";
    mkdirSync(newer.replace(/\/pitchfork$/, ""), { recursive: true });
    writeFileSync(newer, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(newer, 0o755);
    expect(pitchforkCandidates(tmp)).toContain(newer);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("resolvePitchforkBin", () => {
  test("honors an explicit PITCHFORK_BIN override", () => {
    expect(
      resolvePitchforkBin({ PITCHFORK_BIN: "/opt/custom/pitchfork" }),
    ).toBe("/opt/custom/pitchfork");
  });
  test("ignores a blank PITCHFORK_BIN override", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-lib-"));
    const bin = join(tmp, "bin", "pitchfork");
    mkdirSync(join(tmp, "bin"), { recursive: true });
    writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
    expect(resolvePitchforkBin({ PITCHFORK_BIN: "  " }, tmp)).toBeNull();
    // First candidate under tmp (not existent) is skipped; blank override ignored.
    rmSync(tmp, { recursive: true, force: true });
  });
  test("returns null when nothing exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-lib-"));
    expect(resolvePitchforkBin({}, tmp)).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
  test("resolves the first (mise) candidate in a probe dir", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-lib-"));
    const candidate =
      tmp + "/.local/share/mise/installs/pitchfork/2.25.0/pitchfork";
    mkdirSync(candidate.replace(/\/pitchfork$/, ""), { recursive: true });
    writeFileSync(candidate, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(candidate, 0o755);
    expect(resolvePitchforkBin({}, tmp)).toBe(candidate);
    rmSync(tmp, { recursive: true, force: true });
  });
  test("falls through to the archived bin candidate when mise is absent", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-lib-"));
    const archived = tmp + "/archive/home-dirs-2026/.local/bin/pitchfork-bin";
    mkdirSync(archived.replace(/\/pitchfork-bin$/, ""), { recursive: true });
    writeFileSync(archived, "#!/bin/sh\n", { mode: 0o755 });
    chmodSync(archived, 0o755);
    expect(resolvePitchforkBin({}, tmp)).toBe(archived);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("normalizeStatusToList", () => {
  test("collapses bare `status` to `list`", () => {
    expect(normalizeStatusToList(["status"])).toEqual(["list"]);
  });
  test("leaves `status <name>` untouched", () => {
    expect(normalizeStatusToList(["status", "estate/herd"])).toEqual([
      "status",
      "estate/herd",
    ]);
  });
  test("leaves unrelated commands untouched", () => {
    expect(normalizeStatusToList(["list"])).toEqual(["list"]);
    expect(normalizeStatusToList(["start", "estate/herd"])).toEqual([
      "start",
      "estate/herd",
    ]);
    expect(normalizeStatusToList([])).toEqual([]);
  });
});

describe("sovereign helpers", () => {
  test("sovereignShort strips the prefix", () => {
    expect(sovereignShort("sovereign/foo")).toBe("foo");
    expect(sovereignShort("estate/foo")).toBeNull();
    expect(sovereignShort("foo")).toBeNull();
  });
  test("sovereignToEstate maps to the estate form", () => {
    expect(sovereignToEstate("sovereign/foo")).toBe("estate/foo");
    expect(sovereignToEstate("estate/foo")).toBe("estate/foo");
  });
});

describe("extractListIds", () => {
  test("parses the first column of pitchfork list", () => {
    const out = `estate/agent-display            running
estate/agent-viewer             stopped
sovereign/legacy                running
`;
    const ids = extractListIds(out);
    expect(ids.has("estate/agent-display")).toBe(true);
    expect(ids.has("estate/agent-viewer")).toBe(true);
    expect(ids.has("sovereign/legacy")).toBe(true);
    expect(ids.size).toBe(3);
  });
  test("ignores blank lines", () => {
    expect(extractListIds("\n\nestate/a  running\n\n").size).toBe(1);
  });
});

describe("sovereignRefusalLines", () => {
  test("reproduces the exact bash stderr wording", () => {
    expect(sovereignRefusalLines("sovereign/herd", "herd")).toEqual([
      'pitchfork: REFUSED: "sovereign/herd" is not a registered daemon id.',
      'pitchfork: the live daemon is "estate/herd" — sovereign/ is a deprecated prefix.',
      'pitchfork: re-run with the estate/ name, or "pitchfork list" to see registered ids.',
    ]);
  });
});

describe("decideLifecycleArgs", () => {
  const ids = new Set(["estate/herd", "estate/kitty-mcp", "sovereign/legacy"]);

  test("refuses sovereign/x when only estate/x is registered", () => {
    const d = decideLifecycleArgs(["restart", "sovereign/herd"], ids);
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") {
      expect(d.stderr).toEqual(sovereignRefusalLines("sovereign/herd", "herd"));
    }
  });
  test("passes sovereign/x through when it IS registered", () => {
    const d = decideLifecycleArgs(["restart", "sovereign/legacy"], ids);
    expect(d.kind).toBe("pass");
  });
  test("passes through when neither form is registered", () => {
    const d = decideLifecycleArgs(["restart", "sovereign/ghost"], ids);
    expect(d.kind).toBe("pass");
  });
  test("passes through estate/ args", () => {
    const d = decideLifecycleArgs(
      ["restart", "estate/herd", "estate/kitty-mcp"],
      ids,
    );
    expect(d.kind).toBe("pass");
  });
  test("passes when no lifecycle command is present", () => {
    expect(decideLifecycleArgs(["list"], ids).kind).toBe("pass");
  });
  test("refuses on any guarded subcommand switch", () => {
    for (const cmd of [
      "stop",
      "kill",
      "clean",
      "c",
      "disable",
      "d",
      "enable",
      "e",
      "start",
      "run",
      "r",
    ]) {
      expect(decideLifecycleArgs([cmd, "sovereign/herd"], ids).kind).toBe(
        "refused",
      );
    }
  });
});

describe("isLifecycleSubcommand", () => {
  test("recognizes the guarded subcommands", () => {
    for (const cmd of [
      "stop",
      "restart",
      "kill",
      "clean",
      "c",
      "disable",
      "d",
      "enable",
      "e",
      "start",
      "run",
      "r",
    ]) {
      expect(isLifecycleSubcommand(cmd)).toBe(true);
    }
  });
  test("rejects non-lifecycle commands", () => {
    for (const cmd of ["list", "status", "supervisor", undefined]) {
      expect(isLifecycleSubcommand(cmd)).toBe(false);
    }
  });
});

function probeHome(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "pf-lib-"));
  const bin = dir + "/.local/share/mise/installs/pitchfork/2.25.0/pitchfork";
  mkdirSync(bin.replace(/\/pitchfork$/, ""), { recursive: true });
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(bin, 0o755);
  return { dir, bin };
}

describe("decideShim", () => {
  test("no binary -> exit 127 with the bash message", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pf-lib-"));
    const d = decideShim(["list"], {}, { home: tmp, listIds: new Set() });
    expect(d.kind).toBe("no-binary");
    if (d.kind === "no-binary") {
      expect(d.exitCode).toBe(127);
      expect(d.stderr).toBe(NO_BINARY_MESSAGE);
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test("status shortcut -> exec bin list", () => {
    const { dir, bin } = probeHome();
    const d = decideShim(["status"], {}, { home: dir, listIds: new Set() });
    expect(d.kind).toBe("exec");
    if (d.kind === "exec") {
      expect(d.bin).toBe(bin);
      expect(d.argv).toEqual(["list"]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("status <name> is passed through untouched", () => {
    const { dir, bin } = probeHome();
    const d = decideShim(
      ["status", "estate/herd"],
      {},
      { home: dir, listIds: new Set() },
    );
    expect(d.kind).toBe("exec");
    if (d.kind === "exec") {
      expect(d.argv).toEqual(["status", "estate/herd"]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("sovereign conflict -> refused with exact wording", () => {
    const { dir } = probeHome();
    const d = decideShim(
      ["restart", "sovereign/herd"],
      {},
      { home: dir, listIds: new Set(["estate/herd"]) },
    );
    expect(d.kind).toBe("refused");
    if (d.kind === "refused") {
      expect(d.exitCode).toBe(1);
      expect(d.stderr).toEqual(sovereignRefusalLines("sovereign/herd", "herd"));
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("normal lifecycle command -> exec passthrough", () => {
    const { dir, bin } = probeHome();
    const d = decideShim(
      ["start", "estate/herd"],
      {},
      { home: dir, listIds: new Set(["estate/herd"]) },
    );
    expect(d.kind).toBe("exec");
    if (d.kind === "exec") {
      expect(d.bin).toBe(bin);
      expect(d.argv).toEqual(["start", "estate/herd"]);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("PITCHFORK_BIN override wins over existing candidates", () => {
    const { dir } = probeHome();
    const d = decideShim(
      ["list"],
      { PITCHFORK_BIN: "/opt/override/pitchfork" },
      { home: dir, listIds: new Set() },
    );
    expect(d.kind).toBe("exec");
    if (d.kind === "exec") {
      expect(d.bin).toBe("/opt/override/pitchfork");
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
