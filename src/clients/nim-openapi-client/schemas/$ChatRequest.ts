/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export const $ChatRequest = {
  properties: {
    model: {
      type: "string",
    },
    messages: {
      type: "array",
      contains: {
        type: "Message",
      },
      isRequired: true,
    },
    temperature: {
      type: "number",
      description: `The sampling temperature to use for text generation. The higher the temperature value is, the less deterministic the output text will be. It is not recommended to modify both temperature and top_p in the same call.`,
      maximum: 1,
    },
    top_p: {
      type: "number",
      description: `The top-p sampling mass used for text generation. The top-p value determines the probability mass that is sampled at sampling time. For example, if top_p = 0.2, only the most likely tokens (summing to 0.2 cumulative probability) will be sampled. It is not recommended to modify both temperature and top_p in the same call.`,
      maximum: 1,
    },
    max_tokens: {
      type: "number",
      description: `The maximum number of tokens to generate in any given call. Note that the model is not aware of this value, and generation will simply stop at the number of tokens specified.`,
      maximum: 16384,
      minimum: 1,
    },
    stream: {
      type: "boolean",
      description: `If set, partial message deltas will be sent. Tokens will be sent as data-only server-sent events (SSE) as they become available (JSON responses are prefixed by \`data: \`), with the stream terminated by a \`data: [DONE]\` message.`,
    },
  },
} as const;
