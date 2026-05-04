// Pathgrade-local composition; not a single upstream file.
// Upstream models the ops/event bus as discriminated payloads. The driver only
// writes the UserInputAnswer op (in response to an item/tool/requestUserInput
// server request); that shape is captured here.

import type { ToolRequestUserInputResponse } from './ToolRequestUserInputResponse.js';

/**
 * The wire envelope for an UserInputAnswer op. `itemId` correlates with the
 * originating `item/tool/requestUserInput` server request.
 */
export interface OpUserInputAnswer {
    type: 'Op::UserInputAnswer';
    itemId: string;
    answers: ToolRequestUserInputResponse['answers'];
}

export type Op = OpUserInputAnswer;
