// grpc.ts — RPC surface, ported from src/gemini_webapi/constants.py (fork head:
// HanaokaYuzu/Gemini-API @ 1ad0d4a, AGPL-3.0).
export const Endpoint = {
  INIT: 'https://gemini.google.com/app',
  BATCH_EXEC: 'https://gemini.google.com/_/BardChatUi/data/batchexecute',
} as const;

export const GRPC = {
  // Conversation methods
  LIST_CONVERSATIONS: 'MaZiqc',
  LIST_CONVERSATION_TURNS: 'hNvQHb',
  GET_CONVERSATION_TURN: 'EqPOKe',
  DELETE_CONVERSATION: 'GzXR5e',
  UPDATE_CONVERSATION: 'MUAZcd',
  GENERATE_HEADLINE: 'ukz1Fe',
} as const;

export type RpcId = (typeof GRPC)[keyof typeof GRPC];

export interface RPCData {
  rpcid: RpcId;
  payload: string;
}

export function serializeRPC(rpcs: RPCData[]): string {
  return JSON.stringify([rpcs.map((r) => [r.rpcid, r.payload, null, 'generic'])]);
}