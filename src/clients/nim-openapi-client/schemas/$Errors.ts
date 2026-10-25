/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export const $Errors = {
  properties: {
    type: {
      type: "string",
      description: `Error type`,
      isRequired: true,
    },
    title: {
      type: "string",
      description: `Error title`,
      isRequired: true,
    },
    status: {
      type: "number",
      description: `Error status code`,
      isRequired: true,
    },
    detail: {
      type: "string",
      description: `Detailed information about the error`,
      isRequired: true,
    },
    instance: {
      type: "string",
      description: `Function instance used to invoke the request`,
      isRequired: true,
    },
    requestId: {
      type: "string",
      description: `UUID of the request`,
      isRequired: true,
      format: "uuid",
    },
  },
} as const;
