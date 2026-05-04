/**
 * Agent registry — maps agent names to their implementations.
 *
 * Supported agents:
 *   - claude: Anthropic Claude Code CLI
 *   - codex: OpenAI Codex CLI
 */
import { BaseAgent } from '../types.js';
import { AgentName, AgentTransport } from '../sdk/types.js';
import { ClaudeAgent } from './claude.js';
import { CodexAgent } from './codex.js';
import { CodexAppServerAgent } from './codex-app-server/agent.js';
import { CursorAgent } from './cursor.js';

/** Registry of available agent implementations. Codex routing is transport-aware. */
const AGENT_REGISTRY: Record<AgentName, (transport?: AgentTransport) => BaseAgent> = {
    claude: () => new ClaudeAgent(),
    codex: (transport) =>
        transport === 'exec' ? new CodexAgent() : new CodexAppServerAgent(),
    cursor: () => new CursorAgent(),
};

/** Get the list of supported agent names */
export function getAgentNames(): AgentName[] {
    return Object.keys(AGENT_REGISTRY) as AgentName[];
}

/**
 * Create an agent instance by name. Throws if the name is unknown.
 * For `codex`, `transport` selects between `CodexAgent` (exec) and
 * `CodexAppServerAgent` (default / app-server). Ignored for other agents.
 */
export function createAgentEnvironment(name: AgentName, transport?: AgentTransport): BaseAgent {
    const factory = AGENT_REGISTRY[name];
    if (!factory) {
        const available = getAgentNames().join(', ');
        throw new Error(`Unknown agent "${name}". Available agents: ${available}`);
    }
    return factory(transport);
}
