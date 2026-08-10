import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('../src/affected/git.js', () => ({
    resolveBaseRef: vi.fn(() => ({ base: 'origin/main', sha: 'abc1234' })),
    computeChangedFiles: vi.fn(() => ['skills/alpha/src/x.ts']),
}));

import { runChanged } from '../src/commands/run-changed.js';
import type { RunnerInvocationAdapter } from '../src/runners/invocation.js';

it('standalone changed runs ignore legacy Vitest config', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-standalone-changed-'));
    fs.mkdirSync(path.join(root, 'skills/alpha'), { recursive: true });
    fs.writeFileSync(path.join(root, 'skills/alpha/SKILL.md'), '# alpha');
    fs.writeFileSync(
        path.join(root, 'skills/alpha/a.eval.ts'),
        "import { createAgent } from '@wix/pathgrade';\nvoid createAgent;\n",
    );
    fs.writeFileSync(path.join(root, 'vitest.config.ts'), `
export default {
    plugins: [{
        name: 'pathgrade',
        __pathgradeOptions: { include: ['legacy/**/*.eval.ts'] },
    }],
};
`);
    const runnerInvocation: RunnerInvocationAdapter = {
        name: 'vitest',
        run: vi.fn(async () => 0),
    };

    const code = await runChanged({
        cwd: root,
        standalone: true,
        parsed: {
            runnerArgs: [],
            forceDiagnostics: false,
            forceVerbose: false,
            changed: true,
            quiet: true,
        },
        runnerInvocation,
    });

    expect(code).toBe(0);
    expect(runnerInvocation.run).toHaveBeenCalledWith(expect.objectContaining({
        selectedFiles: ['skills/alpha/a.eval.ts'],
    }));
});
