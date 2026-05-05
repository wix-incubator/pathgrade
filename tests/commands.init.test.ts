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

// We test extractInstructionHint and getInlineTemplate
// These functions are not exported so we need to test them via runInit or replicate them

describe('extractInstructionHint', () => {
  // Replicate the function since it's not exported
  function extractInstructionHint(skillMd: string): string {
    const lines = skillMd.split('\n');
    let foundHeading = false;
    const paragraphLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('# ') && !foundHeading) {
        foundHeading = true;
        continue;
      }
      if (foundHeading) {
        if (line.trim() === '' && paragraphLines.length > 0) break;
        if (line.startsWith('#')) break;
        if (line.trim()) paragraphLines.push(line.trim());
      }
    }

    if (paragraphLines.length > 0) {
      return `TODO: Write an instruction based on this skill.\n      Skill description: ${paragraphLines.join(' ')}`;
    }

    return 'TODO: Write an instruction for the agent.';
  }

  it('extracts first paragraph after heading', () => {
    const content = `# My Skill

This is the first paragraph
that spans multiple lines.

## Section 2
More content here.`;

    const result = extractInstructionHint(content);
    expect(result).toContain('This is the first paragraph');
    expect(result).toContain('that spans multiple lines.');
    expect(result).not.toContain('Section 2');
  });

  it('stops at next heading', () => {
    const content = `# My Skill
First line
## Next Section
Should not appear`;

    const result = extractInstructionHint(content);
    expect(result).toContain('First line');
    expect(result).not.toContain('Should not appear');
  });

  it('returns default when no heading found', () => {
    const content = 'Just some text without headings';
    const result = extractInstructionHint(content);
    expect(result).toBe('TODO: Write an instruction for the agent.');
  });

  it('returns default when heading has no following text', () => {
    const content = '# My Skill\n';
    const result = extractInstructionHint(content);
    expect(result).toBe('TODO: Write an instruction for the agent.');
  });

  it('handles single line after heading', () => {
    const content = `# Skill
Short description.`;

    const result = extractInstructionHint(content);
    expect(result).toContain('Short description.');
  });
});

describe('getInlineTemplate', () => {
  // Replicate the function since it's not exported
  function getInlineTemplate(): string {
    return `import { describe, it, expect } from 'vitest';
import { createAgent, check, judge, evaluate } from '@wix/pathgrade';

describe('{{TASK_NAME}}', () => {
  it('scores the agent result', async () => {
    const agent = await createAgent({ agent: 'claude', timeout: 300 });

    try {
      await agent.prompt(\`{{INSTRUCTION}}\`);

      const result = await evaluate(agent, [
        check('TODO: add deterministic scorer', async () => false),
        judge('TODO: add rubric scorer', {
          rubric: \`TODO: Write evaluation criteria.\`,
          weight: 0.3,
        }),
      ]);

      expect(result.score).toBeGreaterThanOrEqual(0);
    } finally {
      await agent.dispose();
    }
  });
});
`;
  }

  it('returns valid TypeScript template', () => {
    const template = getInlineTemplate();
    expect(template).toContain('createAgent');
    expect(template).toContain('evaluate(');
    expect(template).toContain('{{TASK_NAME}}');
    expect(template).toContain('{{INSTRUCTION}}');
  });

  it('includes default configuration', () => {
    const template = getInlineTemplate();
    expect(template).toContain("agent: 'claude'");
    expect(template).toContain('timeout: 300');
    expect(template).not.toContain('provider: local');
    expect(template).not.toContain('provider: docker');
  });

  it('includes both scorer styles', () => {
    const template = getInlineTemplate();
    expect(template).toContain("check('TODO: add deterministic scorer'");
    expect(template).toContain("judge('TODO: add rubric scorer'");
  });

  it('has placeholder scorer stubs', () => {
    const template = getInlineTemplate();
    expect(template).toContain('TODO: add deterministic scorer');
    expect(template).toContain('TODO: add rubric scorer');
  });
});

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
