import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAgentLLM } from '../src/utils/llm.js';
import { resetCliCache } from '../src/utils/llm-providers/cli.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    resetCliCache();
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true })
    ));
});

describe('Codex CLI judge provider', () => {
    it('uses an authenticated local Codex CLI without OPENAI_API_KEY', async () => {
        const binDirectory = await mkdtemp(path.join(tmpdir(), 'pathgrade-codex-bin-'));
        temporaryDirectories.push(binDirectory);
        const executable = path.join(binDirectory, 'codex');
        await writeFile(executable, `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "exec" ]; then
  prompt=$(cat)
  printf '{"score":1,"details":"local judge saw: %s"}' "$prompt"
  exit 0
fi
exit 1
`, { mode: 0o755 });

        const originalPath = process.env.PATH;
        process.env.PATH = '/usr/bin:/bin';
        try {
            const llm = createAgentLLM('codex', {
                PATH: `${binDirectory}:${originalPath ?? ''}`,
                OPENAI_API_KEY: '',
            });

            const result = await llm.call('grade this transcript');

            expect(result.provider).toBe('cli');
            expect(result.text).toContain('local judge saw: grade this transcript');
        } finally {
            process.env.PATH = originalPath;
        }
    });

    it('keeps the local CLI ahead of the API fallback for an explicit GPT model', async () => {
        const binDirectory = await mkdtemp(path.join(tmpdir(), 'pathgrade-codex-bin-'));
        temporaryDirectories.push(binDirectory);
        const executable = path.join(binDirectory, 'codex');
        await writeFile(executable, `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "exec" ]; then
  cat >/dev/null
  printf '{"score":1,"details":"local judge"}'
  exit 0
fi
exit 1
`, { mode: 0o755 });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
            new Error('HTTP judge should not run before the local CLI')
        );

        try {
            const llm = createAgentLLM('codex', {
                PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
                OPENAI_API_KEY: 'configured-fallback-key',
            });

            const result = await llm.call('grade this transcript', { model: 'gpt-5.4' });

            expect(result.provider).toBe('cli');
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('reports the actual judge-provider requirements when neither route is available', async () => {
        const emptyBinDirectory = await mkdtemp(path.join(tmpdir(), 'pathgrade-empty-bin-'));
        temporaryDirectories.push(emptyBinDirectory);
        const originalPath = process.env.PATH;
        const originalApiKey = process.env.OPENAI_API_KEY;
        process.env.PATH = '/usr/bin:/bin';
        delete process.env.OPENAI_API_KEY;

        try {
            const llm = createAgentLLM('codex', {
                PATH: emptyBinDirectory,
                OPENAI_API_KEY: '',
            });

            await expect(llm.call('grade this transcript')).rejects.toThrow(
                'Codex judge requires an authenticated Codex CLI or OPENAI_API_KEY'
            );
        } finally {
            process.env.PATH = originalPath;
            if (originalApiKey === undefined) {
                delete process.env.OPENAI_API_KEY;
            } else {
                process.env.OPENAI_API_KEY = originalApiKey;
            }
        }
    });
});
