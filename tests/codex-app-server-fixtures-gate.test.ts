import { describe, expect, it } from 'vitest';
import { decideProtocolFixtureRun } from '../src/agents/codex-app-server/fixtures/run-gate.js';

describe('protocol fixture run-gate', () => {
    it('skips when PATHGRADE_RUN_PROTOCOL_FIXTURES is unset', () => {
        const decision = decideProtocolFixtureRun({
            env: {},
            codexOnPath: true,
        });
        expect(decision.shouldRun).toBe(false);
        expect(decision.skipReason).toMatch(/PATHGRADE_RUN_PROTOCOL_FIXTURES/);
    });

    it('skips when codex binary is unavailable (clear message names the binary)', () => {
        const decision = decideProtocolFixtureRun({
            env: { PATHGRADE_RUN_PROTOCOL_FIXTURES: '1' },
            codexOnPath: false,
        });
        expect(decision.shouldRun).toBe(false);
        expect(decision.skipReason).toMatch(/codex/);
    });

    it('runs when all prerequisites satisfied', () => {
        const decision = decideProtocolFixtureRun({
            env: { PATHGRADE_RUN_PROTOCOL_FIXTURES: '1' },
            codexOnPath: true,
        });
        expect(decision.shouldRun).toBe(true);
        expect(decision.skipReason).toBeUndefined();
    });

});
