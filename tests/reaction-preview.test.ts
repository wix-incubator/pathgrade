import { describe, it, expect } from 'vitest';
import * as sdk from '../src/sdk/index.js';
import type { Message, Reaction } from '../src/sdk/types.js';

describe('previewReactions', () => {
    it('reports fired, vetoed, and unmatched reactions for each agent turn', () => {
        const previewReactions = (sdk as Record<string, unknown>).previewReactions as
            | ((messages: Message[], reactions: Reaction[]) => unknown)
            | undefined;

        expect(previewReactions).toBeTypeOf('function');
        if (!previewReactions) return;

        const messages: Message[] = [
            { role: 'user', content: 'Start' },
            { role: 'agent', content: 'artifact available' },
            { role: 'user', content: 'Continue' },
            { role: 'agent', content: 'no artifact available' },
        ];
        const reactions: Reaction[] = [
            { when: /artifact available/, unless: /no artifact available/, reply: 'Acknowledge artifact' },
            { when: /confirm/, reply: 'Confirm' },
        ];

        expect(previewReactions(messages, reactions)).toEqual({
            turns: [
                {
                    turn: 1,
                    agentMessage: 'artifact available',
                    reactions: [
                        {
                            kind: 'text',
                            reactionIndex: 0,
                            whenMatched: true,
                            unlessMatched: false,
                            fired: true,
                            status: 'fired',
                            reply: 'Acknowledge artifact',
                        },
                        {
                            kind: 'text',
                            reactionIndex: 1,
                            whenMatched: false,
                            unlessMatched: false,
                            fired: false,
                            status: 'no-match',
                        },
                    ],
                },
                {
                    turn: 2,
                    agentMessage: 'no artifact available',
                    reactions: [
                        {
                            kind: 'text',
                            reactionIndex: 0,
                            whenMatched: true,
                            unlessMatched: true,
                            fired: false,
                            status: 'vetoed',
                        },
                        {
                            kind: 'text',
                            reactionIndex: 1,
                            whenMatched: false,
                            unlessMatched: false,
                            fired: false,
                            status: 'no-match',
                        },
                    ],
                },
            ],
        });
    });

    it('handles empty messages and reactions', () => {
        const previewReactions = (sdk as Record<string, unknown>).previewReactions as
            | ((messages: Message[], reactions: Reaction[]) => unknown)
            | undefined;

        expect(previewReactions).toBeTypeOf('function');
        if (!previewReactions) return;

        const messages: Message[] = [
            { role: 'user', content: 'Start' },
            { role: 'agent', content: 'done' },
        ];

        expect(previewReactions([], [])).toEqual({ turns: [] });
        expect(previewReactions(messages, [])).toEqual({
            turns: [
                {
                    turn: 1,
                    agentMessage: 'done',
                    reactions: [],
                },
            ],
        });
    });

    it('only marks the first eligible reaction as fired for a turn', () => {
        const previewReactions = (sdk as Record<string, unknown>).previewReactions as
            | ((messages: Message[], reactions: Reaction[]) => unknown)
            | undefined;

        expect(previewReactions).toBeTypeOf('function');
        if (!previewReactions) return;

        const messages: Message[] = [
            { role: 'user', content: 'Start' },
            { role: 'agent', content: 'confirm artifact available' },
        ];
        const reactions: Reaction[] = [
            { when: /artifact/, reply: 'Artifact reply' },
            { when: /confirm/, reply: 'Confirm reply' },
        ];

        expect(previewReactions(messages, reactions)).toEqual({
            turns: [
                {
                    turn: 1,
                    agentMessage: 'confirm artifact available',
                    reactions: [
                        {
                            kind: 'text',
                            reactionIndex: 0,
                            whenMatched: true,
                            unlessMatched: false,
                            fired: true,
                            status: 'fired',
                            reply: 'Artifact reply',
                        },
                        {
                            kind: 'text',
                            reactionIndex: 1,
                            whenMatched: true,
                            unlessMatched: false,
                            fired: false,
                            status: 'no-match',
                        },
                    ],
                },
            ],
        });
    });
});
