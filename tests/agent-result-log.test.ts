/**
 * Tests for `buildModelAgentResultLogEntry`.
 *
 * The Claude SDK projector populates `AgentTurnResult.costUsd` from the SDK's
 * `total_cost_usd`. The session-log writer surfaces that as a `cost_usd` field
 * on the `agent_result` log entry so per-turn cost is visible in snapshots.
 */

import { describe, expect, it } from 'vitest';
import { buildModelAgentResultLogEntry } from '../src/sdk/agent-result-log.js';
import type { AgentTurnResult } from '../src/types.js';

function baseTurnResult(overrides: Partial<AgentTurnResult> = {}): AgentTurnResult {
    return {
        rawOutput: 'done',
        assistantMessage: 'done',
        visibleAssistantMessage: 'done',
        visibleAssistantMessageSource: 'assistant_message',
        exitCode: 0,
        toolEvents: [],
        ...overrides,
    };
}

describe('buildModelAgentResultLogEntry — cost_usd field', () => {
    it('writes cost_usd onto the agent_result log entry when the turn result has costUsd', () => {
        const entry = buildModelAgentResultLogEntry({
            timestamp: '2026-05-06T00:00:00.000Z',
            turnNumber: 1,
            durationMs: 100,
            turnResult: baseTurnResult({ costUsd: 0.0125 }),
        });
        expect(entry.cost_usd).toBe(0.0125);
    });

    it('preserves cost_usd precision exactly as reported by the SDK', () => {
        // Pathgrade does not round or normalize cost; whatever the SDK
        // reports flows through unchanged so consumers can reconcile against
        // the SDK's own numbers without floating-point drift.
        const entry = buildModelAgentResultLogEntry({
            timestamp: '2026-05-06T00:00:00.000Z',
            turnNumber: 1,
            durationMs: 100,
            turnResult: baseTurnResult({ costUsd: 0.000123456 }),
        });
        expect(entry.cost_usd).toBe(0.000123456);
    });

    it('omits cost_usd when the turn result has no costUsd', () => {
        // Snapshot consumers should be able to detect "no cost data" cleanly
        // — agents that don't expose cost (Codex, Cursor today) must not
        // appear as zero-cost turns in the log.
        const entry = buildModelAgentResultLogEntry({
            timestamp: '2026-05-06T00:00:00.000Z',
            turnNumber: 1,
            durationMs: 100,
            turnResult: baseTurnResult(),
        });
        expect(entry).not.toHaveProperty('cost_usd');
    });
});
