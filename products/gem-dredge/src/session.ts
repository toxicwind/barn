// session.ts — authenticated batchexecute session via live CDP browser.
// Ports the auth surface of client.py (SNlM0e token, f.sid) but sources the
// session from a running Chromium over CDP instead of browser-cookie3.
import { chromium, type Browser, type Page } from 'playwright';
import { Endpoint, serializeRPC, type RPCData } from './grpc';
import { parseSegments, rpcPayload, type WrbSegment } from './parse';

export interface SessionTokens {
  at: string; // SNlM0e
  fSid: string; // FdrFJe
}

const BL = 'boq_gemini-web-uiserver_20261022.15_p0';

export class GeminiSession {
  private tokens: SessionTokens | null = null;
  private reqid = 59393;

  constructor(
    private page: Page,
    private cdpUrl: string,
  ) {}

  static async connect(cdpUrl: string): Promise<{ session: GeminiSession; browser: Browser }> {
    const browser = await chromium.connectOverCDP(cdpUrl);
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    const session = new GeminiSession(page, cdpUrl);
    await session.init();
    return { session, browser };
  }

  async init(): Promise<void> {
    let tokens: SessionTokens | null = null;
    for (let attempt = 0; attempt < 3 && !tokens; attempt += 1) {
      await this.page.goto(Endpoint.INIT, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await this.page.waitForTimeout(3500);
      tokens = await this.page.evaluate((): SessionTokens | null => {
        const html = document.documentElement.innerHTML;
        const m = html.match(/WIZ_global_data\s*=\s*(\{.*?\});<\/script>/s);
        const wiz = m ? JSON.parse(m[1]) : null;
        if (wiz?.SNlM0e && wiz?.FdrFJe) return { at: wiz.SNlM0e, fSid: String(wiz.FdrFJe) };
        return null;
      });
    }
    if (!tokens) throw new Error('failed to extract SNlM0e/FdrFJe tokens — is the session logged in?');
    this.tokens = tokens;
  }

  /** re-init the underlying page: used when the context goes stale */
  private async reinit(): Promise<void> {
    try {
      await this.page.close();
    } catch {
      /* already closed */
    }
    const browser = await chromium.connectOverCDP(this.cdpUrl);
    const ctx = browser.contexts()[0];
    this.page = await ctx.newPage();
    await this.init();
  }

  async batch(rpcs: RPCData[]): Promise<WrbSegment[]> {
    if (!this.tokens) throw new Error('session not initialized');
    const ids = rpcs.map((r) => r.rpcid).join(',');
    this.reqid += 100000;
    const url = `${Endpoint.BATCH_EXEC}?rpcids=${ids}&source-path=%2Fapp&bl=${BL}&f.sid=${this.tokens.fSid}&hl=en&_reqid=${this.reqid}&rt=c`;
    const body = new URLSearchParams({
      'f.req': serializeRPC(rpcs),
      at: this.tokens.at,
    });
    const resp = await this.page.evaluate(
      async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
        });
        return { status: r.status, text: await r.text() };
      },
      { url, body: body.toString() },
    ).catch(() => null);
    if (!resp) {
      // page context went stale (tab closed / CDP reset): re-init once
      await this.reinit();
      return this.batch(rpcs);
    }
    if (resp.status !== 200) {
      throw new Error(`batchexecute ${ids} -> HTTP ${resp.status}: ${resp.text.slice(0, 200)}`);
    }
    const segs = parseSegments(resp.text);
    const payload = rpcPayload(segs, rpcs[0].rpcid);
    if (payload === null && rpcs.length === 1) {
      // error frame check
      const err = segs.find((s) => s.key === 'wrb.fr' && s.rpcid !== rpcs[0].rpcid);
      if (err) throw new Error(`RPC ${ids} failed: ${JSON.stringify(err.payload).slice(0, 300)}`);
    }
    return segs;
  }

  /** raw batchexecute for debugging (no parsing) */
  async debugRawBatch(rpcs: RPCData[]): Promise<string> {
    if (!this.tokens) throw new Error('session not initialized');
    const ids = rpcs.map((r) => r.rpcid).join(',');
    this.reqid += 100000;
    const url = `${Endpoint.BATCH_EXEC}?rpcids=${ids}&source-path=%2Fapp&bl=${BL}&f.sid=${this.tokens.fSid}&hl=en&_reqid=${this.reqid}&rt=c`;
    const body = new URLSearchParams({ 'f.req': serializeRPC(rpcs), at: this.tokens.at });
    const resp = await this.page.evaluate(
      async ({ url, body }) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
        });
        return { status: r.status, text: await r.text() };
      },
      { url, body: body.toString() },
    );
    return resp.text;
  }

  async close(): Promise<void> {
    await this.page.close();
  }
}

/** Convenience: decode a double-encoded RPC payload. */
export function decodePayload<T = unknown>(segments: WrbSegment[], rpcid: string): T | null {
  return rpcPayload(segments, rpcid) as T | null;
}

// ---- RPC id auto-discovery -------------------------------------------------
// RPC ids (MaZiqc, hNvQHb, ...) change as the app ships, so pinning them is
// fragile. The RELIABLE discovery is the app itself: hook fetch before the
// app loads and record every batchexecute rpcids= the app fires. That gives
// the ids this session actually uses, no bundle archaeology.

export async function discoverRpcIds(page: Page): Promise<{ listId: string; turnsId: string }> {
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.__rpcSeen = new Set<string>();
    window.fetch = async (...args: unknown[]) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request)?.url;
      if (typeof url === 'string' && url.includes('batchexecute')) {
        try {
          const rpcids = new URL(url).searchParams.get('rpcids');
          if (rpcids) for (const id of rpcids.split(',')) window.__rpcSeen.add(id);
        } catch {
          /* opaque url — skip */
        }
      }
      return orig.apply(window, args as never);
    };
  });
  // give the app a moment to fire its initial batchexecute calls
  const seen = await page.evaluate(() => [...window.__rpcSeen]);
  // semantic mapping: the LIST call is always the one that ran before others
  // settled; keep the registry simple — callers pass ids explicitly.
  return { listId: seen.find((s) => s === 'MaZiqc') ?? 'MaZiqc', turnsId: seen.find((s) => s === 'hNvQHb') ?? 'hNvQHb' };
}