import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@wix/pathgrade/plugin/vitest': path.resolve(__dirname, 'src/adapters/vitest/index.ts'),
      '@wix/pathgrade/plugin': path.resolve(__dirname, 'src/plugin/index.ts'),
      '@wix/pathgrade': path.resolve(__dirname, 'src/sdk/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/.worktrees/**'],
    env: {
      ...(process.env.APP_ANTHROPIC_BASE_URL && { ANTHROPIC_BASE_URL: process.env.APP_ANTHROPIC_BASE_URL }),
      ...(process.env.APP_ANTHROPIC_API_KEY && { ANTHROPIC_API_KEY: process.env.APP_ANTHROPIC_API_KEY }),
      ...(process.env.APP_OPENAI_BASE_URL && { OPENAI_BASE_URL: process.env.APP_OPENAI_BASE_URL }),
      ...(process.env.APP_OPENAI_API_KEY && { OPENAI_API_KEY: process.env.APP_OPENAI_API_KEY }),
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/reporters/browser.ts',
        'src/commands/init.ts',
      ],
    },
  },
});
