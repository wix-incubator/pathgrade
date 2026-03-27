import { AgentCommandRunner, AgentTurnResult } from '../types';
import { TranscriptAgent } from './transcript-agent';

export class GeminiAgent extends TranscriptAgent {
    protected async runTurn(instruction: string, runCommand: AgentCommandRunner): Promise<AgentTurnResult> {
        const promptPath = await this.writePromptFile(instruction, runCommand);
        const command = `gemini -y --sandbox=none -p "$(cat ${promptPath})"`;
        const result = await runCommand(command);
        const rawOutput = result.stdout + '\n' + result.stderr;

        if (result.exitCode !== 0) {
            console.error('GeminiAgent: Gemini CLI failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage: rawOutput.trim(),
            exitCode: result.exitCode,
            traceOutput: rawOutput,
        };
    }
}
