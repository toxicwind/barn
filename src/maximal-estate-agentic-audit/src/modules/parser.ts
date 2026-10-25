import { readFileSync, readdirSync } from "fs";
import {
  PROJECTS_ENV,
  PROJECTS_DIR,
  ESTATE_DIR,
  RANCH_DIR,
} from "./constants.js";

/**
 * Expand a container dir into the repo paths directly inside it (one level).
 * The scanners treat each returned path as a single git repo / scan unit, so a
 * container like pens/ranch (230 repos) must be expanded here, not passed whole.
 */
function expandDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => `${dir}/${e.name}`);
  } catch {
    return [dir];
  }
}

export function parseProjectsEnvSync(): string[] {
  try {
    const content = readFileSync(PROJECTS_ENV, "utf8");
    const paths: string[] = [];
    for (const line of content
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("#"))) {
      const [, value] = line.split("=", 2);
      if (value) {
        const path = value.split(":")[0];
        if (path) paths.push(path);
      }
    }
    return paths;
  } catch (error) {
    // projects.env is gone — expand the real fleet roots: the standalone
    // projects dir, the estate control plane, and the 230-repo pens/ranch fleet.
    console.warn(`Failed to parse ${PROJECTS_ENV}: ${error.message}`);
    return [PROJECTS_DIR, ESTATE_DIR, ...expandDir(RANCH_DIR)];
  }
}
