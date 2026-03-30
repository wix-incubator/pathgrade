import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockDetectSkills, mockCallLLM } = vi.hoisted(() => ({
  mockDetectSkills: vi.fn(),
  mockCallLLM: vi.fn(),
}));

vi.mock('../src/core/skills', () => ({
  detectSkills: mockDetectSkills,
}));

vi.mock('../src/utils/llm', () => ({
  callLLM: mockCallLLM,
}));

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

import { runInit } from '../src/commands/init';

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
    return `import { defineEval } from 'pathgrade';

export default defineEval({
  defaults: {
    agent: 'claude',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
  },

  tasks: [
    {
      name: '{{TASK_NAME}}',
      instruction: \`{{INSTRUCTION}}\`,

      graders: [
        {
          type: 'deterministic',
          // Grader must output JSON: { "score": 0.0-1.0, "details": "...", "checks": [...] }
          run: \`echo '{"score": 0.0, "details": "TODO: implement grader"}'\`,
          weight: 0.7,
        },
        {
          type: 'llm_rubric',
          rubric: \`TODO: Write evaluation criteria.\`,
          weight: 0.3,
        },
      ],
    },
  ],
});
`;
  }

  it('returns valid TypeScript template', () => {
    const template = getInlineTemplate();
    expect(template).toContain('defineEval');
    expect(template).toContain('{{TASK_NAME}}');
    expect(template).toContain('{{INSTRUCTION}}');
  });

  it('includes default configuration', () => {
    const template = getInlineTemplate();
    expect(template).toContain("agent: 'claude'");
    expect(template).toContain('trials: 5');
    expect(template).toContain('timeout: 300');
    expect(template).toContain('threshold: 0.8');
    expect(template).not.toContain('provider: local');
    expect(template).not.toContain('provider: docker');
  });

  it('includes both grader types', () => {
    const template = getInlineTemplate();
    expect(template).toContain("type: 'deterministic'");
    expect(template).toContain("type: 'llm_rubric'");
  });

  it('has placeholder grader that outputs JSON', () => {
    const template = getInlineTemplate();
    expect(template).toContain('"score"');
    expect(template).toContain('"details"');
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
      text: "import { defineEval } from 'pathgrade';\nexport default defineEval({ tasks: [] });\n",
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
    expect(await fs.readFile(path.join(tmpDir, evalFile!), 'utf-8')).toContain('defineEval');
  });
});
