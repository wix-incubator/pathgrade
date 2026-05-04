import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { runAnalyze } from '../src/commands/analyze.js';

describe('pathgrade analyze', () => {
  let tmpDir: string;
  let stdout: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-analyze-'));
    stdout = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      stdout.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.remove(tmpDir);
  });

  function getOutput(): any {
    return JSON.parse(stdout.join(''));
  }

  it('extracts skillName and description from frontmatter', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: superlint
description: Runs linting and fixes issues
---

# Superlint

This skill runs linting on your project files.
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(result.skillName).toBe('superlint');
    expect(result.description).toBe('Runs linting and fixes issues');
  });

  it('extracts procedures from numbered list under Steps heading', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: my-skill
description: A test skill
---

# My Skill

## Steps

1. Read the target file
2. Run the linter
3. Apply auto-fixes
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(result.procedures).toEqual([
      'Read the target file',
      'Run the linter',
      'Apply auto-fixes',
    ]);
  });

  it('extracts procedures from bulleted list under Procedures heading', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: my-skill
description: A test skill
---

# My Skill

## Procedures

- Read the config file
- Generate the output
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(result.procedures).toEqual([
      'Read the config file',
      'Generate the output',
    ]);
  });

  it('extracts expectedOutputs from filenames near creation verbs', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: report-gen
description: Generates reports
---

# Report Generator

## Steps

1. Read the input data
2. Create \`report.md\` with the results
3. Save \`summary.json\` to the workspace
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(result.expectedOutputs).toContain('report.md');
    expect(result.expectedOutputs).toContain('summary.json');
  });

  it('generates suggestedScorers from expected outputs plus always a judge', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: builder
description: Builds things
---

# Builder

## Steps

1. Create \`output.txt\` with the build result
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    const checkScorers = result.suggestedScorers.filter((s: any) => s.type === 'check');
    const judgeScorers = result.suggestedScorers.filter((s: any) => s.type === 'judge');

    expect(checkScorers.length).toBeGreaterThanOrEqual(1);
    expect(checkScorers[0].hint).toContain('output.txt');
    expect(judgeScorers.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty procedures when no matching heading exists', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: simple
description: A simple skill
---

# Simple Skill

This skill does something but has no procedures section.
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(result.procedures).toEqual([]);
  });

  it('returns judge-only scorer when no expected outputs found', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: advisor
description: Gives advice
---

# Advisor

## Steps

1. Read the user question
2. Think about the answer
3. Respond with advice
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(result.expectedOutputs).toEqual([]);
    expect(result.suggestedScorers.length).toBe(1);
    expect(result.suggestedScorers[0].type).toBe('judge');
  });

  it('exits with error JSON when no SKILL.md found', async () => {
    const exitCode = await runAnalyze(tmpDir);
    const result = getOutput();

    expect(exitCode).toBe(1);
    expect(result.error).toBe('no-skill-found');
  });

  it('outputs array when multiple skills detected', async () => {
    await fs.ensureDir(path.join(tmpDir, 'skills', 'alpha'));
    await fs.ensureDir(path.join(tmpDir, 'skills', 'beta'));
    await fs.writeFile(path.join(tmpDir, 'skills', 'alpha', 'SKILL.md'), `---
name: alpha
description: Alpha skill
---

# Alpha
`);
    await fs.writeFile(path.join(tmpDir, 'skills', 'beta', 'SKILL.md'), `---
name: beta
description: Beta skill
---

# Beta
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(2);
    expect(result.map((s: any) => s.skillName).sort()).toEqual(['alpha', 'beta']);
  });

  it('filters to single skill with --skill flag', async () => {
    await fs.ensureDir(path.join(tmpDir, 'skills', 'alpha'));
    await fs.ensureDir(path.join(tmpDir, 'skills', 'beta'));
    await fs.writeFile(path.join(tmpDir, 'skills', 'alpha', 'SKILL.md'), `---
name: alpha
description: Alpha skill
---

# Alpha
`);
    await fs.writeFile(path.join(tmpDir, 'skills', 'beta', 'SKILL.md'), `---
name: beta
description: Beta skill
---

# Beta
`);

    await runAnalyze(tmpDir, { skill: 'alpha' });
    const result = getOutput();

    expect(Array.isArray(result)).toBe(false);
    expect(result.skillName).toBe('alpha');
  });

  it('detects hasFixtures when fixtures/ directory exists', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: with-fixtures
description: Has fixtures
---

# Skill
`);
    await fs.ensureDir(path.join(tmpDir, 'fixtures'));

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(result.hasFixtures).toBe(true);
  });

  it('detects workspaceHint when skill mentions workspace', async () => {
    await fs.writeFile(path.join(tmpDir, 'SKILL.md'), `---
name: workspace-skill
description: Works with workspace
---

# Workspace Skill

## Steps

1. Read files in the workspace directory
2. Modify the project structure
`);

    await runAnalyze(tmpDir);
    const result = getOutput();

    expect(result.workspaceHint).toBeTruthy();
  });
});
