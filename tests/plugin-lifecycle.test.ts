import { describe, it, expect, vi, afterEach } from 'vitest';
import { lifecycle } from '../src/plugin/lifecycle.js';
import { getRuntime, resetRuntime } from '../src/sdk/eval-runtime.js';
import { createMockLLM } from '../src/utils/llm-mocks.js';
import type { Agent, RecordedEvalResult, PathgradeTestMeta } from '../src/sdk/types.js';

afterEach(async () => {
    lifecycle.reset();
    resetRuntime();
});

function fakeResult(score: number): RecordedEvalResult {
    return {
        score,
        scorers: [{ name: 'test', type: 'check', score, weight: 1 }],
    };
}

function fakeAgent(): Agent & { dispose: ReturnType<typeof vi.fn> } {
    return {
        workspace: '/fake',
        log: [],
        messages: [],
        llm: createMockLLM(),
        transcript: () => '',
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        prompt: async () => '',
        startChat: async () => { throw new Error('stub'); },
        runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
        dispose: vi.fn().mockResolvedValue(undefined),
    };
}

function currentVitestTaskId(): string {
    return (globalThis as any).__vitest_worker__?.current?.id ?? 'test-1';
}

function fakeTask(id?: string): { id: string; meta: Record<string, unknown> } {
    return { id: id ?? currentVitestTaskId(), meta: {} };
}

describe('plugin lifecycle', () => {
    it('result accumulation: onResult N times with same agent → flush → task.meta.pathgrade has N entries', async () => {
        const agent = fakeAgent();
        lifecycle.trackAgent(agent);

        lifecycle.onResult(fakeResult(0.8), agent);
        lifecycle.onResult(fakeResult(0.6), agent);
        lifecycle.onResult(fakeResult(1.0), agent);

        const task = fakeTask();
        await lifecycle.flush(task);

        const results = task.meta.pathgrade as PathgradeTestMeta[];
        expect(results).toHaveLength(3);
        expect(results[0].score).toBe(0.8);
        expect(results[1].score).toBe(0.6);
        expect(results[2].score).toBe(1.0);
    });

    it('tracked agents are disposed on flush', async () => {
        const agent = fakeAgent();
        lifecycle.trackAgent(agent);
        lifecycle.onResult(fakeResult(0.5), agent);

        const task = fakeTask();
        await lifecycle.flush(task);

        expect(agent.dispose).toHaveBeenCalledOnce();
    });

    it('agents without results are still disposed on flush (cleanup on test failure)', async () => {
        const agent = fakeAgent();
        lifecycle.trackAgent(agent);

        const task = fakeTask();
        await lifecycle.flush(task);

        expect(agent.dispose).toHaveBeenCalledOnce();
        expect(task.meta.pathgrade).toBeUndefined();
    });

    it('reset clears all state', async () => {
        const agent = fakeAgent();
        lifecycle.trackAgent(agent);
        lifecycle.onResult(fakeResult(0.5), agent);

        lifecycle.reset();

        const task = fakeTask();
        await lifecycle.flush(task);

        expect(task.meta.pathgrade).toBeUndefined();
    });

    it('flush is idempotent: second flush is a no-op', async () => {
        const agent = fakeAgent();
        lifecycle.trackAgent(agent);
        lifecycle.onResult(fakeResult(0.9), agent);

        const task1 = fakeTask();
        await lifecycle.flush(task1);

        const task2 = fakeTask();
        await lifecycle.flush(task2);

        expect((task1.meta.pathgrade as PathgradeTestMeta[]).length).toBe(1);
        expect(task2.meta.pathgrade).toBeUndefined();
        expect(agent.dispose).toHaveBeenCalledOnce();
    });

    it('multiple evals with same agent: both results on task.meta after flush', async () => {
        const agent = fakeAgent();
        lifecycle.trackAgent(agent);
        lifecycle.onResult(fakeResult(0.7), agent);
        lifecycle.onResult(fakeResult(0.3), agent);

        const task = fakeTask();
        await lifecycle.flush(task);

        const results = task.meta.pathgrade as PathgradeTestMeta[];
        expect(results).toHaveLength(2);
        expect(results[0].score).toBe(0.7);
        expect(results[1].score).toBe(0.3);
    });

    it('install() wires runtime onResult to the lifecycle callback', async () => {
        lifecycle.install(afterEach);

        const agent = fakeAgent();
        lifecycle.trackAgent(agent);

        const runtime = getRuntime();
        runtime.onResult(fakeResult(0.42), agent);

        const task = fakeTask();
        await lifecycle.flush(task);

        const results = task.meta.pathgrade as PathgradeTestMeta[];
        expect(results).toHaveLength(1);
        expect(results[0].score).toBe(0.42);
    });

    it('synthesizes trial with tokens and commands when evaluate() is not called', async () => {
        const agent = fakeAgent();
        // Give the agent some log entries (simulates runConversation completing)
        agent.log.push(
            { type: 'agent_start', timestamp: '2026-04-08T12:00:00.000Z', instruction: 'Do the thing' },
            { type: 'command', timestamp: '2026-04-08T12:00:01.000Z', command: 'mkdir -p /tmp', stdout: '', stderr: '', exitCode: 0 },
            { type: 'command', timestamp: '2026-04-08T12:00:02.000Z', command: 'claude -p ...', stdout: '...', stderr: '', exitCode: 0 },
            { type: 'agent_result', timestamp: '2026-04-08T12:00:03.000Z', assistant_message: 'Done' },
        );

        // Accumulate agent CLI tokens on the agent's LLM (simulates runConversation)
        agent.llm.addTokens!(10000, 500);

        lifecycle.trackAgent(agent);
        // Note: evaluate() is NOT called

        const task = fakeTask();
        await lifecycle.flush(task);

        const results = task.meta.pathgrade as PathgradeTestMeta[];
        expect(results).toHaveLength(1);
        expect(results[0].trial).toBeDefined();
        expect(results[0].trial!.n_commands).toBe(2);
        expect(results[0].trial!.input_tokens).toBe(10000);
        expect(results[0].trial!.output_tokens).toBe(500);
    });

    it('agents without results and no log entries produce no synthesized trial', async () => {
        const agent = fakeAgent();
        lifecycle.trackAgent(agent);

        const task = fakeTask();
        await lifecycle.flush(task);

        expect(agent.dispose).toHaveBeenCalledOnce();
        expect(task.meta.pathgrade).toBeUndefined();
    });

    it('shared agent: flush attaches results even when agent was created in a different scope', async () => {
        const agent = fakeAgent();

        // Agent created in module/suite scope (task ID = 'suite-1')
        const worker = ((globalThis as any).__vitest_worker__ ??= {});
        const originalCurrent = worker.current;
        worker.current = { id: 'suite-1' };
        lifecycle.trackAgent(agent);
        worker.current = originalCurrent;

        // First it block: evaluate() stores a result, afterEach flushes with 'test-1'
        lifecycle.onResult(fakeResult(0.8), agent);
        const task1 = fakeTask('test-1');
        await lifecycle.flush(task1);

        expect((task1.meta.pathgrade as PathgradeTestMeta[]).length).toBe(1);
        expect((task1.meta.pathgrade as PathgradeTestMeta[])[0].score).toBe(0.8);
        // Agent should NOT be disposed — it's shared across tests
        expect(agent.dispose).not.toHaveBeenCalled();

        // Second it block: new evaluate() call, new flush
        lifecycle.onResult(fakeResult(0.6), agent);
        const task2 = fakeTask('test-2');
        await lifecycle.flush(task2);

        expect((task2.meta.pathgrade as PathgradeTestMeta[]).length).toBe(1);
        expect((task2.meta.pathgrade as PathgradeTestMeta[])[0].score).toBe(0.6);
        expect(agent.dispose).not.toHaveBeenCalled();
    });

    it('concurrent tests: flush only disposes agents belonging to the flushing test', async () => {
        const agentA = fakeAgent();
        const agentB = fakeAgent();

        // Simulate agents created in different test contexts by setting worker task ID
        const worker = ((globalThis as any).__vitest_worker__ ??= {});
        const originalCurrent = worker.current;

        worker.current = { id: 'task-a' };
        lifecycle.trackAgent(agentA);
        worker.current = { id: 'task-b' };
        lifecycle.trackAgent(agentB);
        worker.current = originalCurrent;

        // Only agent A has been evaluated
        lifecycle.onResult(fakeResult(0.8), agentA);

        // Flush task-a: should collect agentA, leave agentB alone
        const taskA = fakeTask('task-a');
        await lifecycle.flush(taskA);

        expect((taskA.meta.pathgrade as PathgradeTestMeta[]).length).toBe(1);
        expect((taskA.meta.pathgrade as PathgradeTestMeta[])[0].score).toBe(0.8);
        expect(agentA.dispose).toHaveBeenCalledOnce();
        expect(agentB.dispose).not.toHaveBeenCalled();

        // Now agent B gets evaluated
        lifecycle.onResult(fakeResult(0.6), agentB);

        // Flush task-b: should collect agentB
        const taskB = fakeTask('task-b');
        await lifecycle.flush(taskB);

        expect((taskB.meta.pathgrade as PathgradeTestMeta[]).length).toBe(1);
        expect((taskB.meta.pathgrade as PathgradeTestMeta[])[0].score).toBe(0.6);
        expect(agentB.dispose).toHaveBeenCalledOnce();
    });
});
