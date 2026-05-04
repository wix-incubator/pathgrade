import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockLoadReactionSnapshotMessages,
    mockLoadReactionsFromFile,
    mockPreviewReactions,
} = vi.hoisted(() => ({
    mockLoadReactionSnapshotMessages: vi.fn(),
    mockLoadReactionsFromFile: vi.fn(),
    mockPreviewReactions: vi.fn(),
}));

vi.mock('../src/sdk/reaction-loader', () => ({
    loadReactionSnapshotMessages: mockLoadReactionSnapshotMessages,
    loadReactionsFromFile: mockLoadReactionsFromFile,
}));

vi.mock('../src/sdk/reaction-preview', () => ({
    previewReactions: mockPreviewReactions,
}));

async function loadCommand() {
    return import('../src/commands/' + 'preview-reactions');
}

beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('runPreviewReactions', () => {
    it('prints structured json output', async () => {
        const command = await loadCommand();
        const previewResult = {
            turns: [
                {
                    turn: 1,
                    agentMessage: 'artifact available',
                    reactions: [
                        { reactionIndex: 0, whenMatched: true, unlessMatched: false, fired: true, reply: 'Ack' },
                    ],
                },
            ],
        };

        mockLoadReactionSnapshotMessages.mockResolvedValue([{ role: 'agent', content: 'artifact available' }]);
        mockLoadReactionsFromFile.mockResolvedValue([{ when: /artifact/, reply: 'Ack' }]);
        mockPreviewReactions.mockReturnValue(previewResult);

        expect(command.runPreviewReactions).toBeTypeOf('function');
        if (typeof command.runPreviewReactions !== 'function') return;

        await command.runPreviewReactions([
            '--snapshot', '/tmp/run-snapshot.json',
            '--reactions', '/tmp/reactions.ts',
            '--format', 'json',
        ]);

        expect(mockLoadReactionSnapshotMessages).toHaveBeenCalledWith('/tmp/run-snapshot.json');
        expect(mockLoadReactionsFromFile).toHaveBeenCalledWith('/tmp/reactions.ts');
        expect(mockPreviewReactions).toHaveBeenCalled();
        expect(console.log).toHaveBeenCalledWith(JSON.stringify(previewResult, null, 2));
    });

    it('prints human-readable cli output with fired and vetoed statuses', async () => {
        const command = await loadCommand();

        mockLoadReactionSnapshotMessages.mockResolvedValue([{ role: 'agent', content: 'artifact available' }]);
        mockLoadReactionsFromFile.mockResolvedValue([{ when: /artifact/, reply: 'Ack' }]);
        mockPreviewReactions.mockReturnValue({
            turns: [
                {
                    turn: 1,
                    agentMessage: 'artifact available',
                    reactions: [
                        { kind: 'text', reactionIndex: 0, whenMatched: true, unlessMatched: false, fired: true, reply: 'Ack' },
                        { kind: 'text', reactionIndex: 1, whenMatched: true, unlessMatched: true, fired: false },
                        { kind: 'text', reactionIndex: 2, whenMatched: false, unlessMatched: false, fired: false },
                    ],
                },
            ],
        });

        expect(command.runPreviewReactions).toBeTypeOf('function');
        if (typeof command.runPreviewReactions !== 'function') return;

        await command.runPreviewReactions([
            '--snapshot', '/tmp/run-snapshot.json',
            '--reactions', '/tmp/reactions.ts',
        ]);

        const output = vi.mocked(console.log).mock.calls.flat().join('\n');
        expect(output).toContain('Turn 1');
        expect(output).toContain('artifact available');
        expect(output).toContain('[0] fired');
        expect(output).toContain('[1] vetoed');
        expect(output).toContain('[2] no-match');
    });

    it('rejects missing required flags and invalid formats', async () => {
        const command = await loadCommand();

        expect(command.runPreviewReactions).toBeTypeOf('function');
        if (typeof command.runPreviewReactions !== 'function') return;

        await expect(command.runPreviewReactions(['--snapshot', '/tmp/run-snapshot.json'])).rejects.toThrow(/--reactions/i);
        await expect(command.runPreviewReactions([
            '--snapshot', '/tmp/run-snapshot.json',
            '--reactions', '/tmp/reactions.ts',
            '--format', 'table',
        ])).rejects.toThrow(/--format/i);
    });
});
