/**
 * Port SSOT loader for Bun services.
 * Values live only in config/ports.env (and optional .env.local overrides).
 * Never invent numeric ports in application code.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const SOV = process.env.ESTATE_ROOT || resolve(homedir(), "estate");

type EnvLayer = { resolve: () => string; precedence: number };

/**
 * Parse one env file into a map. Empty values are dropped: an empty string
 * means "not configured", and exporting "" makes `key in env` and
 * `!== undefined` checks pass, so callers fire authenticated requests and eat
 * a 401 instead of reporting the credential as missing.
 */
/**
 * Strip a trailing ` # comment` from an env-file value. Quote-aware: a `#`
 * inside a quoted value is preserved, so `KEY="a#b"` keeps `a#b`.
 * Unquoted values are cut at the first whitespace-then-`#`, so
 * `OPENFANG_PORT=25103  # owner: x` parses as `25103`. Without this, any
 * trailing comment becomes part of the value and numeric parsing (ports,
 * timeouts) fails on the polluted string.
 */
function stripInlineComment(raw: string): string {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    return end > 0 ? v.slice(0, end + 1) : v;
  }
  const hash = v.search(/\s#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (let line of readFileSync(file, "utf8").split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7);
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const k = line.slice(0, eq).trim();
    const v = stripInlineComment(line.slice(eq + 1)).replace(
      /^['"]|['"]$/g,
      "",
    );
    if (!k || v === "") continue;
    out[k] = v;
  }
  return out;
}

/**
 * Layered env load, lowest precedence first; the highest-precedence layer
 * that declares a key wins.
 *
 * The vault MUST come last, and it MUST be able to overwrite a key that is
 * already in process.env. Bun auto-loads a dotfile from the cwd before any
 * user code runs, so a service launched from $HOME/estate starts with
 * 14-character placeholder values already in process.env (HODOS_API_KEY,
 * SCOUT_API_KEY, SCOUT_MODEL, the *_BASE_URLs). A "already set, skip it"
 * loader then never applies ~/.secrets and every consumer authenticates with
 * the placeholder; the same service launched from any other directory has no
 * dotfile and gets the real value. That is why this only ever looked broken
 * "sometimes", and why it tracked the working directory.
 *
 * Keys no layer declares are left exactly as the caller exported them.
 */
const ENV_LAYERS: EnvLayer[] = [
  { resolve: () => resolve(SOV, "config/ports.env"), precedence: 0 },
  { resolve: () => resolve(SOV, ".env.local"), precedence: 1 },
  { resolve: () => resolve(homedir(), ".secrets"), precedence: 2 },
];

// Placeholder values Bun auto-loads from a cwd dotfile. An explicitly-set
// env var must win over the layered files; a placeholder must lose.
function isPlaceholder(v: string | undefined): boolean {
  return v === undefined || v === "" || v === "<redacted>";
}

export const loadSovereignPorts = loadEstatePorts;

export function loadEstatePorts(): void {
  const layers = [...ENV_LAYERS].sort((a, b) => a.precedence - b.precedence);
  const fromLayers = new Set<string>();
  for (const layer of layers) {
    for (const [k, v] of Object.entries(parseEnvFile(layer.resolve()))) {
      // Higher-precedence layers win over lower layers, but an explicitly-set
      // (non-placeholder) env var wins over all layers. This preserves the
      // vault-over-placeholder behavior without clobbering caller exports.
      if (fromLayers.has(k) || isPlaceholder(process.env[k])) {
        process.env[k] = v;
        fromLayers.add(k);
      }
    }
  }
}

/**
 * Canonical port-env names with their legacy aliases.
 * Forward-only migration: legacy names keep resolving, new code uses the
 * canonical name. Add entries here — never rename in place.
 */
const PORT_ENV_ALIASES: Record<string, string[]> = {
  NULL_G_PROXY_PORT: ["NULL_G_PORT"],
};

export function requireEnv(name: string): string {
  loadEstatePorts();
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  for (const alt of PORT_ENV_ALIASES[name] ?? []) {
    const av = process.env[alt];
    if (av !== undefined && av !== "") return av;
  }
  throw new Error(
    `${name} required — set in ${SOV}/config/ports.env (25xxx SSOT)`,
  );
}

export function requirePort(name: string): number {
  const n = Number(requireEnv(name));
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(
      `${name} must be a valid TCP port, got ${process.env[name]}`,
    );
  }
  return n;
}

/** http://127.0.0.1:${PORT}${path} */
export function localUrl(portEnv: string, path = ""): string {
  const port = requireEnv(portEnv);
  const p = path.startsWith("/") ? path : path ? `/${path}` : "";
  return `http://127.0.0.1:${port}${p}`;
}
