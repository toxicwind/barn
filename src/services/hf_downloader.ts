/**
 * HF downloader — bodaay serve on backend port; mesh-front on public HF_DOWNLOADER_PORT.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "bun";
import { loadEstatePorts, requirePort } from "../lib/ports.ts";

loadEstatePorts();
const PUBLIC = requirePort("HF_DOWNLOADER_PORT");
const BACKEND = Number(process.env.HF_DOWNLOADER_BACKEND_PORT || "25206");
const HOME = process.env.HOME || "/home/toxic";
const BIN_DIR = join(HOME, ".local", "bin");
const BIN_PATH = join(BIN_DIR, "hfdownloader");
const SOV = process.env.ESTATE_ROOT || join(HOME, "estate");
const LOCAL_DIR = process.env.HF_DOWNLOADER_LOCAL_DIR || join(SOV, "models");
const CACHE_DIR = process.env.HF_HOME || join(HOME, ".cache", "huggingface");

function ensureBinary(): void {
  if (existsSync(BIN_PATH)) {
    const v = spawnSync([BIN_PATH, "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${v.stdout?.toString() || ""}${v.stderr?.toString() || ""}`;
    if (out.includes("3.") || out.includes("version 3")) {
      console.log(`[HF] Using ${BIN_PATH}`);
      return;
    }
  }
  mkdirSync(BIN_DIR, { recursive: true });
  const install = spawnSync(
    [
      "bash",
      "-c",
      `curl -sSL https://g.bodaay.io/hfd | bash -s install ${BIN_DIR}`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (install.exitCode !== 0) {
    console.error(`[HF] Install failed`);
    process.exit(1);
  }
}

ensureBinary();

console.log(`[HF] backend :${BACKEND} mesh-front :${PUBLIC}`);

const backend = spawn(
  [
    BIN_PATH,
    "serve",
    "--addr",
    "127.0.0.1",
    "--port",
    String(BACKEND),
    "--cache-dir",
    CACHE_DIR,
    "--local-dir",
    LOCAL_DIR,
  ],
  {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      HF_HOME: CACHE_DIR,
      HF_TOKEN:
        process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || "",
    },
  },
);

for (let i = 0; i < 40; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${BACKEND}/`)).ok) break;
  } catch {
    /* */
  }
  await Bun.sleep(250);
}

const front = spawn(
  [
    "/home/toxic/.bun/bin/bun",
    "run",
    resolve(SOV, "src/services/mesh-front.ts"),
    "--service",
    "hf-downloader",
    "--listen",
    `0.0.0.0:${PUBLIC}`,
    "--backend",
    `127.0.0.1:${BACKEND}`,
  ],
  { stdout: "inherit", stderr: "inherit" },
);

const stop = () => {
  front.kill();
  backend.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const code = await front.exited;
backend.kill();
process.exit(code ?? 0);
