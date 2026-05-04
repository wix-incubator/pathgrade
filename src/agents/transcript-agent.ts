import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types.js';
import { createConversationWindow, type ConversationWindow } from '../sdk/conversation-window.js';
import { prependRuntimePolicies } from '../sdk/runtime-policy.js';
import type { Message } from '../sdk/types.js';
import { getVisibleAssistantMessage } from '../sdk/visible-turn.js';

/**
 * Base class for agents that manage multi-turn conversations via transcript
 * re-injection (e.g. Codex). Handles session management, transcript
 * accumulation, and prompt file writing.
 */
export abstract class TranscriptAgent extends BaseAgent {
    async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner, options?: AgentSessionOptions): Promise<AgentSession> {
        const messages: Message[] = [];
        const runtimePolicies = options?.runtimePolicies ?? [];
        const window = options?.conversationWindow !== false
            ? createConversationWindow({ ...options?.conversationWindow, llm: options?.llm })
            : null;

        const runTranscriptTurn = async (message: string): Promise<AgentTurnResult> => {
            messages.push({ role: 'user', content: message });
            const prompt = await this.buildTranscriptPrompt(messages, window, runtimePolicies);
            const result = await this.runTurn(prompt, runCommand, options);
            const enrichedResult: AgentTurnResult = runtimePolicies.length > 0
                ? { ...result, runtimePoliciesApplied: [...runtimePolicies] }
                : result;
            messages.push({ role: 'agent', content: getVisibleAssistantMessage(enrichedResult) });
            return enrichedResult;
        };

        return {
            start: async ({ message }) => runTranscriptTurn(message),
            reply: async ({ message }) => runTranscriptTurn(message),
        };
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const result = await this.runTurn(instruction, runCommand);
        return getVisibleAssistantMessage(result);
    }

    private async buildTranscriptPrompt(
        messages: Message[],
        window: ConversationWindow | null,
        runtimePolicies: AgentSessionOptions['runtimePolicies'] = [],
    ): Promise<string> {
        const history = window
            ? await window.getHistory(messages)
            : messages.map(m => `${m.role === 'user' ? 'User' : 'Agent'}: ${m.content}`).join('\n\n');
        const instruction = [
            'Continue the conversation below. Respond to the latest user message and do not re-execute previous work unless it is necessary to answer correctly.',
            history,
        ].join('\n\n');
        return runtimePolicies.length > 0
            ? prependRuntimePolicies(instruction, runtimePolicies, { agent: 'codex' })
            : instruction;
    }

    protected async writePromptFile(instruction: string, runCommand: AgentCommandRunner): Promise<string> {
        void runCommand;
        const promptPath = path.join(process.env.TMPDIR || os.tmpdir(), `.pathgrade-prompt-${randomUUID()}.md`);
        await fs.ensureDir(path.dirname(promptPath));
        await fs.writeFile(promptPath, instruction, 'utf8');
        return promptPath;
    }

    /** Subclasses implement this to run the CLI command for one turn */
    protected abstract runTurn(
        instruction: string,
        runCommand: AgentCommandRunner,
        options?: AgentSessionOptions,
    ): Promise<AgentTurnResult>;
}
