import { Grader } from './index';
import { GraderConfig, GraderResult, EnvironmentHandle, EnvironmentProvider, LogEntry } from '../types';
import { ToolUsageExpectation } from '../core/config.types';
import { ToolEvent } from '../tool-events';

function matchesExpectation(event: ToolEvent, expectation: ToolUsageExpectation): boolean {
    if (event.action !== expectation.action) return false;
    if (expectation.provider && event.provider !== expectation.provider) return false;
    if (expectation.tool_name && event.providerToolName !== expectation.tool_name) return false;
    if (expectation.path && event.arguments?.path !== expectation.path) return false;
    if (expectation.command_contains) {
        const cmd = String(event.arguments?.cmd || event.arguments?.command || '');
        if (!cmd.includes(expectation.command_contains)) return false;
    }
    return true;
}

export class ToolUsageGrader implements Grader {
    async grade(
        _workspace: EnvironmentHandle,
        _provider: EnvironmentProvider,
        config: GraderConfig,
        _taskPath: string,
        sessionLog: LogEntry[],
    ): Promise<GraderResult> {
        const toolEvents = sessionLog
            .filter((entry) => entry.type === 'tool_event' && entry.tool_event)
            .map((entry) => entry.tool_event!);

        // Explicit empty-events guard: fail, don't silently pass
        if (toolEvents.length === 0) {
            return {
                grader_type: 'tool_usage',
                score: 0,
                weight: config.weight,
                details: 'No tool events captured — extraction may have failed or agent used no tools',
            };
        }

        const checks = (config.expectations || []).map((expectation: ToolUsageExpectation) => {
            const matches = toolEvents.filter((event) => matchesExpectation(event, expectation));
            const passed = matches.length >= (expectation.min ?? 1)
                && (expectation.max === undefined || matches.length <= expectation.max);
            return {
                name: `${expectation.action}`,
                passed,
                message: `${matches.length} matching events`,
                weight: expectation.weight ?? 1,
            };
        });

        const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
        const earnedWeight = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0);
        const score = totalWeight === 0 ? 0 : earnedWeight / totalWeight;

        return {
            grader_type: 'tool_usage',
            score,
            weight: config.weight,
            details: `${earnedWeight}/${totalWeight} expectation weight passed`,
        };
    }
}
