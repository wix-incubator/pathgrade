// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputParams.ts
// GENERATED CODE in upstream; do not modify locally either.

import type { ToolRequestUserInputQuestion } from './ToolRequestUserInputQuestion.js';

/**
 * EXPERIMENTAL. Params sent with a request_user_input event.
 */
export type ToolRequestUserInputParams = {
    threadId: string;
    turnId: string;
    itemId: string;
    questions: Array<ToolRequestUserInputQuestion>;
};
