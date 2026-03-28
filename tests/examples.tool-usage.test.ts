import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import config from '../examples/tool-usage/tool-usage.eval';

describe('examples/tool-usage config', () => {
  it('stages the fixture directory and uses descriptor-based graders', () => {
    const task = config.tasks.find((entry) => entry.name === 'tool-aware-fix');
    const repoDir = path.resolve(__dirname, '..');

    expect(task?.workspace).toEqual([{ dir: 'fixtures' }]);
    expect(typeof task?.graders.find((grader) => grader.type === 'deterministic')?.execute).toBe('function');
    expect(task?.graders.find((grader) => grader.type === 'tool_usage')?.expectations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'read_file' }),
        expect.objectContaining({ action: 'edit_file' }),
        expect.objectContaining({ action: 'run_shell', command_contains: 'test' }),
      ]),
    );

    expect(fs.existsSync(path.join(repoDir, 'examples', 'tool-usage', 'fixtures', 'app.js'))).toBe(true);
  });
});
