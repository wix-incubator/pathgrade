import type { AgentName, AgentTransport, AgentOptions } from './types.js';

export class InvalidTransportEnvError extends Error {
    constructor(value: string) {
        super(
            `Invalid PATHGRADE_CODEX_TRANSPORT value: '${value}'. Valid options: 'exec', 'app-server'.`,
        );
        this.name = 'InvalidTransportEnvError';
    }
}

export class StandaloneCodexTransportError extends Error {
    constructor() {
        super("pathgrade standalone supports Codex app-server only; remove transport: 'exec' or use project-local @wix/pathgrade");
        this.name = 'StandaloneCodexTransportError';
    }
}

export function resolveAgentName(
    opts: Pick<AgentOptions, 'agent'>,
    env: { PATHGRADE_AGENT?: string },
): AgentName {
    return (opts.agent || (env.PATHGRADE_AGENT as AgentName) || 'claude') as AgentName;
}

export function resolveCodexTransport(
    opts: { transport?: AgentTransport },
    env: { PATHGRADE_CODEX_TRANSPORT?: string; PATHGRADE_STANDALONE?: string },
): AgentTransport {
    if (opts.transport) {
        if (opts.transport === 'exec' && env.PATHGRADE_STANDALONE === '1') {
            throw new StandaloneCodexTransportError();
        }
        return opts.transport;
    }
    const envValue = env.PATHGRADE_CODEX_TRANSPORT;
    if (envValue) {
        if (envValue !== 'exec' && envValue !== 'app-server') {
            throw new InvalidTransportEnvError(envValue);
        }
        if (envValue === 'exec' && env.PATHGRADE_STANDALONE === '1') {
            throw new StandaloneCodexTransportError();
        }
        return envValue;
    }
    return 'app-server';
}

export function assertStandaloneAgent(
    agent: AgentName,
    transport?: AgentTransport,
): void {
    if (agent === 'cursor') {
        throw new Error('Cursor is unsupported in pathgrade standalone');
    }
    if (agent === 'codex' && transport !== 'app-server') {
        throw new Error('pathgrade standalone supports Codex app-server only');
    }
}
