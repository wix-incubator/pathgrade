import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        spawn: ((command: string, args?: readonly string[], options?: object) => {
            const runsCodexLauncher = args?.some(arg => arg.includes('/@openai/codex/bin/codex.js'));
            const runsCodexNative = command.endsWith('/codex')
                && command.includes('/@openai/codex-');
            if (runsCodexLauncher || runsCodexNative) {
                throw new Error('standalone run provenance executed bundled Codex');
            }
            return actual.spawn(command, args, options);
        }) as typeof actual.spawn,
    };
});

import { buildStandaloneRunProvenance } from '../src/standalone/provenance.js';

describe('standalone run provenance collection', () => {
    it('does not execute bundled Codex before a Codex agent is selected', async () => {
        await expect(buildStandaloneRunProvenance()).resolves.toMatchObject({
            runtimes: {
                codex: {
                    package_version: '0.144.0',
                    native_version: '0.144.0',
                },
            },
        });
    });
});
