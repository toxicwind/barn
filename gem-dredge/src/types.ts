// types.ts — chat data models, ported from src/gemini_webapi/types/* (fork
// head: HanaokaYuzu/Gemini-API @ 1ad0d4a, AGPL-3.0).
export interface ChatInfo {
  cid: string;
  title: string;
  isPinned: boolean;
  /** seconds + nanos/1e9 as epoch float */
  timestamp: number;
  row?: unknown;
}

export interface ChatTurn {
  role: 'user' | 'model';
  text: string;
  /** ids for tracing */
  rid?: string;
  rcid?: string;
}

export interface ChatHistory {
  cid: string;
  turns: ChatTurn[];
}