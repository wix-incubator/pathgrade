import { deterministicGrader } from '../../../src/core/grader-factories';
import * as fs from 'fs';
import * as path from 'path';

export const checkOutput = deterministicGrader({
    weight: 1.0,
    execute: async ({ workspacePath }) => {
        const filePath = path.join(workspacePath, 'output.txt');
        if (!fs.existsSync(filePath)) {
            return { score: 0, details: 'output.txt missing or wrong content' };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        if (content.includes('hello world')) {
            return { score: 1, details: 'output.txt contains hello world' };
        }
        return { score: 0, details: 'output.txt missing or wrong content' };
    },
});
