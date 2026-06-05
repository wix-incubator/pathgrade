import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AskBus } from '../../sdk/ask-bus/types.js';
import {
    decideMcpToolCall,
    redactMcpSecrets,
    type McpSafetyOptions,
    type McpToolPolicyDecision,
} from '../../sdk/mcp-safety.js';
import {
    createAskUserBridge,
    type AskUserBridge,
} from './ask-user-bridge.js';
import type { AskUserAnswerStore } from './ask-user-answer-store.js';
import { parseClaudeSdkMcpToolName } from './mcp-tool-name.js';
import type { ClaudeDeniedMcpEventStore } from './denied-mcp-event-store.js';

export interface ClaudeToolPermissionBridgeDeps {
    askBus: AskBus;
    getTurnNumber: () => number;
    answerStore: AskUserAnswerStore;
    mcpServerNames: readonly string[];
    mcpSafety?: McpSafetyOptions;
    deniedMcpEvents?: ClaudeDeniedMcpEventStore;
}

export type ClaudeToolPermissionBridge = CanUseTool & {
    lastError(): Error | null;
    clearLastError(): void;
};

export function createClaudeToolPermissionBridge(
    deps: ClaudeToolPermissionBridgeDeps,
): ClaudeToolPermissionBridge {
    const askUserBridge: AskUserBridge = createAskUserBridge({
        askBus: deps.askBus,
        getTurnNumber: deps.getTurnNumber,
        answerStore: deps.answerStore,
    });

    const canUseTool: CanUseTool = async (toolName, input, options) => {
        if (toolName === 'AskUserQuestion') {
            return askUserBridge(toolName, input, options);
        }

        const runMode = deps.mcpSafety?.runMode ?? 'mock';
        const parsed = parseClaudeSdkMcpToolName(toolName, deps.mcpServerNames);
        if (parsed.kind === 'non_mcp') {
            return allow(input);
        }
        if (runMode === 'mock') {
            return allow(input);
        }
        if (parsed.kind === 'unrecognized') {
            return {
                behavior: 'deny',
                message: `unrecognized Claude SDK MCP tool name: ${toolName}`,
            };
        }

        const decision = decideMcpToolCall(deps.mcpSafety, {
            serverName: parsed.server,
            toolName: parsed.tool,
            arguments: asRecord(input),
        });
        if (decision.action === 'allow') return allow(input);
        recordDeniedMcpEvent({
            store: deps.deniedMcpEvents,
            toolUseId: options.toolUseID,
            serverName: parsed.server,
            toolName: parsed.tool,
            input: asRecord(input),
            decision,
        });
        return { behavior: 'deny', message: decision.message };
    };

    const bridge = canUseTool as ClaudeToolPermissionBridge;
    bridge.lastError = () => askUserBridge.lastError();
    bridge.clearLastError = () => askUserBridge.clearLastError();
    return bridge;
}

function allow(input: unknown): PermissionResult {
    return { behavior: 'allow', updatedInput: asRecord(input) };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function recordDeniedMcpEvent(opts: {
    store: ClaudeDeniedMcpEventStore | undefined;
    toolUseId: string;
    serverName: string;
    toolName: string;
    input: Record<string, unknown>;
    decision: Extract<McpToolPolicyDecision, { action: 'deny' }>;
}): void {
    if (!opts.store) return;
    const providerToolName = `${opts.serverName}.${opts.toolName}`;
    const args = redactMcpSecrets(opts.input);
    const event = {
        action: 'mcp_tool_call',
        provider: 'claude',
        providerToolName,
        arguments: {
            ...args,
            server: opts.serverName,
            tool: opts.toolName,
            status: 'policy_denied',
            policyResult: {
                action: 'deny',
                reason: opts.decision.reason,
                message: opts.decision.message,
            },
        },
        summary: `MCP tool ${providerToolName} policy_denied`,
        confidence: 'high',
        rawSnippet: JSON.stringify(redactMcpSecrets({
            toolUseID: opts.toolUseId,
            input: opts.input,
        })).slice(0, 200),
    } as const;
    opts.store.record(opts.toolUseId, event);
}
