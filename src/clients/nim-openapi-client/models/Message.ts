/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type Message = {
    /**
     * The role of the message author.
     */
    role: Message.role;
    /**
     * The contents of the message.
     */
    content: (string | null);
};
export namespace Message {
    /**
     * The role of the message author.
     */
    export enum role {
        USER = 'user',
        ASSISTANT = 'assistant',
    }
}

