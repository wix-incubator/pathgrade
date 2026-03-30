import { randomUUID } from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { AgentCommandRunner, AgentSession, AgentSessionOptions, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';

/**
 * Base class for agents that manage multi-turn conversations via transcript
 * re-injection (e.g. Codex). Handles session management, transcript
 * accumulation, and prompt file writing.
 */
export abstract class TranscriptAgent extends BaseAgent {
    async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner, _options?: AgentSessionOptions): Promise<AgentSession> {
        const transcript: string[] = [];

        const runTranscriptTurn = async (message: string): Promise<AgentTurnResult> => {
            transcript.push(`User: ${message}`);
            const result = await this.runTurn(this.buildTranscriptPrompt(transcript), runCommand);
            transcript.push(`Assistant: ${result.assistantMessage}`);
            return result;
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
        return result.rawOutput;
    }

    private buildTranscriptPrompt(transcript: string[]): string {
        return [
            'Continue the conversation below. Respond to the latest user message and do not re-execute previous work unless it is necessary to answer correctly.',
            transcript.join('\n\n'),
        ].join('\n\n');
    }

    protected async writePromptFile(instruction: string, runCommand: AgentCommandRunner): Promise<string> {
        void runCommand;
        const promptPath = path.join(process.env.TMPDIR || os.tmpdir(), `.pathgrade-prompt-${randomUUID()}.md`);
        await fs.ensureDir(path.dirname(promptPath));
        await fs.writeFile(promptPath, instruction, 'utf8');
        return promptPath;
    }

    /** Subclasses implement this to run the CLI command for one turn */
    protected abstract runTurn(instruction: string, runCommand: AgentCommandRunner): Promise<AgentTurnResult>;
}
