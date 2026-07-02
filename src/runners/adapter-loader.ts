import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ResolvedPathgradeConfig } from '../config/pathgrade.js';
import { createJestInvocationAdapter } from '../adapters/jest/invocation-adapter.js';
import { createJestAdapter } from '../adapters/jest/runner-adapter.js';
import { createNodeTestInvocationAdapter } from '../adapters/node-test/invocation-adapter.js';
import { createVitestInvocationAdapter, type SpawnVitest } from './vitest-invocation.js';
import type { RunnerAdapter } from './adapter.js';
import type { RunnerInvocationAdapter } from './invocation.js';
import { resolveRunnerAdapter } from './selection.js';

export interface ExternalAdapterFactoryInput {
    config: ResolvedPathgradeConfig;
}

interface ExternalAdapterModule {
    createPathgradeAdapter?: () => RunnerAdapter;
    createPathgradeInvocationAdapter?: (input: ExternalAdapterFactoryInput) => RunnerInvocationAdapter;
}

export async function loadRunnerAdapter(input: {
    adapterName?: string;
    cwd?: string;
}): Promise<RunnerAdapter> {
    const name = input.adapterName ?? 'vitest';
    if (name === 'vitest' || name === 'node-test') {
        return resolveRunnerAdapter({ adapterName: name });
    }
    if (name === 'jest') return createJestAdapter();

    const mod = await importExternalAdapter({
        adapterName: name,
        cwd: input.cwd ?? process.cwd(),
    });
    if (typeof mod.createPathgradeAdapter !== 'function') {
        throw new Error(`Pathgrade adapter package "${adapterPackageSpecifier(name)}" must export createPathgradeAdapter().`);
    }
    return mod.createPathgradeAdapter();
}

export async function loadRunnerInvocationAdapter(input: {
    adapterName?: string;
    cwd?: string;
    config: ResolvedPathgradeConfig;
    spawnVitest?: SpawnVitest;
}): Promise<RunnerInvocationAdapter> {
    const name = input.adapterName ?? 'vitest';
    if (name === 'vitest') return createVitestInvocationAdapter({ spawnVitest: input.spawnVitest });
    if (name === 'node-test') return createNodeTestInvocationAdapter({ config: input.config });
    if (name === 'jest') return createJestInvocationAdapter({ config: input.config });

    const mod = await importExternalAdapter({
        adapterName: name,
        cwd: input.cwd ?? process.cwd(),
    });
    if (typeof mod.createPathgradeInvocationAdapter !== 'function') {
        throw new Error(`Pathgrade adapter package "${adapterPackageSpecifier(name)}" must export createPathgradeInvocationAdapter().`);
    }
    return mod.createPathgradeInvocationAdapter({ config: input.config });
}

function adapterPackageSpecifier(adapterName: string): string {
    if (adapterName.startsWith('.') || path.isAbsolute(adapterName) || adapterName.includes('/')) {
        return adapterName;
    }
    return `@wix/pathgrade-adapter-${adapterName}`;
}

function resolveAdapterSpecifier(input: { cwd: string; adapterName: string }): string {
    if (input.adapterName.startsWith('.') || path.isAbsolute(input.adapterName)) {
        return path.resolve(input.cwd, input.adapterName);
    }
    const specifier = adapterPackageSpecifier(input.adapterName);
    return createRequire(path.join(input.cwd, 'package.json')).resolve(specifier);
}

async function importExternalAdapter(input: { cwd: string; adapterName: string }): Promise<ExternalAdapterModule> {
    try {
        const resolved = resolveAdapterSpecifier(input);
        return await import(pathToFileURL(resolved).href) as ExternalAdapterModule;
    } catch (err) {
        throw new Error(
            `Unsupported Pathgrade runner adapter: ${input.adapterName}. ` +
            `Tried to load ${adapterPackageSpecifier(input.adapterName)} from ${input.cwd}: ${errMsg(err)}`,
        );
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
