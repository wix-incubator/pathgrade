/**
 * `pathgrade analyze` command.
 *
 * Reads SKILL.md files in a directory and outputs structured JSON analysis to stdout.
 * No LLM calls — purely deterministic parsing.
 */
import fs from 'fs-extra';
import * as path from 'path';
import { detectSkills, DetectedSkill } from '../core/skills.js';

export interface AnalyzeOptions {
    skill?: string;
    dir?: string;
}

export interface SkillAnalysis {
    skillName: string;
    description: string;
    procedures: string[];
    expectedOutputs: string[];
    suggestedScorers: Array<{ type: 'check' | 'judge'; name: string; hint: string }>;
    workspaceHint: string;
    hasFixtures: boolean;
}

/**
 * Run the analyze command. Returns exit code (0 = success, 1 = error).
 */
export async function runAnalyze(
    dir: string,
    opts: AnalyzeOptions = {},
): Promise<number> {
    const targetDir = opts.dir || dir;
    const skills = await detectSkills(targetDir);

    if (skills.length === 0) {
        process.stdout.write(JSON.stringify({
            error: 'no-skill-found',
            message: 'No SKILL.md found. Create one or use --dir to point to a skill directory.',
        }));
        return 1;
    }

    if (opts.skill) {
        const match = skills.find(s => s.name === opts.skill);
        if (!match) {
            process.stdout.write(JSON.stringify({
                error: 'skill-not-found',
                message: `Skill '${opts.skill}' not found. Available: ${skills.map(s => s.name).join(', ')}`,
            }));
            return 1;
        }
        const analysis = analyzeSkill(match, targetDir);
        process.stdout.write(JSON.stringify(analysis));
        return 0;
    }

    if (skills.length === 1) {
        const analysis = analyzeSkill(skills[0], targetDir);
        process.stdout.write(JSON.stringify(analysis));
    } else {
        const analyses = skills.map(s => analyzeSkill(s, targetDir));
        process.stdout.write(JSON.stringify(analyses));
    }
    return 0;
}

function analyzeSkill(skill: DetectedSkill, dir: string): SkillAnalysis {
    const { name, description } = parseFrontmatter(skill.skillMd);
    const procedures = extractProcedures(skill.skillMd);
    const expectedOutputs = extractExpectedOutputs(procedures);
    const suggestedScorers = buildSuggestedScorers(expectedOutputs);
    const workspaceHint = extractWorkspaceHint(procedures);
    const hasFixtures =
        fs.pathExistsSync(path.join(skill.path, 'fixtures')) ||
        fs.pathExistsSync(path.join(skill.path, 'test', 'fixtures'));

    return {
        skillName: name || skill.name,
        description: description || extractFirstParagraph(skill.skillMd),
        procedures,
        expectedOutputs,
        suggestedScorers,
        workspaceHint,
        hasFixtures,
    };
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return {};

    const fm = fmMatch[1];
    const nameMatch = fm.match(/^name:\s*(.+)$/m);
    const descMatch = fm.match(/^description:\s*(.+)$/m);

    return {
        name: nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : undefined,
        description: descMatch ? descMatch[1].trim().replace(/^['"]|['"]$/g, '') : undefined,
    };
}

function extractFirstParagraph(content: string): string {
    // Strip frontmatter
    const stripped = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '');
    const lines = stripped.split('\n');
    let foundHeading = false;
    const paragraphLines: string[] = [];

    for (const line of lines) {
        if (line.startsWith('# ') && !foundHeading) {
            foundHeading = true;
            continue;
        }
        if (foundHeading) {
            if (line.trim() === '' && paragraphLines.length > 0) break;
            if (line.startsWith('#')) break;
            if (line.trim()) paragraphLines.push(line.trim());
        }
    }

    return paragraphLines.join(' ');
}

function extractProcedures(content: string): string[] {
    const lines = content.split('\n');
    const procedures: string[] = [];
    let inProcedureSection = false;

    for (const line of lines) {
        // Check for headings containing procedure/step/how to
        if (/^#{1,3}\s+/i.test(line)) {
            const headingText = line.replace(/^#{1,3}\s+/, '').toLowerCase();
            inProcedureSection = /procedure|step|how to/i.test(headingText);
            continue;
        }

        if (inProcedureSection) {
            // Numbered list: "1. Do something" or "- Do something"
            const listMatch = line.match(/^\s*(?:\d+\.|[-*])\s+(.+)/);
            if (listMatch) {
                procedures.push(listMatch[1].trim());
            }
            // Empty line after list items ends the section only if we have procedures
            if (line.trim() === '' && procedures.length > 0) {
                // Continue — might be spacing between items
            }
        }
    }

    return procedures;
}

const CREATION_VERBS = /\b(?:create|write|generate|save|produce|output)\b/i;
const FILENAME_PATTERN = /`([^`]+\.[a-zA-Z]{1,5})`|"([^"]+\.[a-zA-Z]{1,5})"|'([^']+\.[a-zA-Z]{1,5})'/g;

function extractExpectedOutputs(procedures: string[]): string[] {
    const outputs: string[] = [];

    for (const proc of procedures) {
        if (!CREATION_VERBS.test(proc)) continue;

        let match: RegExpExecArray | null;
        FILENAME_PATTERN.lastIndex = 0;
        while ((match = FILENAME_PATTERN.exec(proc)) !== null) {
            const filename = match[1] || match[2] || match[3];
            if (filename && !outputs.includes(filename)) {
                outputs.push(filename);
            }
        }
    }

    return outputs;
}

function buildSuggestedScorers(
    expectedOutputs: string[],
): Array<{ type: 'check' | 'judge'; name: string; hint: string }> {
    const scorers: Array<{ type: 'check' | 'judge'; name: string; hint: string }> = [];

    for (const output of expectedOutputs) {
        const baseName = output.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]+/g, '-');
        scorers.push({
            type: 'check',
            name: `${baseName}-exists`,
            hint: `Check ${output} exists in workspace`,
        });
    }

    // Always add a judge scorer
    scorers.push({
        type: 'judge',
        name: 'quality',
        hint: 'Evaluate overall quality of the agent\'s work',
    });

    return scorers;
}

function extractWorkspaceHint(procedures: string[]): string {
    const text = procedures.join(' ').toLowerCase();
    const keywords = ['workspace', 'project', 'directory', 'fixture', 'file'];
    const found = keywords.filter(k => text.includes(k));

    if (found.length > 0) {
        return `Skill operates on ${found.join(', ')} resources in the workspace`;
    }
    return '';
}
