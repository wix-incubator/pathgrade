import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockDetectSkills, mockCallLLM, mockIsClaudeCliAvailable } = vi.hoisted(() => ({
  mockDetectSkills: vi.fn(),
  mockCallLLM: vi.fn(),
  mockIsClaudeCliAvailable: vi.fn().mockResolvedValue(true),
}));

vi.mock('../src/core/skills', () => ({
  detectSkills: mockDetectSkills,
}));

vi.mock('../src/utils/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/llm.js')>();
  return {
    ...actual,
    callLLM: mockCallLLM,
    isClaudeCliAvailable: mockIsClaudeCliAvailable,
  };
});

vi.mock('../src/utils/cli', () => ({
  Spinner: class {
    constructor(_scope: string, _label: string) {}
    stop(_message: string) {}
  },
  fmt: {
    green: (value: string) => value,
    red: (value: string) => value,
  },
}));

import { runInit } from '../src/commands/init.js';

describe('runInit LLM selection', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-init-test-'));
    mockDetectSkills.mockResolvedValue([
      {
        name: 'sample-skill',
        skillMd: '# Sample Skill\n\nUse the skill when asked.',
      },
    ]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }
    await fs.remove(tmpDir);
  });

  it('uses the shared callLLM path even when OPENAI_API_KEY is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'provider response' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    process.env.OPENAI_API_KEY = 'sk-test';
    mockCallLLM.mockResolvedValue({
      text: "import { createAgent, evaluate } from '@wix/pathgrade';\nexport {};\n",
      provider: 'cli',
      model: 'claude-cli',
    });

    await runInit(tmpDir);

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // Init generates <skill-name>.eval.ts
    const files = await fs.readdir(tmpDir);
    const evalFile = files.find((f: string) => f.endsWith('.eval.ts'));
    expect(evalFile).toBeDefined();
    expect(await fs.readFile(path.join(tmpDir, evalFile!), 'utf-8')).toContain("from '@wix/pathgrade'");
  });

  it('writes a modern pathgrade template when no skills are detected', async () => {
    mockDetectSkills.mockResolvedValue([]);
    delete process.env.OPENAI_API_KEY;
    mockCallLLM.mockReset();

    await runInit(tmpDir);

    const files = await fs.readdir(tmpDir);
    const evalFile = files.find((f: string) => f.endsWith('.eval.ts'));
    expect(evalFile).toBeDefined();

    const content = await fs.readFile(path.join(tmpDir, evalFile!), 'utf-8');
    expect(content).toContain("from '@wix/pathgrade'");
    expect(content).toContain('createAgent');
    expect(content).not.toContain('defineEval');
    expect(content).not.toContain('scorers:');
  });
});
