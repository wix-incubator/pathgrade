// Vendored from openai/codex@rust-v0.124.0
// Source: codex-rs/app-server-protocol/schema/typescript/v2/ToolRequestUserInputResponse.ts
// GENERATED CODE in upstream; do not modify locally either.

import type { ToolRequestUserInputAnswer } from './ToolRequestUserInputAnswer.js';

/**
 * EXPERIMENTAL. Response payload mapping question ids to answers.
 */
export type ToolRequestUserInputResponse = {
    answers: { [key: string]: ToolRequestUserInputAnswer | undefined };
};
