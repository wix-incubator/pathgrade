import { GraderConfig, GraderResult, EnvironmentProvider, EnvironmentHandle } from '../types';
import * as fs from 'fs-extra';
import * as path from 'path';
import { callLLM } from '../utils/llm';

export interface Grader {
    grade(
        workspace: EnvironmentHandle,
        provider: EnvironmentProvider,
        config: GraderConfig,
        taskPath: string,
        sessionLog: any[],
        env?: Record<string, string>
    ): Promise<GraderResult>;
}

/**
 * Runs a command and parses structured JSON from stdout.
 *
 * The grader script MUST output JSON to stdout:
 *   { "score": 0.0-1.0, "details": "...", "checks": [...] }
 *
 * - score: float between 0.0 and 1.0
 * - details: human-readable summary
 * - checks: optional array of { name, passed, message } for per-check breakdown
 */
export class DeterministicGrader implements Grader {
    async grade(
        workspace: EnvironmentHandle,
        provider: EnvironmentProvider,
        config: GraderConfig,
        _taskPath: string,
        _sessionLog: any[],
        env?: Record<string, string>
    ): Promise<GraderResult> {
        const command = config.command || 'bash .pathgrade/tests/test.sh';
        const result = await provider.runCommand(workspace, command, env);

        // Parse JSON from stdout
        const jsonMatch = result.stdout.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            return {
                grader_type: 'deterministic',
                score: 0,
                weight: config.weight,
                details: `Grader did not output JSON. stdout: ${result.stdout.trim() || '(empty)'} stderr: ${result.stderr.trim() || '(empty)'}`
            };
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const score = Math.max(0, Math.min(1, parseFloat(parsed.score) || 0));
            const details = parsed.details || `score=${score.toFixed(2)}`;
            const checks = parsed.checks || [];

            // Build rich details string with per-check breakdown
            const checkLines = checks.map((c: any) =>
                `  ${c.passed ? '✓' : '✗'} ${c.name}: ${c.message || ''}`
            );
            const fullDetails = checkLines.length > 0
                ? `${details}\n${checkLines.join('\n')}`
                : details;

            return {
                grader_type: 'deterministic',
                score,
                weight: config.weight,
                details: fullDetails
            };
        } catch (e) {
            return {
                grader_type: 'deterministic',
                score: 0,
                weight: config.weight,
                details: `Failed to parse grader JSON: ${jsonMatch[0].substring(0, 200)}`
            };
        }
    }
}

/**
 * Uses an LLM to evaluate the agent's session transcript against a rubric.
 * Requires a supported API key in the environment.
 */
export class LLMGrader implements Grader {
    async grade(
        _workspace: EnvironmentHandle,
        _provider: EnvironmentProvider,
        config: GraderConfig,
        taskPath: string,
        sessionLog: any[],
        env?: Record<string, string>
    ): Promise<GraderResult> {
        const rubricPath = path.join(taskPath, config.rubric || '.pathgrade/prompts/quality.md');
        if (!await fs.pathExists(rubricPath)) {
            return {
                grader_type: 'llm_rubric',
                score: 0,
                weight: config.weight,
                details: `Rubric file not found: ${rubricPath}`
            };
        }

        const rubric = await fs.readFile(rubricPath, 'utf-8');

        // Build a comprehensive transcript for the LLM
        const sections: string[] = [];

        // Include the original instruction
        const instructionEntry = sessionLog.find(e => e.type === 'agent_start');
        if (instructionEntry?.instruction) {
            sections.push(`## Task Instruction\n${instructionEntry.instruction}`);
        }

        // Include all commands and their output
        const commandEntries = sessionLog.filter(e => e.type === 'command');
        if (commandEntries.length > 0) {
            const cmds = commandEntries.map(e =>
                `$ ${e.command}\n${e.stdout || ''}${e.stderr ? '\nSTDERR: ' + e.stderr : ''}\n[exit code: ${e.exitCode ?? 'unknown'}]`
            ).join('\n\n');
            sections.push(`## Commands Executed\n${cmds}`);
        }

        const hasConversationReplies = sessionLog.some(e => e.type === 'user_reply');
        if (hasConversationReplies) {
            // Build per-turn structured transcript with commands grouped by turn
            const turnNumbers = [...new Set(
                sessionLog
                    .filter(e => e.turn_number !== undefined)
                    .map(e => e.turn_number!)
            )].sort((a, b) => a - b);

            const turnSections: string[] = [];
            for (const turnNum of turnNumbers) {
                const turnEntries = sessionLog.filter(e => e.turn_number === turnNum);
                const userReply = turnEntries.find(e => e.type === 'user_reply');
                const agentResult = turnEntries.find(e => e.type === 'agent_result');
                const turnCommands = turnEntries.filter(e => e.type === 'command');

                const source = userReply?.reply_source
                    ? ` (${userReply.reply_source})`
                    : turnNum === 1 ? ' (opener)' : '';

                const lines: string[] = [`### Turn ${turnNum}${source}`];
                if (userReply) {
                    lines.push(`**User:** ${userReply.output || ''}`);
                }
                if (agentResult) {
                    lines.push(`**Agent:** ${agentResult.assistant_message || agentResult.output || ''}`);
                }
                if (turnCommands.length > 0) {
                    const cmds = turnCommands.map(e =>
                        `${e.command}${e.stdout ? ' → ' + e.stdout.trim().substring(0, 200) : ''}`
                    ).join(', ');
                    lines.push(`Commands: ${cmds}`);
                }
                turnSections.push(lines.join('\n'));
            }
            sections.push(`## Conversation Transcript\n\n${turnSections.join('\n\n')}`);
        } else {
            const agentEntries = sessionLog.filter(e => e.type === 'agent_result');
            if (agentEntries.length > 0) {
                const outputs = agentEntries
                    .map(e => e.assistant_message || e.output || '')
                    .filter(Boolean)
                    .join('\n\n');
                sections.push(`## Agent Output\n${outputs}`);
            }
        }

        // Include results from any prior graders (e.g., deterministic tests)
        const priorGraders = sessionLog
            .filter(e => e.type === 'grader' && e.grader_result)
            .map(e => e.grader_result!);
        if (priorGraders.length > 0) {
            const results = priorGraders.map(g =>
                `- ${g.grader_type}: score=${g.score.toFixed(2)} — ${g.details}`
            ).join('\n');
            sections.push(`## Prior Grader Results (automated tests)\n${results}`);
        }

        const transcript = sections.join('\n\n');

        const prompt = `You are an evaluation judge. Score the following agent session on a scale from 0.0 to 1.0 based on the rubric below.

IMPORTANT CONTEXT: The agent runs inside a CLI wrapper (e.g., Gemini CLI). The agent's tool calls (file edits, shell commands) appear as text in the "Agent Output" section. This is a real execution trace, not hallucination — the "Commands Executed" section shows the CLI invocation and its captured output. The "Prior Grader Results" section shows objective automated test results that verify the actual filesystem state after the agent ran.

## Rubric
${rubric}

## Session Transcript
${transcript}

Respond with ONLY a JSON object: {"score": <number>, "reasoning": "<brief explanation>"}`;

        try {
            const rubricSchema = JSON.stringify({
                type: 'object',
                properties: {
                    score: { type: 'number' },
                    reasoning: { type: 'string' },
                },
                required: ['score', 'reasoning'],
                additionalProperties: false,
            });
            const response = await callLLM(prompt, {
                model: config.model,
                env,
                jsonSchema: rubricSchema,
            });
            return this.parseResponse(response.text, config);
        } catch (error: any) {
            return {
                grader_type: 'llm_rubric',
                score: 0,
                weight: config.weight,
                details: error?.message || String(error),
            };
        }
    }

    private parseResponse(text: string, config: GraderConfig): GraderResult {
        try {
            // Strip markdown code fences if present
            let cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```/g, '').trim();

            // Extract JSON from response
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                const score = Math.max(0, Math.min(1, parseFloat(parsed.score) || 0));
                return {
                    grader_type: 'llm_rubric',
                    score,
                    weight: config.weight,
                    details: parsed.reasoning || 'No reasoning provided'
                };
            }
        } catch (e) {
            // JSON parse failed — try to extract score from truncated response
            const scoreMatch = text.match(/"score"\s*:\s*([\d.]+)/);
            if (scoreMatch) {
                const score = Math.max(0, Math.min(1, parseFloat(scoreMatch[1]) || 0));
                return {
                    grader_type: 'llm_rubric',
                    score,
                    weight: config.weight,
                    details: 'Parsed score from truncated LLM response'
                };
            }
        }
        return { grader_type: 'llm_rubric', score: 0, weight: config.weight, details: `Failed to parse LLM response: ${text.substring(0, 200)}` };
    }
}

/** Resolve a grader implementation by type */
export function getGrader(type: string): Grader {
    switch (type) {
        case 'deterministic': return new DeterministicGrader();
        case 'llm_rubric': return new LLMGrader();
        default: throw new Error(`Unknown grader type: ${type}`);
    }
}
