#!/usr/bin/env bun
// Mitsuha Worker — llama-server first class
// Registers with coordinator, serves inference directly.

import type { LlamaNode } from "./llama-server.js";

const COORD = process.env.KATAWARE_COORDINATOR ?? "ws://127.0.0.1:9223/ws";
const NODE_ID =
  process.env.NODE_ID ?? `mitsuha-${Math.random().toString(36).slice(2, 8)}`;
const BASE_URL = process.env.LLAMA_BASE_URL ?? "http://127.0.0.1:8080";
const MODEL = process.env.LLAMA_MODEL ?? "qwen3.6-27b-q5";

async function getInfo(): Promise<LlamaNode> {
  let vram = 0,
    slots = 1,
    nCtx = 4096;
  try {
    const r = await fetch(`${BASE_URL}/props`);
    const d = await r.json();
    nCtx = d.default_generation_settings?.n_ctx ?? 4096;
    slots = d.default_generation_settings?.n_parallel ?? 1;
  } catch {}
  try {
    const proc = Bun.spawn([
      "nvidia-smi",
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const out = await new Response(proc.stdout).text();
    vram = Math.round(parseInt(out.trim(), 10) / 1024) || 0;
  } catch {}
  return {
    id: NODE_ID,
    baseUrl: BASE_URL,
    model: MODEL,
    slots,
    nCtx,
    status: "idle",
    lastSeen: 0,
    latency: 0,
    vram,
  };
}

async function connect() {
  const info = await getInfo();
  console.log(`[${NODE_ID}] Connecting to ${COORD}...`);
  const ws = new WebSocket(COORD);
  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "register",
        id: info.id,
        baseUrl: info.baseUrl,
        model: info.model,
        slots: info.slots,
        nCtx: info.nCtx,
        vram: info.vram,
        latency: 0,
      }),
    );
  };
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type === "registered") {
      console.log(`[${NODE_ID}] Registered magic=0x${d.magic.toString(16)}`);
      setInterval(
        () => ws.send(JSON.stringify({ type: "heartbeat", id: NODE_ID })),
        30000,
      );
    }
  };
  ws.onclose = () => {
    console.log(`[${NODE_ID}] Lost — reconnecting...`);
    setTimeout(connect, 5000);
  };
}

connect();
