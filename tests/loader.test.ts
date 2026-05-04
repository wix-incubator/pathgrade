import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsExtra from 'fs-extra';
import { loadReports } from '../src/reporters/loader.js';

describe('loadReports', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `pathgrade-loader-test-${Date.now()}`);
    await fsExtra.ensureDir(tempDir);
  });

  afterEach(async () => {
    try { await fsExtra.remove(tempDir); } catch {}
  });

  it('unwraps consolidated format into flat LoadedReport array', async () => {
    await fsExtra.writeJSON(path.join(tempDir, 'results.json'), {
      version: 1,
      timestamp: '2026-04-10T10:00:00.000Z',
      overall_pass_rate: 0.8,
      status: 'pass',
      groups: [
        {
          task: 'eval.ts > group-a',
          pass_rate: 1.0,
          pass_at_k: 1.0,
          pass_pow_k: 1.0,
          trials: [
            { trial_id: 1, reward: 1.0, duration_ms: 1000, n_commands: 1, input_tokens: 10, output_tokens: 20, scorer_results: [] },
          ],
          skills_used: ['tdd'],
          trace_file: 'traces/group-a.json',
        },
        {
          task: 'eval.ts > group-b',
          pass_rate: 0.5,
          pass_at_k: 0.5,
          pass_pow_k: 0.5,
          trials: [
            { trial_id: 1, reward: 0.0, duration_ms: 2000, n_commands: 2, input_tokens: 30, output_tokens: 40, scorer_results: [] },
          ],
          skills_used: [],
          trace_file: 'traces/group-b.json',
        },
      ],
    });

    const reports = await loadReports(tempDir);

    expect(reports).toHaveLength(2);
    expect(reports[0].task).toBe('eval.ts > group-a');
    expect(reports[0].pass_rate).toBe(1.0);
    expect(reports[0].file).toBe('results.json');
    expect(reports[0].timestamp).toBe('2026-04-10T10:00:00.000Z');
    expect(reports[1].task).toBe('eval.ts > group-b');
    expect(reports[1].pass_rate).toBe(0.5);
  });

  it('loads legacy individual-file format', async () => {
    await fsExtra.writeJSON(path.join(tempDir, 'task_2026-01-01T00-00-00.json'), {
      task: 'legacy-task',
      pass_rate: 0.75,
      pass_at_k: 0.75,
      pass_pow_k: 0.75,
      trials: [
        { trial_id: 1, reward: 0.75, duration_ms: 3000, n_commands: 5, input_tokens: 100, output_tokens: 200, scorer_results: [] },
      ],
      skills_used: ['debugging'],
    });

    const reports = await loadReports(tempDir);

    expect(reports).toHaveLength(1);
    expect(reports[0].task).toBe('legacy-task');
    expect(reports[0].pass_rate).toBe(0.75);
    expect(reports[0].file).toBe('task_2026-01-01T00-00-00.json');
    expect(reports[0].timestamp).toBeUndefined();
  });

  it('round-trips judge_tool_call LogEntry through trace merge', async () => {
    const tracesDir = path.join(tempDir, 'traces');
    await fsExtra.ensureDir(tracesDir);

    await fsExtra.writeJSON(path.join(tempDir, 'results.json'), {
      version: 1,
      timestamp: '2026-04-16T10:00:00.000Z',
      overall_pass_rate: 1.0,
      status: 'pass',
      groups: [{
        task: 'judge-tool-task',
        pass_rate: 1.0,
        pass_at_k: 1.0,
        pass_pow_k: 1.0,
        trials: [
          { trial_id: 1, reward: 1.0, duration_ms: 2000, n_commands: 0, input_tokens: 100, output_tokens: 50, scorer_results: [] },
        ],
        skills_used: [],
        trace_file: 'traces/judge-tool-task.json',
      }],
    });

    await fsExtra.writeJSON(path.join(tracesDir, 'judge-tool-task.json'), [
      {
        trial_id: 1, reward: 1.0, duration_ms: 2000, n_commands: 0,
        input_tokens: 100, output_tokens: 50, scorer_results: [],
        session_log: [
          { type: 'judge_tool_call', timestamp: 't', judge_tool_call: { judge_name: 'spec-quality', name: 'readFile', input: { path: 'spec.md' }, ok: true, bytes: 512 } },
          { type: 'judge_tool_call', timestamp: 't', judge_tool_call: { judge_name: 'spec-quality', name: 'grep', input: { pattern: 'FR-' }, ok: true, bytes: 256 } },
        ],
      },
    ]);

    const reports = await loadReports(tempDir);
    const log = reports[0].trials[0].session_log;
    expect(log.filter((e) => e.type === 'judge_tool_call')).toHaveLength(2);
    const first = log.find((e) => e.type === 'judge_tool_call')!;
    expect(first.judge_tool_call).toMatchObject({ name: 'readFile', ok: true, bytes: 512 });
  });

  it('merges trace files into trials by default', async () => {
    const tracesDir = path.join(tempDir, 'traces');
    await fsExtra.ensureDir(tracesDir);

    await fsExtra.writeJSON(path.join(tempDir, 'results.json'), {
      version: 1,
      timestamp: '2026-04-10T10:00:00.000Z',
      overall_pass_rate: 1.0,
      status: 'pass',
      groups: [{
        task: 'trace-task',
        pass_rate: 1.0,
        pass_at_k: 1.0,
        pass_pow_k: 1.0,
        trials: [
          { trial_id: 1, reward: 1.0, duration_ms: 1000, n_commands: 1, input_tokens: 10, output_tokens: 20, scorer_results: [] },
        ],
        skills_used: [],
        trace_file: 'traces/trace-task.json',
      }],
    });

    // Write the trace file with session_log and conversation
    await fsExtra.writeJSON(path.join(tracesDir, 'trace-task.json'), [
      {
        trial_id: 1, reward: 1.0, duration_ms: 1000, n_commands: 1,
        input_tokens: 10, output_tokens: 20, scorer_results: [],
        session_log: [{ type: 'tool_event', timestamp: 't', tool_event: { action: 'read_file' } }],
        conversation: { turns: [], total_turns: 3, completion_reason: 'done_phrase' },
      },
    ]);

    const reports = await loadReports(tempDir);

    expect(reports).toHaveLength(1);
    expect(reports[0].trials[0].session_log).toHaveLength(1);
    expect(reports[0].trials[0].session_log[0].type).toBe('tool_event');
    expect(reports[0].trials[0].conversation?.total_turns).toBe(3);
  });

  it('skips trace merging when skipTraces is true', async () => {
    const tracesDir = path.join(tempDir, 'traces');
    await fsExtra.ensureDir(tracesDir);

    await fsExtra.writeJSON(path.join(tempDir, 'results.json'), {
      version: 1,
      timestamp: '2026-04-10T10:00:00.000Z',
      overall_pass_rate: 1.0,
      status: 'pass',
      groups: [{
        task: 'skip-trace-task',
        pass_rate: 1.0,
        pass_at_k: 1.0,
        pass_pow_k: 1.0,
        trials: [
          { trial_id: 1, reward: 1.0, duration_ms: 1000, n_commands: 1, input_tokens: 10, output_tokens: 20, scorer_results: [] },
        ],
        skills_used: [],
        trace_file: 'traces/skip-trace-task.json',
      }],
    });

    await fsExtra.writeJSON(path.join(tracesDir, 'skip-trace-task.json'), [
      {
        trial_id: 1, reward: 1.0, duration_ms: 1000, n_commands: 1,
        input_tokens: 10, output_tokens: 20, scorer_results: [],
        session_log: [{ type: 'tool_event', timestamp: 't' }],
        conversation: { turns: [], total_turns: 5, completion_reason: 'done_phrase' },
      },
    ]);

    const reports = await loadReports(tempDir, { skipTraces: true });

    expect(reports).toHaveLength(1);
    expect(reports[0].trials[0].session_log).toBeUndefined();
    expect(reports[0].trials[0].conversation).toBeUndefined();
  });

  it('skips malformed JSON files gracefully', async () => {
    await fsExtra.writeFile(path.join(tempDir, 'broken.json'), 'not valid json{{{');
    await fsExtra.writeJSON(path.join(tempDir, 'valid.json'), {
      task: 'valid-task',
      pass_rate: 1.0,
      pass_at_k: 1.0,
      pass_pow_k: 1.0,
      trials: [
        { trial_id: 1, reward: 1.0, duration_ms: 500, n_commands: 0, input_tokens: 5, output_tokens: 10, scorer_results: [] },
      ],
      skills_used: [],
    });

    const reports = await loadReports(tempDir);

    expect(reports).toHaveLength(1);
    expect(reports[0].task).toBe('valid-task');
  });

  it('returns empty array when no JSON files exist', async () => {
    const reports = await loadReports(tempDir);
    expect(reports).toEqual([]);
  });
});
