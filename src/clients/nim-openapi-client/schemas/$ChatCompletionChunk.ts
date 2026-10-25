/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export const $ChatCompletionChunk = {
  properties: {
    id: {
      type: "string",
      description: `A unique identifier for the completion.`,
      isRequired: true,
      format: "uuid",
    },
    choices: {
      type: "array",
      contains: {
        type: "ChoiceChunk",
      },
      isRequired: true,
    },
  },
} as const;
