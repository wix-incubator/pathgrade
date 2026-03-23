import { BaseAgent, CommandResult } from '../types';

export class CodexAgent extends BaseAgent {
    async run(
        instruction: string,
        _workspacePath: string,
        runCommand: (cmd: string) => Promise<CommandResult>
    ): Promise<string> {
        const promptPath = '"${TMPDIR:-/tmp}/.pathgrade-prompt.md"';

        // Write instruction to a temp file to avoid shell escaping issues with long prompts
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`mkdir -p "\${TMPDIR:-/tmp}" && echo '${b64}' | base64 -d > ${promptPath}`);

        const command = `codex exec --full-auto --skip-git-repo-check "$(cat ${promptPath})"`;
        const result = await runCommand(command);

        if (result.exitCode !== 0) {
            console.error('CodexAgent: Codex CLI failed to execute correctly.');
        }

        return result.stdout + '\n' + result.stderr;
    }
}
