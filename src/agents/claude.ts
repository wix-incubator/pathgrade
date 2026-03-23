import { AgentCommandRunner, AgentSession, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';

export class ClaudeAgent extends BaseAgent {
    async createSession(_runtime: EnvironmentHandle, runCommand: AgentCommandRunner): Promise<AgentSession> {
        return {
            start: async ({ message }) => this.runTurn(message, runCommand, false),
            reply: async ({ message }) => this.runTurn(message, runCommand, true),
        };
    }

    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const result = await this.runTurn(instruction, runCommand, false);
        return result.rawOutput;
    }

    private async runTurn(
        instruction: string,
        runCommand: AgentCommandRunner,
        continueSession: boolean
    ): Promise<AgentTurnResult> {
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';

        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);

        const command = `claude -p${continueSession ? ' -c' : ''} --dangerously-skip-permissions "$(cat ${promptPath})"`;
        const result = await runCommand(command);
        const rawOutput = result.stdout + '\n' + result.stderr;

        if (result.exitCode !== 0) {
            console.error('ClaudeAgent: Claude failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage: rawOutput.trim(),
            exitCode: result.exitCode,
        };
    }
}
