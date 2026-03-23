import { BaseAgent, CommandResult } from '../types';

export class CodexAgent extends BaseAgent {
    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`echo '${b64}' | base64 -d > /tmp/.prompt.md`);

        const command = `codex exec --full-auto --skip-git-repo-check "$(cat /tmp/.prompt.md)"`;
        const result = await runCommand(command);

        if (result.exitCode !== 0) {
            console.error('CodexAgent: Codex CLI failed to execute correctly.');
        }

        return result.stdout + '\n' + result.stderr;
    }
}
