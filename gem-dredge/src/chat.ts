// chat.ts — list/read conversations, ported from
// src/gemini_webapi/components/chat_mixin.py (fork head: HanaokaYuzu/
// Gemini-API @ 1ad0d4a, AGPL-3.0).
import type { GeminiSession } from './session';
import { GRPC } from './grpc';
import { getNestedValue, unquote } from './parse';
import type { ChatHistory, ChatInfo, ChatTurn } from './types';

/**
 * Fetch recent chats — port of _fetch_recent_chats: two MaZiqc calls,
 * pinned=1 and pinned=0, dedup by cid, parse rows.
 */
export async function listChats(
  session: GeminiSession,
  recent = 26,
): Promise<ChatInfo[]> {
  const chunks: ChatInfo[] = [];
  // Live request shape (captured from the app, 2026-10-23): the third slot is
  // a 10-element array with the pinned flag at index 0 (1=pinned, 0=unpinned).
  // 3-slot `[pinned,null,1]` returns only one row — the 10-slot form is the
  // current wire contract.
  const ROW_ARGS = (pinned: number) => [recent, null, [pinned, null, 1, null, null, null, null, null, null, 1]];
  for (const pinned of [1, 0]) {
    const segs = await session.batch([
      { rpcid: GRPC.LIST_CONVERSATIONS, payload: JSON.stringify(ROW_ARGS(pinned)) },
    ]);
    // payload is already the decoded wrb.fr payload (parseSegments unquotes);
    // do NOT unquote again or the nested structure gets corrupted.
    for (const part of segs.map((s) => s.payload)) {
      const partBody = getNestedValue(part, [2]) as unknown[];
      if (!Array.isArray(partBody)) continue;
      const chatList = getNestedValue(partBody, [2]);
      if (!Array.isArray(chatList)) continue;
      for (const chatData of chatList) {
        if (!Array.isArray(chatData) || chatData.length < 2) continue;
        const cid = String(getNestedValue(chatData, [0], ''));
        const title = String(getNestedValue(chatData, [1], ''));
        const isPinned = Boolean(getNestedValue(chatData, [2]));
        const ts = getNestedValue(chatData, [5]);
        let timestamp = 0;
        if (Array.isArray(ts) && ts.length >= 2) {
          timestamp = Number(ts[0]) + Number(ts[1]) / 1e9;
        }
        if (cid && !chunks.some((c) => c.cid === cid)) {
          chunks.push({ cid, title, isPinned, timestamp, row: chatData });
        }
      }
      // only first part holds the list
      break;
    }
  }
  return chunks.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Fetch conversation turns — port of read_chat: hNvQHb with
 * [cid, limit, null, 1, [1], [4], null, 1], parse user + model turns.
 */
export async function readChat(session: GeminiSession, cid: string, limit = 50): Promise<ChatHistory | null> {
  const segs = await session.batch([
    { rpcid: GRPC.LIST_CONVERSATION_TURNS, payload: JSON.stringify([cid, limit, null, 1, [1], [4], null, 1]) },
  ]);
  for (const seg of segs) {
    // payload is already decoded (parseSegments unquotes); the turns list is
    // the payload's first slot directly.
    const turnsData = getNestedValue(seg.payload, [0]);
    if (!Array.isArray(turnsData)) continue;
    const turns: ChatTurn[] = [];
    for (const convTurn of turnsData) {
      if (!Array.isArray(convTurn)) continue;
      const rid = String(getNestedValue(convTurn, [0, 1], ''));
      // model candidates
      const candidates = getNestedValue(convTurn, [3, 0]);
      if (Array.isArray(candidates)) {
        for (const cand of candidates) {
          const rcid = String(getNestedValue(cand, [0], ''));
          const text = extractCandidateText(cand);
          if (text) turns.push({ role: 'model', text, rid, rcid });
        }
      }
      // user text
      const userText = String(getNestedValue(convTurn, [2, 0, 0], ''));
      if (userText) turns.push({ role: 'user', text: userText, rid });
    }
    return { cid, turns };
  }
  return null;
}

/**
 * Pull the markdown-ish text out of a candidate blob. Ported from
 * _parse_candidate / get_rich_content_field.
 */
function extractCandidateText(cand: unknown): string {
  const text = String(getNestedValue(cand, [1, 0], '') ?? '');
  if (text.trim()) return text;
  // rich content: [4][0][i][0] holds paragraphs
  const rich = getNestedValue(cand, [4, 0]);
  if (Array.isArray(rich)) {
    const parts: string[] = [];
    for (const para of rich) {
      const t = String(getNestedValue(para, [0], ''));
      if (t) parts.push(t);
    }
    if (parts.length) return parts.join('\n\n');
  }
  return '';
}