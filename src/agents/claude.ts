import { AgentCommandRunner, AgentSession, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';

export class ClaudeAgent extends BaseAgent {
    async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession> {
        let sessionId: string | undefined;

        return {
            start: async ({ message }) => {
                const result = await this.runTurn(message, runCommand, undefined);
                sessionId = result.sessionId;
                return result;
            },
            reply: async ({ message }) => {
                const result = await this.runTurn(message, runCommand, sessionId);
                return result;
            },
        };
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const result = await this.runTurn(instruction, runCommand, undefined);
        return result.rawOutput;
    }

    private async runTurn(
        instruction: string,
        runCommand: AgentCommandRunner,
        sessionId: string | undefined
    ): Promise<AgentTurnResult & { sessionId?: string }> {
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';

        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);

        // Use --output-format json to capture session_id from the response envelope.
        // For continuation, use --resume to target the exact session from turn 1.
        const sessionFlag = sessionId ? ` --resume ${sessionId}` : '';
        const command = `claude -p${sessionFlag} --output-format json --dangerously-skip-permissions "$(cat ${promptPath})" < /dev/null`;
        const result = await runCommand(command);

        // Parse the JSON envelope to extract the text response and session_id
        const { text, extractedSessionId } = this.parseJsonEnvelope(result.stdout);
        const rawOutput = text || (result.stdout + '\n' + result.stderr);

        if (result.exitCode !== 0) {
            console.error('ClaudeAgent: Claude failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage: rawOutput.trim(),
            exitCode: result.exitCode,
            sessionId: extractedSessionId,
        };
    }

    private parseJsonEnvelope(stdout: string): { text: string; extractedSessionId?: string } {
        try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return { text: '' };

            const envelope = JSON.parse(jsonMatch[0]);
            const text = envelope.result || '';
            const extractedSessionId = envelope.session_id;
            return { text, extractedSessionId };
        } catch {
            // If JSON parsing fails, return the raw stdout
            return { text: stdout.trim() };
        }
    }
}
