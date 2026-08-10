import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('published package types', () => {
    it('accepts both structural Agents without provenance and Agents with provenance', () => {
        const consumerDir = mkdtempSync(join(tmpdir(), 'pathgrade-package-types-'));
        const declarationPath = resolve(process.cwd(), 'dist/sdk/index.d.ts');
        const tscPath = require.resolve('typescript/lib/tsc.js');

        try {
            writeFileSync(join(consumerDir, 'consumer.ts'), `
import type { Agent, AgentInvocationProvenance } from '@wix/pathgrade';

const base = {
    workspace: '/workspace',
    log: [],
    messages: [],
    llm: { call: async () => ({ text: '', provider: 'cli' as const, model: 'test' }) },
    prompt: async () => '',
    runConversation: async () => ({ turns: 0, completionReason: 'until' as const, turnTimings: [], stepResults: [] }),
    startChat: async () => { throw new Error('unused'); },
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    transcript: () => '',
    dispose: async () => {},
};

const existingConsumerAgent: Agent = base;
const provenance: AgentInvocationProvenance = {
    agent: 'claude', transport: 'native', model: { id: null, source: 'provider-default' },
    authentication: 'api-key',
    runtime: { package: '@anthropic-ai/claude-agent-sdk', package_version: '0.2.116', embedded_binary_version: '2.1.116', provenance: 'bundled' },
};
const newConsumerAgent: Agent = { ...base, provenance };
void existingConsumerAgent;
void newConsumerAgent;
`);
            writeFileSync(join(consumerDir, 'tsconfig.json'), JSON.stringify({
                compilerOptions: {
                    strict: true,
                    noEmit: true,
                    target: 'ES2022',
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    skipLibCheck: true,
                    baseUrl: '.',
                    paths: { '@wix/pathgrade': [declarationPath] },
                },
                files: ['consumer.ts'],
            }));

            expect(() => execFileSync(process.execPath, [tscPath, '-p', join(consumerDir, 'tsconfig.json')], {
                encoding: 'utf8',
                stdio: 'pipe',
            })).not.toThrow();
        } finally {
            rmSync(consumerDir, { recursive: true, force: true });
        }
    });
});
