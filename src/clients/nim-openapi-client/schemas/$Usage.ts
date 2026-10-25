/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export const $Usage = {
  properties: {
    completion_tokens: {
      type: "number",
      description: `Number of tokens in the generated completion.`,
      isRequired: true,
    },
    prompt_tokens: {
      type: "number",
      description: `Number of tokens in the prompt.`,
      isRequired: true,
    },
    total_tokens: {
      type: "number",
      description: `Total number of tokens used in the request (prompt + completion).`,
      isRequired: true,
    },
  },
} as const;
