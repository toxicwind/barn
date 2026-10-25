/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export const $Message = {
  properties: {
    role: {
      type: "Enum",
      isRequired: true,
    },
    content: {
      type: "any-of",
      description: `The contents of the message.`,
      contains: [
        {
          type: "string",
        },
        {
          type: "null",
        },
      ],
      isRequired: true,
    },
  },
} as const;
