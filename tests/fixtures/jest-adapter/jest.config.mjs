export default {
    testEnvironment: 'node',
    rootDir: '../../..',
    testMatch: ['<rootDir>/tests/fixtures/jest-adapter/**/*.eval.ts'],
    transform: {
        '^.+\\.ts$': '<rootDir>/tests/fixtures/jest-adapter/ts-transform.cjs',
    },
    modulePathIgnorePatterns: ['<rootDir>/.worktrees/'],
    testPathIgnorePatterns: ['<rootDir>/.worktrees/'],
    extensionsToTreatAsEsm: ['.ts'],
    setupFilesAfterEnv: ['<rootDir>/dist/adapters/jest/setup.js'],
    reporters: ['default', '<rootDir>/dist/adapters/jest/reporter.cjs'],
};
