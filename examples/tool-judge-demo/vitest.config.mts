import { defineConfig } from 'vitest/config';
import { pathgrade } from '../../src/plugin/index.js';

export default defineConfig({
    plugins: [pathgrade({
        include: ['examples/tool-judge-demo/test/**/*.eval.ts'],
        timeout: 600,
    })],
    test: {
        env: {
            ...(process.env.APP_ANTHROPIC_BASE_URL && { ANTHROPIC_BASE_URL: process.env.APP_ANTHROPIC_BASE_URL }),
            ...(process.env.APP_ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.APP_ANTHROPIC_API_KEY }),
        },
    },
});
