import * as fs from 'fs-extra';
import * as path from 'path';

export interface SkillDescriptor {
    directoryName: string;
    displayName: string;
    description: string;
    sourcePath: string;
}

export interface StagedSkillDescriptor extends SkillDescriptor {
    stagedRelativePath: string;
}

const PATHGRADE_AGENTS_START = '<!-- PATHGRADE:SKILL-BOOTSTRAP:START -->';
const PATHGRADE_AGENTS_END = '<!-- PATHGRADE:SKILL-BOOTSTRAP:END -->';

function toPosixPath(value: string): string {
    return value.split(path.sep).join('/');
}

function parseFrontmatterValue(content: string, key: string): string | undefined {
    const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) return undefined;

    const valueMatch = frontmatterMatch[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return valueMatch?.[1]?.trim().replace(/^['"]|['"]$/g, '');
}

export async function readSkillDescriptors(skillsPaths: string[]): Promise<SkillDescriptor[]> {
    const descriptors: SkillDescriptor[] = [];

    for (const sourcePath of skillsPaths) {
        const skillMdPath = path.join(sourcePath, 'SKILL.md');
        const content = await fs.readFile(skillMdPath, 'utf-8');
        descriptors.push({
            directoryName: path.basename(sourcePath),
            displayName: parseFrontmatterValue(content, 'name') || path.basename(sourcePath),
            description: parseFrontmatterValue(content, 'description') || '',
            sourcePath,
        });
    }

    return descriptors;
}

export async function stageSkills(
    workspacePath: string,
    targetRelativeDir: string,
    skills: SkillDescriptor[],
): Promise<StagedSkillDescriptor[]> {
    const stagedSkills: StagedSkillDescriptor[] = [];
    const targetRoot = path.join(workspacePath, targetRelativeDir);

    await fs.ensureDir(targetRoot);

    for (const skill of skills) {
        const targetPath = path.join(targetRoot, skill.directoryName);
        await fs.copy(skill.sourcePath, targetPath);
        stagedSkills.push({
            ...skill,
            stagedRelativePath: toPosixPath(path.join(targetRelativeDir, skill.directoryName)),
        });
    }

    return stagedSkills;
}

export function buildClaudeMd(skills: StagedSkillDescriptor[]): string | null {
    if (skills.length === 0) return null;

    const skillEntries = skills.map((skill) => {
        const details = skill.description ? `: ${skill.description}` : '';
        return `- **${skill.displayName}**${details}`;
    });

    return [
        '# Project Skills',
        '',
        'This project has the following skills available. When the user\'s request matches a skill, follow it exactly.',
        '',
        ...skillEntries,
        '',
        'Skills are located in `.claude/skills/`. Read the SKILL.md to understand the full workflow before responding.',
    ].join('\n');
}

function buildAgentsBootstrapSection(skills: StagedSkillDescriptor[]): string {
    const lines = [
        PATHGRADE_AGENTS_START,
        '## PathGrade-managed skill bootstrap',
        '',
        'PathGrade staged the following skills for this Codex trial workspace. When a request matches a skill, read the corresponding `SKILL.md` file and follow it.',
        '',
    ];

    for (const skill of skills) {
        const description = skill.description ? `: ${skill.description}` : '';
        lines.push(`- **${skill.displayName}**${description} (\`${skill.stagedRelativePath}/SKILL.md\`)`);
    }

    lines.push('', PATHGRADE_AGENTS_END);
    return lines.join('\n');
}

export function composeAgentsMd(existingContent: string | null, skills: StagedSkillDescriptor[]): string | null {
    const cleanedExisting = (existingContent || '')
        .replace(new RegExp(`${PATHGRADE_AGENTS_START}[\\s\\S]*?${PATHGRADE_AGENTS_END}\\n?`, 'g'), '')
        .trim();

    if (skills.length === 0) {
        return cleanedExisting || null;
    }

    const bootstrapSection = buildAgentsBootstrapSection(skills);
    return cleanedExisting ? `${cleanedExisting}\n\n${bootstrapSection}\n` : `${bootstrapSection}\n`;
}
