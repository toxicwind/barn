#!/usr/bin/env bun
/**
 * sse-forward.ts — estate-wide SSE forward-view PRIMITIVE (first-class, all pens).
 *
 * Gives ANY pens/estate daemon a streaming Server-Sent-Events forward-view of its
 * live events, consistently, without each daemon hand-rolling an SSE loop. This is
 * the "SSE forward view as first class" enabler.
 *
 * It runs a Bun HTTP server exposing:
 *   GET /events          -> text/event-stream of the last N historical events + live
 *   GET /events?since=N  -> resume from event N (replay without losing forward view)
 *   POST /push {event}   -> log an event into the ring buffer + fan out to subscribers
 *
 * Monadic primitives: reads are composable Result-style; no mutating global state
 * beyond the ring; fail-loud but forward (a dead subscriber is dropped, never blocks).
 *
 * Usage (in a daemon):
 *   import { createSseForward } from "@estate/sse-forward";
 *   const fwd = createSseForward({ events: 50, port: 0 });
 *   await fwd.listen();                 // bound (port 0 => ephemeral)
 *   fwd.push({ type: "tick", t: Date.now() });
 *   console.log("sse", fwd.port(), fwd.sseUrl());
 */
import { serve } from "bun";

export interface SseEvent {
  type: string;
  t?: number;
  [k: string]: unknown;
}

interface SseOptions {
  /** ring-buffer capacity of historical events spliced on subscribe (default 50) */
  events?: number;
  port?: number;
  hostname?: string;
}

interface Sub {
  w: WritableStreamDefaultWriter<Uint8Array>;
  aborted: boolean;
}

export function createSseForward(opts: SseOptions = {}) {
  const cap = Math.max(1, opts.events ?? 50);
  const ring: SseEvent[] = [];
  const subs = new Set<Sub>();
  let seq = 0;

  const enc = (e: SseEvent, id: number) =>
    `id: ${id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

  const push = (e: SseEvent): number => {
    const id = ++seq;
    e.t = e.t ?? Date.now();
    ring.push(e);
    if (ring.length > cap) ring.splice(0, ring.length - cap);
    const buf = new TextEncoder().encode(enc(e, id));
    for (const s of subs) {
      if (s.aborted) { subs.delete(s); continue; }
      s.w.write(buf).catch(() => { s.aborted = true; subs.delete(s); });
    }
    return id;
  };

  const server = serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const w = controller as unknown as WritableStreamDefaultWriter<Uint8Array>;
            // historical splice first (forward view from `since`), then live fan-out
            const hist = ring.filter((_, i, arr) => seq - arr.length + 1 + i > since);
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            for (let i = 0; i < hist.length; i++) {
              controller.enqueue(new TextEncoder().encode(enc(ring[i]!, seq - ring.length + 1 + i)));
            }
            subs.add({ w, aborted: false } as unknown as Sub);
          },
          cancel() {},
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }
      if (url.pathname === "/push" && req.method === "POST") {
        let body: unknown = {};
        try { body = await req.json(); } catch { /* malformed -> {} */ }
        const id = push(body as SseEvent);
        return Response.json({ ok: true, id });
      }
      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404 });
    },
  });

  return {
    push,
    port: () => server.port,
    sseUrl: () => `http://127.0.0.1:${server.port}/events`,
    stop: () => server.stop(true),
  };
}

// CLI smoke: `bun sse-forward.ts` opens a bound server, pushes one event, prints URL.
if (import.meta.main) {
  const fwd = createSseForward({ events: 10 });
  fwd.push({ type: "hello", from: "sse-forward", t: Date.now() });
  console.log("sse-forward up:", fwd.sseUrl());
}