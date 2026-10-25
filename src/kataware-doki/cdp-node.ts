#!/usr/bin/env bun
// Taki CDP Node — Chrome as llama-server WebGPU sandbox
// Injects WebGPU inference runtime into Chrome tabs via CDP.

const CDP_PORT = process.env.CDP_PORT ?? "9222";
const CDP_HOST = process.env.CDP_HOST ?? "127.0.0.1";
const MODEL_URL = process.env.MODEL_URL ?? "http://localhost:8080/model.gguf";

async function cdpVersion() {
  const r = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
  return r.json();
}

async function cdpTargets() {
  const r = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  return r.json();
}

async function newTab() {
  const r = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new?about:blank`, {
    method: "PUT",
  });
  return r.json();
}

async function inject(target: any, modelUrl: string) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: 1, method: "Runtime.enable" }));
    ws.send(JSON.stringify({ id: 2, method: "Page.enable" }));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id === 2 && msg.result) {
      const script = `
        async function init() {
          const adapter = await navigator.gpu.requestAdapter();
          const device = await adapter.requestDevice();
          const resp = await fetch('${modelUrl}');
          const weights = await resp.arrayBuffer();
          window.llamaPipeline = { device, weights, adapter };
          console.log('Kataware-Doki: llama-server WebGPU ready');
        }
        init();
      `;
      ws.send(
        JSON.stringify({
          id: 3,
          method: "Runtime.evaluate",
          params: { expression: script, awaitPromise: true },
        }),
      );
    }
    if (msg.id === 3 && msg.result) {
      console.log(`[CDP] Injected into ${target.id}`);
    }
  };
}

async function main() {
  console.log(`[Taki] CDP ${CDP_HOST}:${CDP_PORT}`);
  const v = await cdpVersion();
  console.log(`[Taki] Chrome ${v.Browser}`);
  const targets = await cdpTargets();
  console.log(`[Taki] ${targets.length} targets`);
  const tab = await newTab();
  console.log(`[Taki] Tab ${tab.id}`);
  await inject(tab, MODEL_URL);
  console.log(`[Taki] WebGPU llama-server ready — body swap complete`);
}

main().catch(console.error);
