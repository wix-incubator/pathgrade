import { AgentCommandRunner, AgentTurnResult } from '../types';
import { TranscriptAgent } from './transcript-agent';

export class CodexAgent extends TranscriptAgent {
    protected async runTurn(instruction: string, runCommand: AgentCommandRunner): Promise<AgentTurnResult> {
        // Pathgrade isolates HOME per trial, so Codex cannot rely on the user's
        // normal ChatGPT login state. Seed API-key auth when OPENAI_API_KEY is available.
        await runCommand('if [ -n "${OPENAI_API_KEY:-}" ]; then printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; fi');

        const promptPath = await this.writePromptFile(instruction, runCommand);
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
            traceOutput: rawOutput,
        };
    }
}
