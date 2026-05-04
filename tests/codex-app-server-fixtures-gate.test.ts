import { describe, expect, it } from 'vitest';
import {
    decideProtocolFixtureRun,
    protocolFixtureSkipMessage,
} from '../src/agents/codex-app-server/fixtures/run-gate.js';

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

    it('exports a human-readable default skip message helper', () => {
        expect(typeof protocolFixtureSkipMessage).toBe('function');
        const msg = protocolFixtureSkipMessage('codex binary not found');
        expect(msg).toMatch(/fixture suite skipped/i);
        expect(msg).toMatch(/codex binary not found/);
    });
});
