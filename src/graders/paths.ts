/**
 * Shared grader path conventions. Single source of truth for the
 * .pathgrade directory structure used by prepareTempTaskDir (writer)
 * and evalRunner/conversationRunner (readers).
 */

export const GRADER_ROOT = '.pathgrade';
export const PROMPTS_DIR = `${GRADER_ROOT}/prompts`;
export const STEP_PROMPTS_DIR = `${PROMPTS_DIR}/steps`;

export function llmRubricName(index: number): string {
    return index === 0 ? 'quality.md' : `quality_${index}.md`;
}

export function llmRubricPath(index: number): string {
    return `${PROMPTS_DIR}/${llmRubricName(index)}`;
}

export function stepLlmRubricPath(turnNumber: number, graderIndex: number): string {
    return `${STEP_PROMPTS_DIR}/turn_${turnNumber}_${graderIndex}.md`;
}
