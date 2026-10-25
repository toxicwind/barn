/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { Choice } from './Choice';
import type { Usage } from './Usage';
export type ChatCompletion = {
    /**
     * A unique identifier for the completion.
     */
    id: string;
    /**
     * The list of completion choices the model generated for the input prompt.
     */
    choices: Array<Choice>;
    /**
     * Usage statistics for the completion request.
     */
    usage: Usage;
};

