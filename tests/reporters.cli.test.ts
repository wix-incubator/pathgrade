import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fsExtra from 'fs-extra';

// Test the actual runCliPreview by creating real temp files
describe('runCliPreview', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `pathgrade-cli-test-${Date.now()}`);
    await fsExtra.ensureDir(tempDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    try { await fsExtra.remove(tempDir); } catch {}
    vi.restoreAllMocks();
  });

  it('prints message when no reports found', async () => {
    // Dynamic import to avoid module caching issues
    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('No reports found'));
  });

  it('displays report data for valid JSON files', async () => {
    const report = {
      task: 'test-task',
      pass_rate: 0.8,
      pass_at_k: 0.75,
      pass_pow_k: 0.6,
      trials: [
        {
          trial_id: 1,
          reward: 0.8,
          duration_ms: 5000,
          n_commands: 3,
          input_tokens: 100,
          output_tokens: 200,
          scorer_results: [
            { scorer_type: 'deterministic', score: 0.8, weight: 1.0, details: 'ok' },
          ],
        },
      ],
      skills_used: ['my-skill'],
    };
    await fsExtra.writeJSON(path.join(tempDir, 'task_2026-01-01T00-00-00.json'), report);

    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    const allOutput = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('test-task');
    expect(allOutput).toContain('80.0%');
    expect(allOutput).toContain('my-skill');
  });

  it('skips invalid JSON files gracefully', async () => {
    await fsExtra.writeFile(path.join(tempDir, 'bad.json'), 'not valid json');
    await fsExtra.writeJSON(path.join(tempDir, 'good.json'), {
      task: 'good-task',
      pass_rate: 1.0,
      trials: [{
        trial_id: 1, reward: 1.0, duration_ms: 1000, n_commands: 1,
        input_tokens: 50, output_tokens: 100, scorer_results: [],
      }],
      skills_used: [],
    });

    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    const allOutput = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('good-task');
  });

  it('only processes .json files', async () => {
    await fsExtra.writeFile(path.join(tempDir, 'readme.txt'), 'hello');
    await fsExtra.writeJSON(path.join(tempDir, 'report.json'), {
      task: 'task1',
      pass_rate: 0.5,
      trials: [{
        trial_id: 1, reward: 0.5, duration_ms: 1000, n_commands: 1,
        input_tokens: 10, output_tokens: 20,
        scorer_results: [{ scorer_type: 'deterministic', score: 0.5, weight: 1.0, details: 'ok' }],
      }],
      skills_used: [],
    });

    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    const allOutput = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('task1');
  });

  it('displays LLM scorer details', async () => {
    await fsExtra.writeJSON(path.join(tempDir, 'test.json'), {
      task: 'task1',
      pass_rate: 0.9,
      trials: [{
        trial_id: 1, reward: 0.9, duration_ms: 2000, n_commands: 2,
        input_tokens: 100, output_tokens: 200,
        scorer_results: [
          { scorer_type: 'llm_rubric', score: 0.9, weight: 1.0, details: 'Excellent work' },
        ],
      }],
      skills_used: [],
    });

    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    const allOutput = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('llm_rubric');
    expect(allOutput).toContain('Excellent work');
  });

  it('prints tool_usage scorer results and tool-event counts', async () => {
    const report = {
      task: 'tool-task',
      pass_rate: 1,
      pass_at_k: 1,
      pass_pow_k: 1,
      skills_used: [],
      trials: [{
        trial_id: 1,
        reward: 1,
        scorer_results: [{ scorer_type: 'tool_usage', score: 1, weight: 1, details: '2/2 expectation weight passed' }],
        duration_ms: 1000,
        n_commands: 1,
        input_tokens: 10,
        output_tokens: 20,
        session_log: [
          { type: 'tool_event', timestamp: 't', tool_event: { action: 'run_shell', provider: 'codex', providerToolName: 'exec_command', summary: 'npm test', confidence: 'high', rawSnippet: '...' } },
          { type: 'tool_event', timestamp: 't', tool_event: { action: 'read_file', provider: 'codex', providerToolName: 'localGetFileContent', summary: 'read', confidence: 'high', rawSnippet: '...' } },
        ],
      }],
    };
    await fsExtra.writeJSON(path.join(tempDir, 'tool-test.json'), report);

    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    const allOutput = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('tool_usage');
    expect(allOutput).toContain('2 tool events');
  });

  it('prints judge_tool_call summary for tool-using judges', async () => {
    const report = {
      task: 'judge-tools-task',
      pass_rate: 1,
      pass_at_k: 1,
      pass_pow_k: 1,
      skills_used: [],
      trials: [{
        trial_id: 1,
        reward: 0.9,
        scorer_results: [{ scorer_type: 'spec-quality', score: 0.9, weight: 1, details: 'looks good' }],
        duration_ms: 2000,
        n_commands: 1,
        input_tokens: 100,
        output_tokens: 50,
        session_log: [
          { type: 'judge_tool_call', timestamp: 't', judge_tool_call: { judge_name: 'spec-quality', name: 'readFile', input: { path: 'spec.md' }, ok: true, bytes: 1024 } },
          { type: 'judge_tool_call', timestamp: 't', judge_tool_call: { judge_name: 'spec-quality', name: 'grep', input: { pattern: 'FR-' }, ok: true, bytes: 128 } },
        ],
      }],
    };
    await fsExtra.writeJSON(path.join(tempDir, 'judge-tools.json'), report);

    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    const allOutput = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('2 judge tool calls');
    expect(allOutput).toContain('readFile');
    expect(allOutput).toContain('grep');
  });

  it('displays skills_used from trials when present', async () => {
    const report = {
      task: 'skill-task',
      pass_rate: 1,
      pass_at_k: 1,
      pass_pow_k: 1,
      skills_used: ['tdd', 'debugging'],
      trials: [{
        trial_id: 1,
        reward: 1,
        duration_ms: 1000,
        n_commands: 1,
        input_tokens: 10,
        output_tokens: 20,
        scorer_results: [],
        skills_used: ['tdd', 'debugging'],
        session_log: [],
      }],
    };
    await fsExtra.writeJSON(path.join(tempDir, 'skill-report.json'), report);

    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    const allOutput = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('tdd');
    expect(allOutput).toContain('debugging');
  });

  it('handles reports with missing optional fields', async () => {
    await fsExtra.writeJSON(path.join(tempDir, 'minimal.json'), {
      task: 'minimal-task',
      pass_rate: 0.3,
      trials: [{
        trial_id: 1, reward: 0.3, duration_ms: 500, n_commands: 0,
        input_tokens: 0, output_tokens: 0,
        scorer_results: [{ scorer_type: 'deterministic', score: 0.3, weight: 1.0, details: 'partial' }],
      }],
      skills_used: [],
    });

    const { runCliPreview } = await import('../src/reporters/cli.js');
    // Should not throw
    await runCliPreview(tempDir);
  });

  it('displays scorer error and skipped statuses with their details', async () => {
    await fsExtra.writeJSON(path.join(tempDir, 'status-report.json'), {
      task: 'status-task',
      pass_rate: 0.4,
      trials: [{
        trial_id: 1,
        reward: 0.4,
        duration_ms: 1500,
        n_commands: 2,
        input_tokens: 20,
        output_tokens: 40,
        scorer_results: [
          { scorer_type: 'deterministic', score: 0, weight: 1, details: 'provider timeout', status: 'error' },
          { scorer_type: 'llm_rubric', score: 0, weight: 1, details: 'skipped (fail-fast)', status: 'skipped' },
        ],
      }],
      skills_used: [],
    });

    const { runCliPreview } = await import('../src/reporters/cli.js');
    const logSpy = vi.spyOn(console, 'log');

    await runCliPreview(tempDir);

    const allOutput = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(allOutput).toContain('[ERROR]');
    expect(allOutput).toContain('[SKIPPED]');
    expect(allOutput).toContain('provider timeout');
    expect(allOutput).toContain('skipped (fail-fast)');
  });
});
