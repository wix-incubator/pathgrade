import { EvalDefaults } from './config.types';

/** Single source of truth for default config values. Shared by YAML and TS loaders. */
export const DEFAULT_CONFIG: EvalDefaults = {
    agent: 'gemini',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    environment: {
        cpus: 2,
        memory_mb: 2048,
    },
};
