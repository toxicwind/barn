// parse.ts — batchexecute response parsing. Fork-ported from
// nam3886/ghidorah-relay packages/provider-gemini/src/relay_gemini/engine/reply.py
// (FINDINGS-grounded wire parsing, AGPL-3.0) + estate parse conventions.
//
// Wire format: `)]}'` then length-line-framed JSON segments. The wrb.fr
// payload is a double-encoded JSON string; frames are line-based, so we scan
// lines (like ghidorah's _items) rather than strict-JSON-splitting the whole
// body — inner quotes make strict splitting fragile.

export interface WrbSegment {
  key: string;
  rpcid: string;
  payload: unknown;
}

/** Strip one outer JSON string layer. */
export function unquote(v: unknown): unknown {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** getNestedValue: dig into a nested list/record by index path. */
export function getNestedValue(obj: unknown, path: (string | number)[], dflt: unknown = null): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur == null) return dflt;
    if (Array.isArray(cur) || typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[p as never];
    } else {
      return dflt;
    }
  }
  return cur === undefined ? dflt : cur;
}

/**
 * Frame splitter (ghidorah parseAdaptive): parse each length-prefixed frame
 * with a small delta window on the length hint (HAR/network paths normalize
 * \r\n -> \n, so the hint can be off by 1-2 bytes). Returns parsed frames.
 */
const FRAME_DELTA_WINDOW = [0, -1, -2, -3, 1, 2, 3, -4, -5, 4, 5];

function stripLeadingPrefix(body: string): string {
  const trimmed = body.replace(/^\s+/, '');
  return trimmed.startsWith(")]}'") ? trimmed.slice(4).replace(/^\s+/, '') : trimmed;
}

export function parseFrames(body: string): unknown[] {
  const frameRe = /^(\d+)\n/;
  let rest = stripLeadingPrefix(body);
  const frames: unknown[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const m = rest.match(frameRe);
    if (!m) break;
    const hint = Number(m[1]);
    const start = m[0].length;
    let parsed: { value: unknown; consumed: number } | null = null;
    for (const delta of FRAME_DELTA_WINDOW) {
      const len = hint + delta;
      if (len < 1 || start + len > rest.length) continue;
      try {
        const value = JSON.parse(rest.slice(start, start + len).replace(/\s+$/, ''));
        // JSON.parse may succeed on a prefix; only accept if the next char
        // is a digit-newline (segment boundary) or end of string
        const after = rest.slice(start + len);
        if (after === '' || /^\n?\d+\n/.test(after) || /^\n/.test(after)) {
          parsed = { value, consumed: len };
          break;
        }
      } catch {
        /* try next delta */
      }
    }
    if (!parsed) break;
    frames.push(parsed.value);
    rest = rest.slice(start + parsed.consumed);
  }
  return frames;
}

/** Extract wrb.fr entries from parsed frames. */
export function parseSegments(body: string): WrbSegment[] {
  const out: WrbSegment[] = [];
  for (const frame of parseFrames(body)) {
    if (!Array.isArray(frame)) continue;
    for (const entry of frame) {
      if (!Array.isArray(entry) || entry[0] !== 'wrb.fr' || typeof entry[1] !== 'string') continue;
      let payload: unknown = entry[2];
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          /* keep raw string */
        }
      }
      out.push({ key: entry[0] as string, rpcid: entry[1] as string, payload });
    }
  }
  return out;
}

/** Extract the payload of one rpcid (already unquoted by parseSegments). */
export function rpcPayload(segments: WrbSegment[], rpcid: string): unknown {
  for (const s of segments) {
    if (s.rpcid === rpcid) return s.payload;
  }
  return null;
}