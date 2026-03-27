import { AgentCommandRunner, AgentSession, AgentTurnResult, BaseAgent, CommandResult, EnvironmentHandle } from '../types';

interface PermissionDenial {
    tool_name: string;
    tool_input?: Record<string, unknown>;
}

interface AskUserQuestionInput {
    questions?: Array<{
        question: string;
        header?: string;
        options?: Array<{ label: string; description?: string }>;
        multiSelect?: boolean;
    }>;
}

interface ClaudeEnvelope {
    result?: string;
    session_id?: string;
    is_error?: boolean;
    permission_denials?: PermissionDenial[];
}

const API_ERROR_PATTERN = /^API Error:\s*\d{3}\b/;

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
        const sanitized = sessionId ? this.sanitizeSessionId(sessionId) : undefined;
        const sessionFlag = sanitized ? ` --resume ${sanitized}` : '';
        const command = `claude -p${sessionFlag} --output-format json --dangerously-skip-permissions "$(cat ${promptPath})" < /dev/null`;
        const result = await runCommand(command);

        // Parse the JSON envelope to extract the text response and session_id.
        // Only fall back to raw stdout when there's no JSON envelope at all.
        const parsed = this.parseJsonEnvelope(result.stdout);
        const rawOutput = parsed.envelopeFound
            ? parsed.text
            : (result.stdout + '\n' + result.stderr);

        if (result.exitCode !== 0) {
            console.error('ClaudeAgent: Claude failed to execute correctly.');
        }

        return {
            rawOutput,
            assistantMessage: rawOutput.trim(),
            exitCode: result.exitCode,
            sessionId: parsed.extractedSessionId,
        };
    }

    private sanitizeSessionId(id: string): string {
        // Claude session IDs are alphanumeric with hyphens and underscores
        const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '');
        if (sanitized !== id) {
            console.warn(`ClaudeAgent: sanitized suspicious session_id: ${id.substring(0, 50)}`);
        }
        return sanitized;
    }

    private parseJsonEnvelope(stdout: string): { text: string; extractedSessionId?: string; envelopeFound: boolean } {
        try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return { text: '', envelopeFound: false };

            const envelope: ClaudeEnvelope = JSON.parse(jsonMatch[0]);
            const extractedSessionId = envelope.session_id;

            // Detect API errors — these should not become assistant messages.
            // Return empty text so the conversation runner can retry the turn.
            if (envelope.is_error || (envelope.result && API_ERROR_PATTERN.test(envelope.result))) {
                return { text: '', extractedSessionId, envelopeFound: true };
            }

            // Use the result text if available
            if (envelope.result) {
                return { text: envelope.result, extractedSessionId, envelopeFound: true };
            }

            // When result is empty (e.g. AskUserQuestion denied in --print mode),
            // reconstruct a text response from the denied tool's input rather than
            // leaking the raw JSON envelope into the conversation.
            const denials = envelope.permission_denials ?? [];
            const askDenial = denials.find(d => d.tool_name === 'AskUserQuestion');
            if (askDenial?.tool_input) {
                const text = this.reconstructFromAskUserQuestion(askDenial.tool_input as AskUserQuestionInput);
                if (text) return { text, extractedSessionId, envelopeFound: true };
            }

            // Generic fallback: extract any text-like field from denied tool inputs
            if (denials.length > 0) {
                const text = this.reconstructFromGenericDenial(denials);
                if (text) return { text, extractedSessionId, envelopeFound: true };
            }

            // Valid envelope but no usable text — return empty rather than raw JSON
            return { text: '', extractedSessionId, envelopeFound: true };
        } catch {
            // If JSON parsing fails, treat as no envelope found
            return { text: '', envelopeFound: false };
        }
    }

    /**
     * Reconstruct a text message from a denied AskUserQuestion tool call.
     * This happens when Claude tries to use the interactive AskUserQuestion
     * tool in --print mode and it gets denied, leaving result empty.
     */
    /**
     * Extract text from any denied tool by looking for common text-like fields.
     */
    private reconstructFromGenericDenial(denials: PermissionDenial[]): string {
        const textFields = ['question', 'message', 'prompt', 'text', 'content', 'description'];
        for (const denial of denials) {
            if (!denial.tool_input) continue;
            for (const field of textFields) {
                const value = denial.tool_input[field];
                if (typeof value === 'string' && value.trim()) {
                    return value.trim();
                }
            }
        }
        return '';
    }

    private reconstructFromAskUserQuestion(input: AskUserQuestionInput): string {
        const questions = input.questions;
        if (!questions?.length) return '';

        const parts: string[] = [];
        for (const q of questions) {
            if (q.header) parts.push(`**${q.header}**`);
            parts.push(q.question);
            if (q.options?.length) {
                for (const opt of q.options) {
                    const desc = opt.description ? ` — ${opt.description}` : '';
                    parts.push(`- **${opt.label}**${desc}`);
                }
            }
        }
        return parts.join('\n');
    }
}
