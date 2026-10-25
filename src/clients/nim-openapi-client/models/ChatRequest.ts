/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Message } from './Message';
export type ChatRequest = {
    model?: string;
    /**
     * A list of messages comprising the conversation so far. The roles of the messages must be alternating between `user` and `assistant`. The last input message should have role `user`. A message with the the `system` role is optional, and must be the very first message if it is present; `context` is also optional, but must come before a user question.
     */
    messages: Array<Message>;
    /**
     * The sampling temperature to use for text generation. The higher the temperature value is, the less deterministic the output text will be. It is not recommended to modify both temperature and top_p in the same call.
     */
    temperature?: number;
    /**
     * The top-p sampling mass used for text generation. The top-p value determines the probability mass that is sampled at sampling time. For example, if top_p = 0.2, only the most likely tokens (summing to 0.2 cumulative probability) will be sampled. It is not recommended to modify both temperature and top_p in the same call.
     */
    top_p?: number;
    /**
     * The maximum number of tokens to generate in any given call. Note that the model is not aware of this value, and generation will simply stop at the number of tokens specified.
     */
    max_tokens?: number;
    /**
     * If set, partial message deltas will be sent. Tokens will be sent as data-only server-sent events (SSE) as they become available (JSON responses are prefixed by `data: `), with the stream terminated by a `data: [DONE]` message.
     */
    stream?: boolean;
};

