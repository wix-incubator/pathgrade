import { afterEach, describe, expect, it, vi } from 'vitest';

const prepareWorkspaceMock = vi.fn();
const verifyBundledClaudeRuntimeMock = vi.fn();

vi.mock('../src/providers/workspace', () => ({
    prepareWorkspace: (...args: unknown[]) => prepareWorkspaceMock(...args),
}));

vi.mock('../src/agents/claude-runtime', () => ({
    verifyBundledClaudeRuntime: (...args: unknown[]) => verifyBundledClaudeRuntimeMock(...args),
}));

describe('standalone agent provenance initialization', () => {
    const originalStandalone = process.env.PATHGRADE_STANDALONE;

    afterEach(() => {
        vi.clearAllMocks();
        if (originalStandalone === undefined) delete process.env.PATHGRADE_STANDALONE;
        else process.env.PATHGRADE_STANDALONE = originalStandalone;
    });

    it('disposes the prepared workspace when bundled runtime verification fails', async () => {
        process.env.PATHGRADE_STANDALONE = '1';
        const workspace = {
            path: '/tmp/pathgrade-provenance-cleanup',
            env: { ANTHROPIC_API_KEY: 'test-key' },
            exec: vi.fn(),
            dispose: vi.fn().mockResolvedValue(undefined),
            setupCommands: [],
            mcpConfigPath: undefined,
        };
        prepareWorkspaceMock.mockResolvedValue(workspace);
        verifyBundledClaudeRuntimeMock.mockRejectedValue(new Error('bundled runtime probe failed'));

        const { createAgent } = await import('../src/sdk/agent.js');

        await expect(createAgent({ agent: 'claude' })).rejects.toThrow('bundled runtime probe failed');
        expect(workspace.dispose).toHaveBeenCalledOnce();
    });
});
