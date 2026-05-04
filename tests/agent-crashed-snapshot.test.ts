import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRunSnapshot, RUN_SNAPSHOT_VERSION } from '../src/sdk/snapshots.js';
import { buildDiagnosticsReport, formatDiagnostics } from '../src/reporters/diagnostics.js';
import type { RunSnapshot } from '../src/sdk/snapshots.js';

const snapshotWithReason = (reason: string, detail?: string): RunSnapshot => ({
    version: RUN_SNAPSHOT_VERSION,
    timestamp: '2026-04-24T00:00:00.000Z',
    agent: 'codex',
    messages: [],
    log: [],
    toolEvents: [],
    turnTimings: [],
    conversationResult: {
        turns: 0,
        completionReason: reason as RunSnapshot['conversationResult']['completionReason'],
        ...(detail ? { completionDetail: detail } : {}),
        turnTimings: [],
    },
    workspace: null,
});

describe('snapshots.ts — agent_crashed completionReason', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-agent-crashed-'));
    });
    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    it("accepts a snapshot with completionReason: 'agent_crashed'", async () => {
        const snapshotPath = path.join(tmpDir, 'crashed.json');
        await fs.writeJSON(snapshotPath, snapshotWithReason('agent_crashed', 'app-server exited'));
        const loaded = await loadRunSnapshot(snapshotPath);
        expect(loaded.conversationResult.completionReason).toBe('agent_crashed');
        expect(loaded.conversationResult.completionDetail).toBe('app-server exited');
    });
});

describe('diagnostics reporter — distinguishes agent_crashed from error', () => {
    it("formats 'agent_crashed' with an 'Agent crashed:' prefix (not 'Error:')", () => {
        const report = buildDiagnosticsReport({
            completionReason: 'agent_crashed',
            completionDetail: 'app-server exited: pid=42 exitCode=137',
            log: [],
        });
        const formatted = formatDiagnostics(report, { verbose: true });
        expect(formatted).toContain('Agent crashed: app-server exited');
        expect(formatted).not.toContain('Error: app-server');
    });

    it("still formats 'error' completionReason with 'Error:' prefix", () => {
        const report = buildDiagnosticsReport({
            completionReason: 'error',
            completionDetail: 'something went wrong',
            log: [],
        });
        const formatted = formatDiagnostics(report, { verbose: true });
        expect(formatted).toContain('Error: something went wrong');
    });
});
