/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export const $ChatCompletion = {
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
        type: "Choice",
      },
      isRequired: true,
    },
    usage: {
      type: "all-of",
      description: `Usage statistics for the completion request.`,
      contains: [
        {
          type: "Usage",
        },
      ],
      isRequired: true,
    },
  },
} as const;
