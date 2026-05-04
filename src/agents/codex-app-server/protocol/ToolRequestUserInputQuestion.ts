// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputQuestion.ts
// GENERATED CODE in upstream; do not modify locally either.

import type { ToolRequestUserInputOption } from './ToolRequestUserInputOption.js';

/**
 * EXPERIMENTAL. Represents one request_user_input question and its required options.
 */
export type ToolRequestUserInputQuestion = {
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<ToolRequestUserInputOption> | null;
};
