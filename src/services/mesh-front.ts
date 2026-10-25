#!/usr/bin/env bun
/**
 * Mesh front: reverse-proxy a backend while serving /mesh/* (20 GHAS features)
 * on the public service port. Used for binary daemons that cannot mount routes.
 */
import {
  handleMeshRequest,
  type MeshServiceId,
} from "../lib/ghas-mesh-features.ts";
import { loadEstatePorts } from "../lib/ports.ts";

loadEstatePorts();

function arg(name: string, fallback = ""): string {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const service = (arg("--service") ||
  process.env.MESH_SERVICE ||
  "mesh-hub") as MeshServiceId;
const listen =
  arg("--listen") ||
  process.env.MESH_LISTEN ||
  `127.0.0.1:${process.env.MESH_HUB_PORT || "25115"}`;
const backend = arg("--backend") || process.env.MESH_BACKEND || "";
const [listenHost, listenPortStr] = listen.includes(":")
  ? listen.split(":")
  : ["127.0.0.1", listen];
const listenPort = Number(listenPortStr);

if (!backend) {
  console.error("mesh-front requires --backend host:port");
  process.exit(2);
}

const backendBase = backend.startsWith("http") ? backend : `http://${backend}`;

const server = Bun.serve({
  hostname: listenHost === "0.0.0.0" ? "0.0.0.0" : listenHost,
  port: listenPort,
  idleTimeout: 255,
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/health") {
      let res = await fetch(`${backendBase}/health`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 404) {
        res = await fetch(`${backendBase}/api/health`, {
          signal: AbortSignal.timeout(10_000),
        });
      }
      const buf = await res.arrayBuffer();
      return new Response(buf, {
        status: res.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.pathname.startsWith("/mesh")) {
      const m = await handleMeshRequest(req, {
        service,
        version: `mesh-front/${service}`,
      });
      if (m) return m;
    }

    const target = `${backendBase}${u.pathname}${u.search}`;
    try {
      const headers = new Headers(req.headers);
      headers.delete("host");

      const bodyBuf =
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.arrayBuffer();

      const init: RequestInit & { signal?: AbortSignal } = {
        method: req.method,
        headers,
        body: bodyBuf,
        // @ts-expect-error bun duplex
        duplex: "half",
        signal: AbortSignal.timeout(240_000),
      };
      const res = await fetch(target, init);

      // Pipe response body directly — works for both SSE and JSON.
      // NOTE: Bun's fetch transparently decodes gzip/deflate/br response
      // bodies, but the Content-Encoding header survives on res.headers.
      // Proxying that header with the already-decoded body makes browsers
      // fail with "Content Encoding Error". Strip encoding/framing headers
      // so the streamed body is served as identity.
      const outHeaders = new Headers(res.headers);
      outHeaders.delete("content-encoding");
      outHeaders.delete("content-length");
      return new Response(res.body, {
        status: res.status,
        headers: outHeaders,
      });
    } catch (e) {
      return new Response(
        JSON.stringify({
          error: "backend_down",
          backend: backendBase,
          detail: String(e),
        }),
        { status: 502, headers: { "content-type": "application/json" } },
      );
    }
  },
});

console.log(
  `[mesh-front] service=${service} listen=${listenHost}:${server.port} backend=${backendBase}`,
);
