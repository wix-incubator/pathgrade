import { createRequire } from 'node:module';
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
}): Promise<RunnerAdapter> {
    const name = input.adapterName ?? 'vitest';
    if (name === 'vitest' || name === 'node-test') {
        return resolveRunnerAdapter({ adapterName: name });
    }
    if (name === 'jest') return createJestAdapter();

    const mod = await importExternalAdapter(name);
    if (typeof mod.createPathgradeAdapter !== 'function') {
        throw new Error(`Pathgrade adapter package "${adapterPackageSpecifier(name)}" must export createPathgradeAdapter().`);
    }
    return mod.createPathgradeAdapter();
}

export async function loadRunnerInvocationAdapter(input: {
    adapterName?: string;
    config: ResolvedPathgradeConfig;
    spawnVitest?: SpawnVitest;
}): Promise<RunnerInvocationAdapter> {
    const name = input.adapterName ?? 'vitest';
    if (name === 'vitest') return createVitestInvocationAdapter({ spawnVitest: input.spawnVitest });
    if (name === 'node-test') return createNodeTestInvocationAdapter({ config: input.config });
    if (name === 'jest') return createJestInvocationAdapter({ config: input.config });

    const mod = await importExternalAdapter(name);
    if (typeof mod.createPathgradeInvocationAdapter !== 'function') {
        throw new Error(`Pathgrade adapter package "${adapterPackageSpecifier(name)}" must export createPathgradeInvocationAdapter().`);
    }
    return mod.createPathgradeInvocationAdapter({ config: input.config });
}

function adapterPackageSpecifier(adapterName: string): string {
    if (adapterName.startsWith('.') || adapterName.startsWith('/') || adapterName.includes('/')) {
        return adapterName;
    }
    return `@wix/pathgrade-adapter-${adapterName}`;
}

async function importExternalAdapter(adapterName: string): Promise<ExternalAdapterModule> {
    const specifier = adapterPackageSpecifier(adapterName);
    try {
        const resolved = createRequire(import.meta.url).resolve(specifier);
        return await import(pathToFileURL(resolved).href) as ExternalAdapterModule;
    } catch (err) {
        throw new Error(`Unsupported Pathgrade runner adapter: ${adapterName}. Tried to load ${specifier}: ${errMsg(err)}`);
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
