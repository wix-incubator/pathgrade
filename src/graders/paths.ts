/**
 * Shared grader path conventions. Single source of truth for the
 * .pathgrade directory structure used by prepareTempTaskDir (writer)
 * and evalRunner/conversationRunner (readers).
 */

export const GRADER_ROOT = '.pathgrade';
export const TESTS_DIR = `${GRADER_ROOT}/tests`;
export const PROMPTS_DIR = `${GRADER_ROOT}/prompts`;
export const STEP_TESTS_DIR = `${TESTS_DIR}/steps`;
export const STEP_PROMPTS_DIR = `${PROMPTS_DIR}/steps`;

export function deterministicScriptName(index: number): string {
    return index === 0 ? 'test.sh' : `test_${index}.sh`;
}

export function llmRubricName(index: number): string {
    return index === 0 ? 'quality.md' : `quality_${index}.md`;
}

export function deterministicCommand(index: number): string {
    return `bash ${TESTS_DIR}/${deterministicScriptName(index)}`;
}

export function llmRubricPath(index: number): string {
    return `${PROMPTS_DIR}/${llmRubricName(index)}`;
}

export function stepDeterministicCommand(turnNumber: number, graderIndex: number): string {
    return `bash ${STEP_TESTS_DIR}/turn_${turnNumber}_${graderIndex}.sh`;
}

export function stepLlmRubricPath(turnNumber: number, graderIndex: number): string {
    return `${STEP_PROMPTS_DIR}/turn_${turnNumber}_${graderIndex}.md`;
}
