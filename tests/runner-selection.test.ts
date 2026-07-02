import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultPathgradeConfig } from '../src/config/pathgrade.js';
import { loadRunnerAdapter, loadRunnerInvocationAdapter } from '../src/runners/adapter-loader.js';
import { resolveRunnerAdapter } from '../src/runners/selection.js';

function makeProject(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pathgrade-runner-adapter-'));
}

function writeProjectFile(root: string, rel: string, content: string): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

describe('resolveRunnerAdapter', () => {
    it('selects the Vitest adapter by default', () => {
        const adapter = resolveRunnerAdapter({});

        expect(adapter.name).toBe('vitest');
    });

    it('selects the node:test proof adapter by name', () => {
        const adapter = resolveRunnerAdapter({ adapterName: 'node-test' });

        expect(adapter.name).toBe('node-test');
    });

    it('loads the Jest adapter by shorthand package alias', async () => {
        const adapter = await loadRunnerAdapter({ adapterName: 'jest' });

        expect(adapter.name).toBe('jest');
    });

    it('loads a relative adapter path from the project cwd', async () => {
        const cwd = makeProject();
        writeProjectFile(cwd, 'local-adapter.mjs', `
export function createPathgradeAdapter() {
    return { name: 'project-local-adapter' };
}
`);

        const adapter = await loadRunnerAdapter({
            cwd,
            adapterName: './local-adapter.mjs',
        });

        expect(adapter.name).toBe('project-local-adapter');
    });

    it('loads a bare adapter alias from the project cwd', async () => {
        const cwd = makeProject();
        writeProjectFile(cwd, 'node_modules/@wix/pathgrade-adapter-demo/package.json', JSON.stringify({
            type: 'module',
            main: './index.mjs',
        }));
        writeProjectFile(cwd, 'node_modules/@wix/pathgrade-adapter-demo/index.mjs', `
export function createPathgradeAdapter() {
    return { name: 'project-package-adapter' };
}
`);

        const adapter = await loadRunnerAdapter({
            cwd,
            adapterName: 'demo',
        });

        expect(adapter.name).toBe('project-package-adapter');
    });

    it('loads a relative invocation adapter path from the project cwd', async () => {
        const cwd = makeProject();
        writeProjectFile(cwd, 'local-invocation-adapter.mjs', `
export function createPathgradeInvocationAdapter() {
    return {
        name: 'project-local-invocation-adapter',
        run: async () => 0,
    };
}
`);

        const adapter = await loadRunnerInvocationAdapter({
            cwd,
            adapterName: './local-invocation-adapter.mjs',
            config: defaultPathgradeConfig(),
        });

        expect(adapter.name).toBe('project-local-invocation-adapter');
    });

    it('rejects missing project-relative adapters with the project cwd in the message', async () => {
        const cwd = makeProject();

        await expect(loadRunnerAdapter({
            cwd,
            adapterName: './missing-adapter.mjs',
        })).rejects.toThrow(
            new RegExp(`Tried to load ./missing-adapter\\.mjs from ${escapeRegExp(cwd)}`),
        );
    });

    it('rejects unsupported adapter names with the requested name in the message', () => {
        expect(() => resolveRunnerAdapter({ adapterName: 'mocha' }))
            .toThrow(/Unsupported Pathgrade runner adapter: mocha/);
    });
});

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
