import { defineConfig } from 'vitest/config';
import { pathgrade } from '../../src/plugin/index.js';

export default defineConfig({
    plugins: [pathgrade({
        include: ['examples/hello-world-per-test/test/**/*.eval.ts'],
        timeout: 600,
    })],
    test: {
        env: {
            ...(process.env.APP_ANTHROPIC_BASE_URL && { ANTHROPIC_BASE_URL: process.env.APP_ANTHROPIC_BASE_URL }),
            ...(process.env.APP_ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.APP_ANTHROPIC_API_KEY }),
            ...(process.env.APP_OPENAI_API_KEY && { OPENAI_API_KEY: process.env.APP_OPENAI_API_KEY }),
            ...(process.env.APP_OPENAI_BASE_URL && { OPENAI_BASE_URL: process.env.APP_OPENAI_BASE_URL }),
        },
    },
});
