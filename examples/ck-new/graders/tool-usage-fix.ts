import { toolUsageGrader } from '../../../src/core/grader-factories';

export const toolUsageFix = toolUsageGrader({
    weight: 0.4,
    expectations: [
        { action: 'read_file', argument_pattern: 'app\\.js', min: 1, weight: 0.5 },
        { action: 'edit_file', min: 1, weight: 0.5 },
    ],
});
