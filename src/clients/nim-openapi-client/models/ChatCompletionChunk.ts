/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ChoiceChunk } from './ChoiceChunk';
export type ChatCompletionChunk = {
    /**
     * A unique identifier for the completion.
     */
    id: string;
    /**
     * The list of completion choices the model generated for the input prompt.
     */
    choices: Array<ChoiceChunk>;
};

