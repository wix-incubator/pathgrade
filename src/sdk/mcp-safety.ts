export type McpRunMode = 'mock' | 'live-readonly' | 'live-sandbox' | 'live';

export interface McpToolPolicyRule {
    serverName?: string;
    toolName?: string;
    readonly?: boolean;
}

export interface McpToolPolicy {
    allow?: McpToolPolicyRule[];
    deny?: McpToolPolicyRule[];
}

export interface McpSafetyOptions {
    runMode?: McpRunMode;
    liveOptIn?: boolean;
    mcpToolPolicy?: McpToolPolicy;
}

export interface McpToolCallRequest {
    serverName: string;
    toolName: string;
    arguments?: Record<string, unknown>;
}

export type McpPolicyDenialReason =
    | 'missing_live_opt_in'
    | 'missing_mcp_tool_policy'
    | 'denylisted'
    | 'not_allowlisted'
    | 'not_marked_readonly'
    | 'unrecognized_mcp_tool_name';

export type McpToolPolicyDecision =
    | { action: 'allow' }
    | {
        action: 'deny';
        reason: McpPolicyDenialReason;
        message: string;
    };

const SECRET_KEY_PATTERN = /(^|[_-])(api[_-]?key|token|secret|password|authorization|auth|bearer)([_-]|$)|authorization/i;

export function decideMcpToolCall(
    options: McpSafetyOptions | undefined,
    request: McpToolCallRequest,
): McpToolPolicyDecision {
    const runMode = options?.runMode ?? 'mock';
    if (runMode === 'mock') return { action: 'allow' };
    if (!options?.liveOptIn) {
        return deny('missing_live_opt_in', 'Live MCP tool calls require explicit mcpSafety.liveOptIn.');
    }

    const policy = options.mcpToolPolicy;
    if (runMode === 'live-readonly' && !policy) {
        return deny('missing_mcp_tool_policy', 'live-readonly MCP runs require an explicit mcpToolPolicy.');
    }

    const denyRule = policy?.deny?.find((rule) => ruleMatches(rule, request));
    if (denyRule) {
        return deny('denylisted', `MCP tool ${request.serverName}.${request.toolName} is denied by policy.`);
    }

    const allowRules = policy?.allow ?? [];
    if (allowRules.length > 0) {
        const allowRule = allowRules.find((rule) => ruleMatches(rule, request));
        if (!allowRule) {
            return deny('not_allowlisted', `MCP tool ${request.serverName}.${request.toolName} is not allowlisted.`);
        }
        if (runMode === 'live-readonly' && allowRule.readonly !== true) {
            return deny('not_marked_readonly', `MCP tool ${request.serverName}.${request.toolName} is not marked readonly.`);
        }
        return { action: 'allow' };
    }

    if (runMode === 'live-readonly') {
        return deny('not_allowlisted', `MCP tool ${request.serverName}.${request.toolName} is not allowlisted.`);
    }

    return { action: 'allow' };
}

export function redactMcpSecrets<T>(value: T): T {
    return redactValue(value, '') as T;
}

function ruleMatches(rule: McpToolPolicyRule, request: McpToolCallRequest): boolean {
    if (rule.serverName !== undefined && rule.serverName !== request.serverName) return false;
    if (rule.toolName !== undefined && rule.toolName !== request.toolName) return false;
    return true;
}

function deny(reason: McpPolicyDenialReason, message: string): McpToolPolicyDecision {
    return { action: 'deny', reason, message };
}

function redactValue(value: unknown, key: string): unknown {
    if (SECRET_KEY_PATTERN.test(key)) return '<redacted>';
    if (Array.isArray(value)) return value.map((entry) => redactValue(entry, key));
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                redactValue(entryValue, entryKey),
            ]),
        );
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
