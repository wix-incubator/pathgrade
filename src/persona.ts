import { ConversationPersonaConfig } from './core/config.types';
import { ConversationTurn } from './types';
import { callLLM } from './utils/llm';

export interface PersonaReplyResult {
    content: string;
    inputTokens?: number;
    outputTokens?: number;
}

function buildTranscript(turns: ConversationTurn[]): string {
    if (turns.length === 0) {
        return '(conversation just started)';
    }

    const lines: string[] = [];
    turns.forEach((turn, index) => {
        lines.push(`User: ${turn.user_message}`);
        if (index < turns.length - 1 && turn.assistant_message) {
            lines.push(`Assistant: ${turn.assistant_message}`);
        }
    });
    return lines.join('\n');
}

export function buildPersonaPrompt(
    persona: ConversationPersonaConfig,
    transcript: ConversationTurn[],
    assistantMessage: string
): string {
    const facts = persona.facts.map((fact) => `- ${fact}`).join('\n');

    return `You are simulating a user in a conversation with an AI assistant.

## Who You Are
${persona.description}

## What You Know
You have these facts available. Reveal them naturally when asked - don't
dump everything at once. If asked about something not in your facts,
say you don't know or haven't decided yet.

${facts}

## Conversation So Far
${buildTranscript(transcript)}

## Agent's Latest Message
${assistantMessage}

## Instructions
Respond as the user would. Be concise and natural. If the agent asks a
multiple-choice question, pick the most appropriate option based on your
facts. If the agent asks for confirmation, confirm if the content matches
your facts. Do not break character. Do not explain that you are simulating.
Respond with plain text only. Do not invoke any tools or functions.

Your response:`;
}

export async function generatePersonaReply(
    persona: ConversationPersonaConfig,
    transcript: ConversationTurn[],
    assistantMessage: string,
    env?: Record<string, string>,
    model?: string
): Promise<PersonaReplyResult> {
    const prompt = buildPersonaPrompt(persona, transcript, assistantMessage);
    const response = await callLLM(prompt, {
        model: model || persona.model,
        env,
    });

    return {
        content: response.text.trim(),
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
    };
}
