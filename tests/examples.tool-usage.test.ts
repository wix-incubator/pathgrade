import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import config from '../examples/tool-usage/eval';

describe('examples/tool-usage assets', () => {
  it('ships the workspace fixture and deterministic grader it references', () => {
    const task = config.tasks.find((entry) => entry.name === 'tool-aware-fix');
    const repoDir = path.resolve(__dirname, '..');

    expect(task?.workspace).toEqual([
      { src: 'fixtures/app.js', dest: 'app.js' },
    ]);
    expect(task?.graders.find((grader) => grader.type === 'deterministic')?.run).toContain('graders/check.js');

    expect(fs.existsSync(path.join(repoDir, 'examples', 'tool-usage', 'fixtures', 'app.js'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'examples', 'tool-usage', 'graders', 'check.js'))).toBe(true);
  });
});
