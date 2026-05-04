import { defineConfig } from 'vitest/config';

export default defineConfig({
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
