import { describe, expect, it } from 'vitest';
import { getAgentCapabilities } from '../src/sdk/types.js';
import type { AgentTransport } from '../src/sdk/types.js';
import {
    planRuntimePolicies,
    NONINTERACTIVE_RUNTIME_POLICY,
} from '../src/sdk/runtime-policy.js';

describe('getAgentCapabilities', () => {
    it('returns noninteractive ask-user transport for codex + exec (default)', () => {
        expect(getAgentCapabilities('codex', 'exec').interactiveQuestionTransport).toBe('noninteractive');
        expect(getAgentCapabilities('codex').interactiveQuestionTransport).toBe('noninteractive');
    });

    it('returns reliable ask-user transport for codex + app-server', () => {
        expect(getAgentCapabilities('codex', 'app-server').interactiveQuestionTransport).toBe('reliable');
    });

    it('returns noninteractive ask-user transport for claude regardless of transport', () => {
        expect(getAgentCapabilities('claude').interactiveQuestionTransport).toBe('noninteractive');
        expect(getAgentCapabilities('claude', 'app-server').interactiveQuestionTransport).toBe('noninteractive');
        expect(getAgentCapabilities('claude', 'exec').interactiveQuestionTransport).toBe('noninteractive');
    });

    it('returns noninteractive ask-user transport for cursor regardless of transport', () => {
        expect(getAgentCapabilities('cursor').interactiveQuestionTransport).toBe('noninteractive');
        expect(getAgentCapabilities('cursor', 'app-server' as AgentTransport).interactiveQuestionTransport).toBe('noninteractive');
    });

    it('keeps mcp/nativeSession flags stable across all four combinations', () => {
        expect(getAgentCapabilities('codex', 'exec')).toMatchObject({ mcp: false, nativeSession: true });
        expect(getAgentCapabilities('codex', 'app-server')).toMatchObject({ mcp: false, nativeSession: true });
        expect(getAgentCapabilities('claude')).toMatchObject({ mcp: true, nativeSession: true });
        expect(getAgentCapabilities('cursor')).toMatchObject({ mcp: true, nativeSession: true });
    });
});

describe('planRuntimePolicies transport-aware', () => {
    it('still plans the noninteractive policy for codex under undefined/exec transport', () => {
        expect(planRuntimePolicies('codex')).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
        expect(planRuntimePolicies('codex', 'exec')).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
    });

    it('plans no runtime policy for codex under app-server (transport reaches the agent)', () => {
        expect(planRuntimePolicies('codex', 'app-server')).toEqual([]);
    });

    it('still plans the noninteractive policy for claude regardless of transport', () => {
        expect(planRuntimePolicies('claude')).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
        expect(planRuntimePolicies('claude', 'app-server')).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
    });

    it('still plans the noninteractive policy for cursor regardless of transport', () => {
        expect(planRuntimePolicies('cursor')).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
        expect(planRuntimePolicies('cursor', 'app-server' as AgentTransport)).toEqual([NONINTERACTIVE_RUNTIME_POLICY]);
    });
});
