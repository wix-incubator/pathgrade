import type { RunnerAdapter } from './adapter.js';
import { createNodeTestAdapter } from '../adapters/node-test/runner-adapter.js';
import { createVitestAdapter, type VitestAdapterOptions } from './vitest-adapter.js';

export function resolveRunnerAdapter(input: {
    adapterName?: string;
    vitest?: VitestAdapterOptions;
}): RunnerAdapter {
    const name = input.adapterName ?? 'vitest';
    if (name === 'vitest') return createVitestAdapter(input.vitest);
    if (name === 'node-test') return createNodeTestAdapter();
    throw new Error(`Unsupported Pathgrade runner adapter: ${name}`);
}
