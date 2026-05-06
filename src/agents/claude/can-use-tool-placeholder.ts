/**
 * Placeholder `canUseTool` callback installed by the Claude SDK driver until
 * the live ask-user bridge ships in issue #004.
 *
 * Contract:
 *   - `AskUserQuestion`  → `{ behavior: 'deny', message: <issue #004 pointer> }`.
 *     The deny is intentional: a stray pre-#004 turn that tries to ask the
 *     user fails loudly with a self-explanatory message rather than hanging.
 *     Once #004 lands the driver replaces this with the live ask-bus bridge.
 *   - Every other tool → `{ behavior: 'allow', updatedInput: input }` so the
 *     SDK turn loop can still complete a turn end-to-end against fixtures
 *     that don't ask the user. Auto-allowing non-ask tools matches the
 *     PRD §SDK option choices contract for `permissionMode: 'default'`.
 */
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

const PLACEHOLDER_DENY_MESSAGE =
    'AskUserQuestion bridge not yet implemented (issue #004)';

export function createPlaceholderCanUseTool(): CanUseTool {
    return async (toolName, input) => {
        if (toolName === 'AskUserQuestion') {
            return { behavior: 'deny', message: PLACEHOLDER_DENY_MESSAGE };
        }
        return { behavior: 'allow', updatedInput: input };
    };
}
