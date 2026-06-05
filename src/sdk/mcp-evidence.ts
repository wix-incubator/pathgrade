import type { ToolEvent } from '../tool-events.js';

export interface McpToolCallEvidence {
    serverName: string;
    toolName: string;
    status: string;
    arguments: Record<string, unknown>;
    event: ToolEvent;
}

export interface ExpectedMcpToolCall {
    serverName?: string;
    toolName?: string;
    status?: string;
    argumentsContaining?: Record<string, unknown>;
}

export interface McpStartupStatusEvidence {
    serverName: string;
    status: string;
    error?: string;
    event: ToolEvent;
}

export interface ExpectedMcpStartupStatus {
    serverName?: string;
    status?: string;
}

export function getMcpToolCall(event: ToolEvent): McpToolCallEvidence | undefined {
    if (event.action !== 'mcp_tool_call') return undefined;
    const args = event.arguments ?? {};
    const serverName = typeof args.server === 'string' ? args.server : undefined;
    const toolName = typeof args.tool === 'string' ? args.tool : undefined;
    const status = typeof args.status === 'string' ? args.status : undefined;
    if (!serverName || !toolName || !status) return undefined;

    return {
        serverName,
        toolName,
        status,
        arguments: args,
        event,
    };
}

export function isMcpToolCall(
    event: ToolEvent,
    expected: ExpectedMcpToolCall = {},
): boolean {
    const call = getMcpToolCall(event);
    if (!call) return false;
    if (expected.serverName !== undefined && call.serverName !== expected.serverName) return false;
    if (expected.toolName !== undefined && call.toolName !== expected.toolName) return false;
    if (expected.status !== undefined && call.status !== expected.status) return false;
    if (expected.argumentsContaining && !containsArguments(call.arguments, expected.argumentsContaining)) {
        return false;
    }
    return true;
}

export function findMcpToolCalls(
    events: readonly ToolEvent[],
    expected: ExpectedMcpToolCall = {},
): McpToolCallEvidence[] {
    return events
        .map((event) => getMcpToolCall(event))
        .filter((call): call is McpToolCallEvidence =>
            call !== undefined && matchesMcpToolCall(call, expected));
}

export function getMcpStartupStatus(event: ToolEvent): McpStartupStatusEvidence | undefined {
    if (event.providerToolName !== 'mcpServer/startupStatus/updated') return undefined;
    const args = event.arguments ?? {};
    const serverName = typeof args.name === 'string' ? args.name : undefined;
    const status = typeof args.status === 'string' ? args.status : undefined;
    if (!serverName || !status) return undefined;
    const error = typeof args.error === 'string' ? args.error : undefined;

    return {
        serverName,
        status,
        ...(error ? { error } : {}),
        event,
    };
}

export function isMcpStartupStatus(
    event: ToolEvent,
    expected: ExpectedMcpStartupStatus = {},
): boolean {
    const startup = getMcpStartupStatus(event);
    if (!startup) return false;
    if (expected.serverName !== undefined && startup.serverName !== expected.serverName) return false;
    if (expected.status !== undefined && startup.status !== expected.status) return false;
    return true;
}

function matchesMcpToolCall(
    call: McpToolCallEvidence,
    expected: ExpectedMcpToolCall,
): boolean {
    if (expected.serverName !== undefined && call.serverName !== expected.serverName) return false;
    if (expected.toolName !== undefined && call.toolName !== expected.toolName) return false;
    if (expected.status !== undefined && call.status !== expected.status) return false;
    if (expected.argumentsContaining && !containsArguments(call.arguments, expected.argumentsContaining)) {
        return false;
    }
    return true;
}

function containsArguments(
    actual: Record<string, unknown>,
    expected: Record<string, unknown>,
): boolean {
    return Object.entries(expected).every(([key, expectedValue]) =>
        valuesEqual(actual[key], expectedValue));
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
    if (Object.is(actual, expected)) return true;
    if (Array.isArray(actual) || Array.isArray(expected)) {
        if (!Array.isArray(actual) || !Array.isArray(expected)) return false;
        if (actual.length !== expected.length) return false;
        return actual.every((value, index) => valuesEqual(value, expected[index]));
    }
    if (isRecord(actual) && isRecord(expected)) {
        return Object.entries(expected).every(([key, value]) => valuesEqual(actual[key], value));
    }
    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
