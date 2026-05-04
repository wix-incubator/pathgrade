/**
 * Static extraction of the `__pathgradeMeta` export from an eval file.
 *
 * The eval module is **never executed** — we parse it with the TypeScript
 * compiler's syntax API and walk the AST to find `export const __pathgradeMeta`.
 * This is critical: evals typically perform real work at module load
 * (creating agents, hitting LLMs) and running them just to read a static
 * declaration would defeat the purpose of affected-selection.
 *
 * Consequence: the value must be a literal expression. Dynamic composition
 * (`deps: [...BASE, 'extra']`, spread, computed identifiers) is not supported.
 * Users needing dedup should codegen the file from a build script.
 *
 * Returns `null` when the export is absent. Issue 7 will extend this to
 * throw on malformed meta (non-array deps, invalid globs, path-escape).
 */

import * as fs from 'fs';
import * as ts from 'typescript';
import picomatch from 'picomatch';

export interface ParsedMeta {
    deps?: string[];
    extraDeps?: string[];
    alwaysRun?: boolean;
}

/**
 * Parse `__pathgradeMeta` from an eval file's AST. Returns `null` if the
 * export is not present.
 */
export function parsePathgradeMeta(evalFile: string): ParsedMeta | null {
    const source = fs.readFileSync(evalFile, 'utf-8');
    const sourceFile = ts.createSourceFile(
        evalFile,
        source,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        ts.ScriptKind.TS,
    );

    for (const stmt of sourceFile.statements) {
        const initializer = findMetaInitializer(stmt);
        if (initializer) {
            return extractMeta(initializer, evalFile);
        }
    }
    return null;
}

function findMetaInitializer(stmt: ts.Statement): ts.Expression | null {
    // Match: `export const __pathgradeMeta [: Type] = <expr>`
    if (!ts.isVariableStatement(stmt)) return null;
    const hasExport = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) return null;

    for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        if (decl.name.text !== '__pathgradeMeta') continue;
        if (decl.initializer) return decl.initializer;
    }
    return null;
}

function extractMeta(expr: ts.Expression, evalFile: string): ParsedMeta {
    // Optionally unwrap a type assertion: `{...} as PathgradeMeta` / `<PathgradeMeta>{...}`.
    let node: ts.Expression = expr;
    while (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
        node = node.expression;
    }
    if (!ts.isObjectLiteralExpression(node)) {
        throw new Error(
            `${evalFile}: __pathgradeMeta must be an object literal (got ${ts.SyntaxKind[node.kind]}).`,
        );
    }

    const meta: ParsedMeta = {};
    for (const prop of node.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = propertyKeyName(prop.name);
        if (name === 'deps' || name === 'extraDeps') {
            const globs = extractStringArray(prop.initializer, evalFile, name);
            for (const g of globs) validateGlob(g, evalFile, name);
            meta[name] = globs;
        } else if (name === 'alwaysRun') {
            meta.alwaysRun = extractBoolean(prop.initializer, evalFile);
        }
        // Unknown keys are silently ignored — forward-compatible.
    }
    return meta;
}

/**
 * Validate a single glob entry. Catches three classes of error:
 *   - Path-escape: `../` segments that would match outside the repo root.
 *   - Unbalanced bracket / brace groups (unclosed `[`, `{` are
 *     parse-level mistakes that picomatch silently tolerates but that the
 *     PRD requires us to reject as user-intent errors).
 *   - Empty string.
 */
function validateGlob(glob: string, evalFile: string, field: string): void {
    if (glob.length === 0) {
        throw new Error(`${evalFile}: __pathgradeMeta.${field} contains an empty glob.`);
    }
    if (glob.startsWith('../') || glob.includes('/../') || glob === '..') {
        throw new Error(
            `${evalFile}: __pathgradeMeta.${field} entry "${glob}" escapes the repo root — ` +
            `globs must be repo-root-relative.`,
        );
    }
    const brackets = countUnbalanced(glob, '[', ']');
    const braces = countUnbalanced(glob, '{', '}');
    if (brackets !== 0 || braces !== 0) {
        throw new Error(
            `${evalFile}: __pathgradeMeta.${field} entry "${glob}" has invalid glob syntax ` +
            `(unbalanced brackets or braces).`,
        );
    }
    // Ask picomatch to compile — if it throws, surface the reason.
    try {
        picomatch(glob);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `${evalFile}: __pathgradeMeta.${field} entry "${glob}" has invalid glob syntax: ${msg}`,
        );
    }
}

function countUnbalanced(s: string, open: string, close: string): number {
    let depth = 0;
    let escaped = false;
    for (const ch of s) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === open) depth++;
        else if (ch === close) depth--;
        if (depth < 0) return depth;
    }
    return depth;
}

function propertyKeyName(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
    return null;
}

function extractStringArray(expr: ts.Expression, evalFile: string, field: string): string[] {
    if (!ts.isArrayLiteralExpression(expr)) {
        throw new Error(`${evalFile}: __pathgradeMeta.${field} must be an array of strings.`);
    }
    const out: string[] = [];
    for (const el of expr.elements) {
        if (!ts.isStringLiteral(el) && !ts.isNoSubstitutionTemplateLiteral(el)) {
            throw new Error(`${evalFile}: __pathgradeMeta.${field} entries must be string literals.`);
        }
        out.push(el.text);
    }
    return out;
}

function extractBoolean(expr: ts.Expression, evalFile: string): boolean {
    if (expr.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (expr.kind === ts.SyntaxKind.FalseKeyword) return false;
    throw new Error(`${evalFile}: __pathgradeMeta.alwaysRun must be a boolean literal.`);
}
