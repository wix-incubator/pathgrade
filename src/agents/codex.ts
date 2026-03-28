import { AgentCommandRunner, AgentTurnResult } from '../types';
import { TranscriptAgent } from './transcript-agent';

export class CodexAgent extends TranscriptAgent {
    protected async runTurn(instruction: string, runCommand: AgentCommandRunner): Promise<AgentTurnResult> {
        // Pathgrade isolates HOME per trial, so Codex cannot rely on the user's
        // normal ChatGPT login state. Seed API-key auth when OPENAI_API_KEY is available,
        // but never mutate the user's host Codex login when PathGrade selected host auth.
        await runCommand('if [ "${PATHGRADE_CODEX_USE_HOST_AUTH:-0}" != "1" ] && [ -n "${OPENAI_API_KEY:-}" ]; then printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1; fi');

        const promptPath = await this.writePromptFile(instruction, runCommand);
        const quotedPromptPath = JSON.stringify(promptPath);
        const command = 'if [ "${PATHGRADE_CODEX_USE_HOST_AUTH:-0}" = "1" ]; then ' +
            `env -u OPENAI_API_KEY -u OPENAI_BASE_URL codex exec --full-auto --skip-git-repo-check - < ${quotedPromptPath}; ` +
            'else ' +
            `codex exec --full-auto --skip-git-repo-check - < ${quotedPromptPath}; ` +
            'fi';
        const result = await runCommand(command);
        const rawOutput = result.stdout + '\n' + result.stderr;
        const assistantMessage = result.stdout.trim() || rawOutput.trim();

        if (result.exitCode !== 0) {
            console.error('CodexAgent: Codex CLI failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage,
            exitCode: result.exitCode,
            traceOutput: rawOutput,
        };
    }
}
