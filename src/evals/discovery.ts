import * as fs from 'fs';
import * as path from 'path';
import picomatch from 'picomatch';
import * as ts from 'typescript';

const EVAL_SUFFIX = '.eval.ts';
const PATHGRADE_PACKAGE = '@wix/pathgrade';

export interface EvalDiscoveryOptions {
    cwd: string;
    include: string[];
    exclude: string[];
}

export function discoverPathgradeEvalFiles(opts: EvalDiscoveryOptions): string[] {
    const { cwd, include, exclude } = opts;
    const root = path.resolve(cwd);
    const includeMatchers = include.map(g => picomatch(g, { dot: true }));
    const excludeMatchers = exclude.map(g => picomatch(g, { dot: true }));
    const results: string[] = [];

    function isIncluded(relPath: string): boolean {
        return includeMatchers.some(m => m(relPath));
    }

    function isExcluded(relPath: string): boolean {
        return excludeMatchers.some(m => m(relPath));
    }

    function walk(absDir: string, relDir: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const ent of entries) {
            const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
            if (isExcluded(rel)) continue;

            const abs = path.join(absDir, ent.name);
            if (ent.isDirectory()) {
                walk(abs, rel);
                continue;
            }

            if (!ent.isFile() || !ent.name.endsWith(EVAL_SUFFIX) || !isIncluded(rel)) continue;
            if (!isPathgradeEval(abs)) continue;
            results.push(rel);
        }
    }

    walk(root, '');
    results.sort();
    return results;
}

export function isPathgradeEval(absPath: string): boolean {
    const source = fs.readFileSync(absPath, 'utf8');
    const sourceFile = ts.createSourceFile(
        absPath,
        source,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ false,
        ts.ScriptKind.TS,
    );

    for (const stmt of sourceFile.statements) {
        if (isPathgradeImport(stmt) || isPathgradeMetaExport(stmt)) return true;
    }
    return false;
}

function isPathgradeImport(stmt: ts.Statement): boolean {
    if (!ts.isImportDeclaration(stmt)) return false;
    return ts.isStringLiteral(stmt.moduleSpecifier) && stmt.moduleSpecifier.text === PATHGRADE_PACKAGE;
}

function isPathgradeMetaExport(stmt: ts.Statement): boolean {
    if (!ts.isVariableStatement(stmt)) return false;
    const hasExport = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!hasExport) return false;

    return stmt.declarationList.declarations.some(decl =>
        ts.isIdentifier(decl.name) && decl.name.text === '__pathgradeMeta',
    );
}
