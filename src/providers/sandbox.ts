import fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { DEFAULT_COPY_IGNORE, createCopyFilter } from './copy-filter.js';


export interface SandboxConfig {
    agent: import('../sdk/types.js').AgentName;
    workspace?: string;
    skillDir?: string;
    copyFromHome?: string[];
    env?: Record<string, string>;
    mcp?: import('./mcp-config.js').McpSpec;
    /**
     * Glob patterns to ignore when copying workspace and skill directories.
     * Replaces the default ignore list entirely. Pass `[]` to disable filtering.
     * When omitted, DEFAULT_COPY_IGNORE is used.
     */
    copyIgnore?: string[];
}

export interface Sandbox {
    rootDir: string;
    workspacePath: string;
    homePath: string;
    env: Record<string, string>;
}

export const SAFE_HOST_VARS = [
    'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'USER', 'LOGNAME',
];

export async function createSandbox(spec: SandboxConfig): Promise<Sandbox> {
    const rootDir = path.join(os.tmpdir(), `pathgrade-${Math.random().toString(36).substring(7)}`);
    const workspacePath = path.join(rootDir, 'workspace');
    const homePath = path.join(rootDir, 'home');
    const tmpPath = path.join(rootDir, 'tmp');

    await fs.ensureDir(workspacePath);
    await fs.ensureDir(homePath);
    await fs.ensureDir(tmpPath);

    // Build copy filter for workspace and skill directories
    const ignorePatterns = spec.copyIgnore !== undefined ? spec.copyIgnore : DEFAULT_COPY_IGNORE;
    const copyFilter = createCopyFilter(ignorePatterns);

    // Copy fixture directory contents into workspace
    if (spec.workspace) {
        const fixturePath = path.resolve(spec.workspace);
        if (await fs.pathExists(fixturePath)) {
            await fs.copy(fixturePath, workspacePath, { filter: copyFilter });
        }
    }

    // Stage skill to both discovery paths so either convention resolves
    if (spec.skillDir) {
        const skillPath = path.resolve(spec.skillDir);
        const skillName = path.basename(skillPath);
        const skillFilter = (src: string) => {
            const rel = path.relative(skillPath, src);
            if (rel === 'test' || rel.startsWith(`test${path.sep}`)) {
                return false;
            }
            return copyFilter(src);
        };

        const claudeDir = path.join(workspacePath, '.claude', 'skills', skillName);
        const agentsDir = path.join(workspacePath, '.agents', 'skills', skillName);

        const primaryDir = spec.agent === 'claude' ? claudeDir : agentsDir;
        const secondaryDir = spec.agent === 'claude' ? agentsDir : claudeDir;

        await fs.copy(skillPath, primaryDir, { filter: skillFilter });
        await fs.copy(skillPath, secondaryDir, { filter: skillFilter });

        // Verified against cursor-agent 2026.04.17-787b533: the rule loader
        // reads SKILL.md body from the .mdc file directly; a plain pointer
        // ("see .agents/skills/<name>/SKILL.md") is not honored, so inline
        // the content. Emitted unconditionally across all agents — harness-
        // idempotent, same posture as the .claude/.agents dual-stage above.
        await stageCursorRule(workspacePath, skillName, skillPath);
    }

    // Copy specified paths from real host HOME into sandbox HOME
    if (spec.copyFromHome) {
        const realHome = os.homedir();
        for (const relPath of spec.copyFromHome) {
            const srcPath = path.join(realHome, relPath);
            if (await fs.pathExists(srcPath)) {
                const destPath = path.join(homePath, relPath);
                await fs.ensureDir(path.dirname(destPath));
                await fs.copy(srcPath, destPath);
            }
        }
    }

    // Create HOME → workspace symlinks for skill directories that exist
    const skillSymlinks = [
        ['.agents', 'skills'],
        ['.claude', 'skills'],
    ];
    for (const segments of skillSymlinks) {
        const wsSkillDir = path.join(workspacePath, ...segments);
        if (await fs.pathExists(wsSkillDir)) {
            const homeSkillDir = path.join(homePath, ...segments);
            await fs.ensureDir(path.dirname(homeSkillDir));
            await fs.symlink(wsSkillDir, homeSkillDir);
        }
    }

    // Build env: safe host vars, then sandbox defaults, then explicit overrides.
    // API keys are NOT forwarded here — resolveCredentials() handles credentials
    // per-agent so Claude CLI can use native OAuth when no key is needed.
    const env: Record<string, string> = {};
    for (const key of SAFE_HOST_VARS) {
        if (process.env[key]) env[key] = process.env[key]!;
    }
    env.HOME = homePath;
    env.TMPDIR = tmpPath;
    env.TMP = tmpPath;
    env.TEMP = tmpPath;

    // Explicit overrides take precedence
    if (spec.env) {
        Object.assign(env, spec.env);
    }

    return {
        rootDir,
        workspacePath,
        homePath,
        env,
    };
}

const FRONTMATTER_DELIM = /^---\s*$/;

async function stageCursorRule(workspacePath: string, skillName: string, skillPath: string): Promise<void> {
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!(await fs.pathExists(skillMdPath))) return;

    const raw = await fs.readFile(skillMdPath, 'utf8');
    const parsed = splitFrontmatter(raw);
    const description = parsed.frontmatter.description ?? deriveFallbackDescription(parsed.body, skillName);

    const mdc = [
        '---',
        `description: ${escapeYamlScalar(description)}`,
        'alwaysApply: true',
        '---',
        '',
        parsed.body.trimStart(),
    ].join('\n');

    const rulesDir = path.join(workspacePath, '.cursor', 'rules');
    await fs.ensureDir(rulesDir);
    await fs.writeFile(path.join(rulesDir, `${skillName}.mdc`), mdc, 'utf8');
}

function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
    const lines = raw.split('\n');
    if (lines.length === 0 || !FRONTMATTER_DELIM.test(lines[0])) {
        return { frontmatter: {}, body: raw };
    }
    const endIdx = lines.slice(1).findIndex((line) => FRONTMATTER_DELIM.test(line));
    if (endIdx === -1) {
        return { frontmatter: {}, body: raw };
    }
    const frontmatterLines = lines.slice(1, endIdx + 1);
    const bodyLines = lines.slice(endIdx + 2);
    const frontmatter: Record<string, string> = {};
    for (const line of frontmatterLines) {
        const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
        if (match) {
            frontmatter[match[1]] = match[2].replace(/^['"]|['"]$/g, '').trim();
        }
    }
    return { frontmatter, body: bodyLines.join('\n') };
}

function deriveFallbackDescription(body: string, skillName: string): string {
    for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('#')) {
            const headingText = trimmed.replace(/^#+\s*/, '').trim();
            if (headingText) return headingText;
        }
        return trimmed;
    }
    return `Skill ${skillName}`;
}

function escapeYamlScalar(value: string): string {
    const single = value.replace(/[\r\n]+/g, ' ').trim();
    if (/[:#&*!|>'"%@`]/.test(single) || single !== value) {
        return `"${single.replace(/"/g, '\\"')}"`;
    }
    return single;
}
