import { accessSync } from "fs";
import { PROJECTS_ENV, PROJECTS_DIR, ESTATE_DIR, SECRETS_FILE } from "./constants.js";

export function preCheck(): string[] {
  const checks: string[] = [];
  try { accessSync(PROJECTS_ENV); checks.push(`✓ projects.env found at ${PROJECTS_ENV}`); }
  catch { checks.push(`✗ projects.env not found at ${PROJECTS_ENV}`); }
  try { accessSync(PROJECTS_DIR); checks.push(`✓ PROJECTS_DIR found at ${PROJECTS_DIR}`); }
  catch { checks.push(`✗ PROJECTS_DIR not found at ${PROJECTS_DIR}`); }
  try { accessSync(ESTATE_DIR); checks.push(`✓ ESTATE_DIR found at ${ESTATE_DIR}`); }
  catch { checks.push(`✗ ESTATE_DIR not found at ${ESTATE_DIR}`); }
  try { accessSync(SECRETS_FILE); checks.push(`✓ .secrets found at ${SECRETS_FILE}`); }
  catch { checks.push(`✗ .secrets not found at ${SECRETS_FILE}`); }
  return checks;
}
