/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */

import type { CancelablePromise } from "../core/CancelablePromise";
import { OpenAPI } from "../core/OpenAPI";
import { request as __request } from "../core/request";
import type { ChatCompletion } from "../models/ChatCompletion";
import type { ChatRequest } from "../models/ChatRequest";
export class ChatService {
  /**
   * Creates a model response for the given chat conversation.
   * Given a list of messages comprising a conversation, the model will return a response. Compatible with OpenAI. See https://platform.openai.com/docs/api-reference/chat/create
   * @returns ChatCompletion Invocation is fulfilled
   * @returns any Result is pending. Client should poll using the requestId.
   *
   * @throws ApiError
   */
  public static createChatCompletionV1ChatCompletionsPost({
    requestBody,
  }: {
    requestBody: ChatRequest;
  }): CancelablePromise<ChatCompletion | any> {
    return __request(OpenAPI, {
      method: "POST",
      url: "/chat/completions",
      body: requestBody,
      mediaType: "application/json",
      errors: {
        422: `Validation failed, provided entity could not be processed.`,
        500: `The invocation ended with an error.`,
      },
    });
  }
}
