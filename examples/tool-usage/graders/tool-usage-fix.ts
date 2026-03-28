import { toolUsageGrader } from '../../../src/core/grader-factories';

export const toolUsageFix = toolUsageGrader({
    weight: 0.4,
    expectations: [
        { action: 'read_file', min: 1, weight: 0.3 },
        { action: 'edit_file', min: 1, weight: 0.3 },
        { action: 'run_shell', command_contains: 'test', min: 1, weight: 0.4 },
    ],
});
