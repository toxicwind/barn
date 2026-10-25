export const PROJECTS_DIR = "/home/toxic/projects";
export const ESTATE_DIR = "/home/toxic/estate";
// The estate fleet home: 230 component repos live under pens (147 with .git),
// laid out per the AGENTS.md bin contract (products own entrypoints; ranch is
// a symlink surface into pens). The old projects.env (327 paths) is gone, so
// the fallback now scans the real fleet roots directly.
export const RANCH_DIR = "/home/toxic/pens/ranch";
export const PENS_DIR = "/home/toxic/pens";
export const PROJECTS_ENV = "/home/toxic/projects.env";
export const COMPLETIONS_URL = "http://127.0.0.1:25100/v1/chat/completions";
export const SECRETS_FILE = "/home/toxic/.secrets";
export const SECRETS_BACKUPS = [
  "/home/toxic/.secrets.bak",
  "/home/toxic/.secrets.backup",
];
