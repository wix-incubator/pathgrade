import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRunSnapshot, RUN_SNAPSHOT_VERSION } from '../src/sdk/snapshots.js';
import type { RunSnapshot } from '../src/sdk/snapshots.js';
import type { LogEntry } from '../src/types.js';

const baseSnapshot = (log: LogEntry[]): RunSnapshot => ({
    version: RUN_SNAPSHOT_VERSION,
    timestamp: '2026-04-24T00:00:00.000Z',
    agent: 'claude',
    messages: [],
    log,
    toolEvents: [],
    turnTimings: [],
    conversationResult: {
        turns: 0,
        completionReason: 'maxTurns',
        turnTimings: [],
    },
    workspace: null,
});

describe('snapshots.ts — ask_batch log entry dual-accept', () => {
    let tmpDir: string;

    beforeEach(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-ask-batch-'));
    });
    afterEach(async () => {
        await fs.remove(tmpDir);
    });

    it('accepts a snapshot containing a valid ask_batch log entry', async () => {
        const log: LogEntry[] = [
            {
                type: 'ask_batch',
                timestamp: '2026-04-24T00:00:01.000Z',
                turn_number: 3,
                batch_id: 'batch-1',
                source: 'codex-app-server',
                lifecycle: 'live',
                source_tool: 'request_user_input',
                tool_use_id: 'tool-use-abc',
                question_count: 2,
                resolved: true,
            },
        ];
        const snapshotPath = path.join(tmpDir, 'ask-batch.json');
        await fs.writeJSON(snapshotPath, baseSnapshot(log));

        const loaded = await loadRunSnapshot(snapshotPath);
        expect(loaded.log[0].type).toBe('ask_batch');
        expect(loaded.log[0].batch_id).toBe('batch-1');
    });

    it('rejects an ask_batch entry missing required fields', async () => {
        const log: LogEntry[] = [
            // missing batch_id + source_tool
            {
                type: 'ask_batch',
                timestamp: '2026-04-24T00:00:01.000Z',
                turn_number: 3,
                lifecycle: 'post-hoc',
                question_count: 1,
            } as LogEntry,
        ];
        const snapshotPath = path.join(tmpDir, 'bad-ask-batch.json');
        await fs.writeJSON(snapshotPath, baseSnapshot(log));

        await expect(loadRunSnapshot(snapshotPath)).rejects.toThrow(/ask_batch/);
    });

    it('still accepts legacy blocked_prompt_* fields on agent_result entries', async () => {
        const log: LogEntry[] = [
            {
                type: 'agent_result',
                timestamp: '2026-04-24T00:00:01.000Z',
                turn_number: 1,
                assistant_message: 'hi',
                synthetic_blocked_prompt: true,
                blocked_prompt_source_turn: 0,
                blocked_prompt_index: 0,
                blocked_prompt_count: 1,
                blocked_prompt_source_tool: 'AskUserQuestion',
                blocked_prompt_tool_use_id: 'tool-1',
            },
        ];
        const snapshotPath = path.join(tmpDir, 'legacy.json');
        await fs.writeJSON(snapshotPath, baseSnapshot(log));

        const loaded = await loadRunSnapshot(snapshotPath);
        expect(loaded.log[0].blocked_prompt_source_tool).toBe('AskUserQuestion');
    });
});
