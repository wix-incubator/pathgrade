/**
 * `pathgrade validate` command.
 *
 * Validates a .eval.ts file for structural correctness without running it.
 * Uses regex/string pattern matching — no AST parsing, no LLM calls.
 *
 * `runValidateAffected` (Issue 13) is a strict mode: instead of validating
 * one positional file, it iterates every discovered eval and reports
 * onMissing (no SKILL.md + no meta) and malformed-meta as hard errors,
 * for teams that want CI-level declaration enforcement.
 */
import { createRequire } from 'node:module';
import * as path from 'path';
import fs from 'fs-extra';
import { findSkillRoot } from '../affected/anchor.js';
import { parsePathgradeMeta } from '../affected/meta.js';
import { discoverEvalFiles } from './affected.js';

export interface ValidateOptions {
    /** Skip tsc subprocess check (useful in tests without full TS project setup). */
    skipTsc?: boolean;
}

interface CheckResult {
    check: string;
    message: string;
}

interface ValidateOutput {
    valid: boolean;
    errors: CheckResult[];
    warnings: CheckResult[];
}

/**
 * Run the validate command. Returns exit code (0 = valid, 1 = errors).
 */
export async function runValidate(
    filePath: string,
    opts: ValidateOptions = {},
): Promise<number> {
    const errors: CheckResult[] = [];
    const warnings: CheckResult[] = [];

    // Check 1: File exists
    if (!await fs.pathExists(filePath)) {
        errors.push({ check: 'file-exists', message: `File not found: ${filePath}` });
        return writeResult({ valid: false, errors, warnings });
    }

    // Check 1b: File extension
    if (!filePath.endsWith('.eval.ts')) {
        errors.push({ check: 'file-extension', message: `File must have .eval.ts extension, got: ${filePath}` });
        return writeResult({ valid: false, errors, warnings });
    }

    const content = await fs.readFile(filePath, 'utf-8');

    // Check 2: TypeScript syntax (optional, skip in tests)
    if (!opts.skipTsc) {
        const tscResult = await runTsc(filePath);
        if (!tscResult.ok) {
            errors.push({ check: 'typescript-compiles', message: tscResult.message });
        }
    }

    // Check 3: Imports
    if (!content.includes("from 'pathgrade'") && !content.includes('from "pathgrade"')) {
        errors.push({ check: 'imports-pathgrade', message: "No import from 'pathgrade' found." });
    }

    // Check 4: describe/it blocks
    if (!/describe\s*\(/.test(content) || !/it\s*\(/.test(content)) {
        errors.push({ check: 'has-describe-it', message: 'No describe() or it() blocks found. Eval must use Vitest structure.' });
    }

    // Check 5: createAgent
    if (!/createAgent\s*\(/.test(content)) {
        errors.push({ check: 'has-create-agent', message: 'No createAgent() call found.' });
    }

    // Check 6: evaluate
    if (!/evaluate\s*\(/.test(content)) {
        errors.push({ check: 'has-evaluate', message: 'No evaluate() call found.' });
    }

    // Check 7: Deterministic scorer
    if (!/\bcheck\s*\(/.test(content) && !/\bscore\s*\(/.test(content)) {
        errors.push({ check: 'has-deterministic-scorer', message: 'No check() or score() scorer found. Add at least one deterministic scorer.' });
    }

    // Check 8: Scorer names non-empty
    const scorerCallPattern = /\b(?:check|score|judge|toolUsage)\s*\(\s*(['"])(.*?)\1/g;
    let scorerMatch: RegExpExecArray | null;
    while ((scorerMatch = scorerCallPattern.exec(content)) !== null) {
        if (scorerMatch[2].trim() === '') {
            errors.push({ check: 'scorer-names-non-empty', message: `Scorer has empty name at position ${scorerMatch.index}.` });
            break; // One error is enough
        }
    }

    // Check 9: Instruction non-empty (>10 chars)
    const instructionPattern = /(?:prompt|startChat)\s*\(\s*(['"`])([\s\S]*?)\1/g;
    let instrMatch: RegExpExecArray | null;
    let foundInstruction = false;
    while ((instrMatch = instructionPattern.exec(content)) !== null) {
        foundInstruction = true;
        if (instrMatch[2].trim().length <= 10) {
            errors.push({ check: 'instruction-non-empty', message: `Instruction is too short (${instrMatch[2].trim().length} chars). Write a meaningful instruction (>10 chars).` });
            break;
        }
    }
    // Also check template literal instructions
    if (!foundInstruction) {
        const templateInstrPattern = /(?:prompt|startChat)\s*\(\s*`([\s\S]*?)`/g;
        let tmplMatch: RegExpExecArray | null;
        while ((tmplMatch = templateInstrPattern.exec(content)) !== null) {
            foundInstruction = true;
            if (tmplMatch[1].trim().length <= 10) {
                errors.push({ check: 'instruction-non-empty', message: `Instruction is too short (${tmplMatch[1].trim().length} chars). Write a meaningful instruction (>10 chars).` });
                break;
            }
        }
    }

    // Check 10: Filename consistency
    const filenameWarnings = checkFilenameConsistency(content);
    warnings.push(...filenameWarnings);

    const valid = errors.length === 0;
    return writeResult({ valid, errors, warnings });
}

function checkFilenameConsistency(content: string): CheckResult[] {
    const warnings: CheckResult[] = [];

    // Extract all instruction text from prompt()/startChat() calls
    const instrTexts: string[] = [];
    // Match single/double quoted strings
    const instrQuoted = /(?:prompt|startChat)\s*\(\s*(['"])([\s\S]*?)\1/g;
    let m: RegExpExecArray | null;
    while ((m = instrQuoted.exec(content)) !== null) {
        instrTexts.push(m[2]);
    }
    // Match template literals
    const instrTemplate = /(?:prompt|startChat)\s*\(\s*`([\s\S]*?)`/g;
    while ((m = instrTemplate.exec(content)) !== null) {
        instrTexts.push(m[1]);
    }
    const instructionText = instrTexts.join(' ');
    if (!instructionText) return warnings;

    // Find all check() call regions by matching check( ... the callback body
    // Strategy: find each check( occurrence, then scan forward for filenames
    const checkCallPattern = /\bcheck\s*\(/g;
    while ((m = checkCallPattern.exec(content)) !== null) {
        // Extract a reasonable window after the check( — up to 500 chars covers most callbacks
        const window = content.substring(m.index, m.index + 500);
        const filenamePattern = /['"`](?:.*\/)?([a-zA-Z0-9_.-]+\.[a-zA-Z]{1,5})['"`]/g;
        let fm: RegExpExecArray | null;
        while ((fm = filenamePattern.exec(window)) !== null) {
            const filename = fm[1];
            // Skip the scorer name (first string after check(), and common non-file patterns
            if (fm.index < 10) continue; // likely the scorer name
            if (filename.startsWith('0.')) continue;
            if (!instructionText.includes(filename)) {
                warnings.push({
                    check: 'filename-consistency',
                    message: `Scorer checks for '${filename}' but the instruction does not mention this filename.`,
                });
            }
        }
    }

    return warnings;
}

function writeResult(result: ValidateOutput): number {
    process.stdout.write(JSON.stringify(result));
    return result.valid ? 0 : 1;
}

/**
 * Strict affected-selection validator. Exits 1 if any eval is missing
 * both a SKILL.md ancestor and `__pathgradeMeta`, or has malformed meta.
 */
export async function runValidateAffected(cwd: string): Promise<number> {
    const evalFiles = discoverEvalFiles(cwd);
    let errors = 0;

    for (const evalFile of evalFiles) {
        const abs = path.resolve(cwd, evalFile);
        const skillRoot = findSkillRoot(abs, cwd);

        let parseError: string | null = null;
        let hasMeta = false;
        try {
            const meta = parsePathgradeMeta(abs);
            hasMeta = meta !== null;
        } catch (err) {
            parseError = err instanceof Error ? err.message : String(err);
        }

        if (parseError) {
            errors++;
            process.stdout.write(`${evalFile} — ❌ malformed __pathgradeMeta: ${parseError}\n`);
            continue;
        }

        if (skillRoot) {
            process.stdout.write(`${evalFile} — ✅ anchored at ${skillRoot}\n`);
            continue;
        }

        if (hasMeta) {
            process.stdout.write(`${evalFile} — ✅ __pathgradeMeta present (no SKILL.md anchor)\n`);
            continue;
        }

        errors++;
        process.stdout.write(
            `${evalFile} — ❌ no SKILL.md ancestor and no __pathgradeMeta\n`,
        );
    }

    process.stdout.write(`\n${evalFiles.length} evals, ${errors} errors\n`);
    return errors === 0 ? 0 : 1;
}

async function runTsc(filePath: string): Promise<{ ok: boolean; message: string }> {
    const { execSync } = await import('child_process');
    const path = await import('path');
    const { writeFileSync, unlinkSync } = await import('fs');
    const os = await import('os');

    // Resolve pathgrade's own tsc binary — avoids npx indirection and the
    // "This is not the tsc command you are looking for" error when the
    // consumer hasn't installed typescript themselves. `createRequire` is
    // needed because this module is emitted as ESM ("type": "module") and
    // `require` is not a free binding there — issue #39.
    const localRequire = createRequire(import.meta.url);
    const tscPath = localRequire.resolve('typescript/bin/tsc');

    // Resolve pathgrade's own @types so Node builtins (fs, path, __dirname)
    // compile without the consumer needing to install @types/node.
    const pathgradeTypesDir = path.dirname(localRequire.resolve('@types/node/package.json'));
    const pathgradeTypeRoots = path.dirname(pathgradeTypesDir);
    const consumerTypeRoots = path.join(process.cwd(), 'node_modules', '@types');

    // Generate a temp tsconfig instead of passing files on the CLI.
    // This avoids TS5112 ("tsconfig.json is present but will not be loaded
    // if files are specified on commandline") in TypeScript 5.6+.
    const tmpConfig = path.join(os.tmpdir(), `pathgrade-tsc-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const tsconfig = {
        compilerOptions: {
            noEmit: true,
            esModuleInterop: true,
            module: 'nodenext',
            moduleResolution: 'nodenext',
            typeRoots: [pathgradeTypeRoots, consumerTypeRoots],
            skipLibCheck: true,
        },
        files: [path.resolve(filePath)],
    };

    writeFileSync(tmpConfig, JSON.stringify(tsconfig));
    try {
        execSync(
            `node "${tscPath}" --project "${tmpConfig}"`,
            { stdio: 'pipe', timeout: 30000 },
        );
        return { ok: true, message: '' };
    } catch (err: any) {
        const output = (err.stdout?.toString() || '') + (err.stderr?.toString() || '');
        const lines = output.split('\n').filter((l: string) => l.trim()).slice(0, 5);
        return { ok: false, message: lines.join('\n') || 'TypeScript compilation failed.' };
    } finally {
        try { unlinkSync(tmpConfig); } catch {}
    }
}
