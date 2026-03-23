import { AgentCommandRunner, AgentSession, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';

export class CodexAgent extends BaseAgent {
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

    private async runTurn(
        instruction: string,
        runCommand: AgentCommandRunner
    ): Promise<AgentTurnResult> {
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';

        // Pathgrade isolates HOME per trial, so Codex cannot rely on the user's
        // normal ChatGPT login state. Seed API-key auth when OPENAI_API_KEY is available.
        await runCommand('if [ -n "${OPENAI_API_KEY:-}" ]; then printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; fi');

        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);

        const command = `codex exec --full-auto --skip-git-repo-check "$(cat ${promptPath})"`;
        const result = await runCommand(command);
        const rawOutput = result.stdout + '\n' + result.stderr;

        if (result.exitCode !== 0) {
            console.error('CodexAgent: Codex CLI failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage: rawOutput.trim(),
            exitCode: result.exitCode,
        };
    }
}
