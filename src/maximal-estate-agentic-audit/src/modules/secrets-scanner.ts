import { readFileSync } from "fs";
import { SECRETS_FILE, SECRETS_BACKUPS } from "./constants.js";
import type { RepoRecord } from "./types.js";

export async function scanSecrets() {
  const result = { file: SECRETS_FILE, exists: false, size: 0, credentials: [], backups: [] };
  try {
    const content = readFileSync(SECRETS_FILE, "utf8");
    result.exists = true;
    result.size = content.length;
    for (const line of content.split("\n").filter(l => l.includes("=") && !l.startsWith("#") && l.trim() !== "")) {
      const [key] = line.split("=", 2);
      if (key) result.credentials.push(key.trim());
    }
  } catch { /* noop */ }
  for (const backupPath of SECRETS_BACKUPS) {
    try {
      const content = readFileSync(backupPath, "utf8");
      result.backups.push({ path: backupPath, exists: true, size: content.length });
    } catch {
      result.backups.push({ path: backupPath, exists: false, size: 0 });
    }
  }
  return result;
}

export function getSecretsRecord(): RepoRecord {
  return {
    name: ".secrets",
    path: SECRETS_FILE,
    area: "credentials",
    isGit: false,
    status: "protected",
    symlinks: [],
    issues: [],
    message: "First-class credential store",
    commit: "N/A",
    author: "system",
  };
}
