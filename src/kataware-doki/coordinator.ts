#!/usr/bin/env bun

// Kataware-Doki Coordinator — llama-server first class
// Port: 9223. Manages distributed llama-server mesh.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "bun";
import { LlamaMesh, type LlamaNode } from "./llama-server.js";
import { findModel, llamaModels } from "./models.js";

const HOME = process.env.HOME ?? "/home/toxic";
const DATA_DIR = join(HOME, ".kataware-doki");
mkdirSync(DATA_DIR, { recursive: true });

const MAGIC = 0x00000001;
const mesh = new LlamaMesh();

// Load model registry (the "Table")
function loadTable() {
  const p = join(DATA_DIR, "table.json");
  if (existsSync(p)) {
    const d = JSON.parse(readFileSync(p, "utf-8"));
    for (const [k, _v] of Object.entries(d)) {
      // register known models
      const m = findModel(k);
      if (m) console.log(`[Table] Loaded ${k}: ${m.vramGB}GB VRAM`);
    }
  }
}

function _saveTable() {
  const obj: Record<string, any> = {};
  for (const m of llamaModels)
    obj[m.id] = { vram: m.vramGB, ctx: m.contextWindow };
  writeFileSync(join(DATA_DIR, "table.json"), JSON.stringify(obj, null, 2));
}

mesh.startEvictionLoop();

const _server = serve({
  port: 9223,
  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/chat/completions") {
      return handleChat(req);
    }
    if (url.pathname === "/v1/completions") {
      return handleComplete(req);
    }
    if (url.pathname === "/v1/models") {
      return new Response(
        JSON.stringify({
          object: "list",
          data: llamaModels.map((m) => ({
            id: m.id,
            object: "model",
            owned_by: "kataware-doki",
            context_window: m.contextWindow,
            vram_gb: m.vramGB,
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname === "/v1/nodes") {
      return new Response(
        JSON.stringify({
          nodes: mesh.all().map((n) => ({
            id: n.id,
            model: n.model,
            status: n.status,
            latency: n.latency,
            vram: n.vram,
            last_seen: n.lastSeen,
          })),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.pathname === "/ws") {
      const ok = server.upgrade(req, { data: { at: Date.now() } });
      return ok ? undefined : new Response("ws fail", { status: 400 });
    }
    return new Response("Kataware-Doki llama-server coordinator", {
      status: 404,
    });
  },

  websocket: {
    open(_ws) {
      console.log("[C2] node connected");
    },
    message(ws, msg) {
      try {
        const d = JSON.parse(msg as string);
        if (d.type === "register") {
          const n: LlamaNode = {
            id: d.id || crypto.randomUUID(),
            baseUrl: d.baseUrl,
            model: d.model,
            slots: d.slots ?? 1,
            nCtx: d.nCtx ?? 4096,
            status: "idle",
            lastSeen: Date.now(),
            latency: d.latency ?? 999,
            vram: d.vram ?? 0,
          };
          mesh.register(n);
          ws.send(
            JSON.stringify({ type: "registered", id: n.id, magic: MAGIC }),
          );
          console.log(
            `[C2] Registered ${n.id} (${n.model}, ${n.vram}GB, ${n.slots} slots)`,
          );
        } else if (d.type === "heartbeat") {
          mesh.heartbeat(d.id);
          ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } else if (d.type === "result") {
          console.log(
            `[C2] Result from ${d.id}: ${d.content?.substring(0, 80)}...`,
          );
        }
      } catch {
        console.log("[C2] raw:", msg);
      }
    },
    close(_ws, c, _r) {
      console.log(`[C2] disconnected: ${c}`);
    },
  },
});

async function handleChat(req: Request): Promise<Response> {
  const body = await req.json();
  const { model, messages: _messages } = body;
  const node = mesh.swap(model);
  if (!node) {
    return new Response(
      JSON.stringify({ error: "No llama-server nodes — thread severed" }),
      { status: 503 },
    );
  }
  mesh.markBusy(node.id);
  try {
    // Forward to node's /v1/chat/completions
    const res = await fetch(`${node.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    mesh.markIdle(node.id);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    mesh.markIdle(node.id);
    return new Response(JSON.stringify({ error: e.message }), { status: 502 });
  }
}

async function handleComplete(req: Request): Promise<Response> {
  const body = await req.json();
  const { model, prompt } = body;
  const node = mesh.swap(model);
  if (!node) {
    return new Response(
      JSON.stringify({ error: "No llama-server nodes — thread severed" }),
      { status: 503 },
    );
  }
  mesh.markBusy(node.id);
  try {
    const res = await fetch(`${node.baseUrl}/completion`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        n_predict: body.max_tokens ?? 4096,
        temperature: body.temperature ?? 0.7,
        stream: false,
      }),
    });
    mesh.markIdle(node.id);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return new Response(
      JSON.stringify({ id: `kataware-${Date.now()}`, content: data.content }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    mesh.markIdle(node.id);
    return new Response(JSON.stringify({ error: e.message }), { status: 502 });
  }
}

loadTable();
console.log(`\nKataware-Doki llama-server coordinator on port 9223`);
console.log(`Models: ${llamaModels.length} registered`);
console.log(
  `Mesh eviction: ${mesh.evictionMs}ms timeout, ${mesh.heartbeatMs}ms heartbeat`,
);
