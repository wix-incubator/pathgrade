/**
 * Tests for src/agents/claude/can-use-tool-placeholder.ts.
 *
 * Issue #001 ships the orchestration shell of the Claude SDK driver; the
 * live ask-user bridge lands in #004. In the interim, the driver installs a
 * placeholder `canUseTool` that:
 *
 *   - allows every non-`AskUserQuestion` tool to proceed unchanged, so the
 *     SDK turn loop can still complete a turn end-to-end against fixtures
 *     that don't ask the user;
 *   - returns a deny with an explicit "issue #004" message for `AskUserQuestion`
 *     so a stray pre-#004 turn fails loudly rather than hangs.
 *
 * The deny message is part of the contract — issue text in the failure
 * makes pre-#004 regressions self-explanatory.
 */

import { describe, expect, it } from 'vitest';
import { createPlaceholderCanUseTool } from '../src/agents/claude/can-use-tool-placeholder.js';

describe('placeholder canUseTool', () => {
    it('denies AskUserQuestion with the documented placeholder message', async () => {
        const canUseTool = createPlaceholderCanUseTool();
        const result = await canUseTool('AskUserQuestion', { questions: [] }, {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: 'test',
        });
        expect(result.behavior).toBe('deny');
        if (result.behavior === 'deny') {
            expect(result.message).toMatch(/AskUserQuestion bridge not yet implemented/i);
            expect(result.message).toMatch(/#004/);
        }
    });

    it('allows every non-AskUserQuestion tool with the input passed through unchanged', async () => {
        const canUseTool = createPlaceholderCanUseTool();
        const input = { command: 'echo hi' };
        const result = await canUseTool('Bash', input, {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: 'test',
        });
        expect(result.behavior).toBe('allow');
        if (result.behavior === 'allow') {
            expect(result.updatedInput).toEqual(input);
        }
    });

    it('allows other ask-shaped tools that are not AskUserQuestion (no false positives)', async () => {
        // Defensive: if the SDK ever surfaces a related tool name (e.g.
        // `AskHumanQuestion`) the placeholder must not refuse it; the deny is
        // scoped strictly to the documented `AskUserQuestion` name.
        const canUseTool = createPlaceholderCanUseTool();
        const result = await canUseTool('AskHumanQuestion', { x: 1 }, {
            signal: new AbortController().signal,
            suggestions: [],
            toolUseID: 'test',
        });
        expect(result.behavior).toBe('allow');
    });
});
