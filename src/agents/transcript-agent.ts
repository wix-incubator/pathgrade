import { AgentCommandRunner, AgentSession, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';

/**
 * Base class for agents that manage multi-turn conversations via transcript
 * re-injection (Gemini, Codex). Handles session management, transcript
 * accumulation, and prompt file writing.
 */
export abstract class TranscriptAgent extends BaseAgent {
    async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession> {
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
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);
        return promptPath;
    }

    /** Subclasses implement this to run the CLI command for one turn */
    protected abstract runTurn(instruction: string, runCommand: AgentCommandRunner): Promise<AgentTurnResult>;
}
