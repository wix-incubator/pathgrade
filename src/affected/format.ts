/**
 * Formatters for `pathgrade affected --explain` and `--json`.
 *
 * JSON wire-format uses snake_case; the TS interface uses camelCase.
 * The enum values (`SelectionReason`) go on the wire as-is.
 *
 * This file stays pure — no fs, no process I/O — so it can be re-used by
 * Issue 11's sidecar writer (which uses the same shape, except for the
 * size-optimized `changed_files_count` summary).
 */

import type { SelectionResult } from './types.js';

interface JsonSelectionEntry {
    file: string;
    reason: string;
    matched_glob?: string;
}

interface JsonSelectionSkipped {
    file: string;
    reason: string;
}

export interface JsonSelectionResult {
    base_ref: string;
    changed_files: string[];
    global_match?: string;
    selected: JsonSelectionEntry[];
    skipped: JsonSelectionSkipped[];
    warnings: string[];
}

/**
 * Transform `SelectionResult` (camelCase) into the snake_case wire shape
 * consumed by `--json` and the sidecar-writer (Issue 11).
 */
export function toJsonShape(result: SelectionResult): JsonSelectionResult {
    const out: JsonSelectionResult = {
        base_ref: result.baseRef,
        changed_files: [...result.changedFiles].sort(),
        selected: result.selected.map(s => {
            const entry: JsonSelectionEntry = { file: s.file, reason: s.reason };
            if (s.matchedGlob !== undefined) entry.matched_glob = s.matchedGlob;
            return entry;
        }),
        skipped: [...result.skipped].sort((a, b) => a.file.localeCompare(b.file)),
        warnings: [...result.warnings],
    };
    if (result.globalMatch !== undefined) out.global_match = result.globalMatch;
    return out;
}

/**
 * Stable JSON: keys in a fixed order, arrays pre-sorted by `toJsonShape`.
 * Emits a trailing newline so downstream tools can treat it like any other
 * command output.
 */
export function formatJson(result: SelectionResult): string {
    return JSON.stringify(toJsonShape(result), null, 2) + '\n';
}

/**
 * Human-readable explanation for `--explain`. One section: base ref,
 * changed files, per-eval decision with reason, warnings footer.
 */
export function formatExplain(result: SelectionResult): string {
    const lines: string[] = [];
    lines.push(`base: ${result.baseRef}`);
    lines.push(`changed files: ${result.changedFiles.length}`);
    for (const f of result.changedFiles) lines.push(`  - ${f}`);

    if (result.globalMatch) {
        lines.push('');
        lines.push(`global trigger fired: \`${result.globalMatch}\` — all ${result.selected.length} evals selected`);
    }

    lines.push('');
    lines.push(`selected: ${result.selected.length}`);
    for (const s of result.selected) {
        lines.push(`  + ${s.file} — ${reasonLabel(s.reason, s.matchedGlob)}`);
    }

    if (result.skipped.length > 0) {
        lines.push('');
        lines.push(`skipped: ${result.skipped.length}`);
        for (const s of result.skipped) {
            lines.push(`  - ${s.file} — ${s.reason}`);
        }
    }

    if (result.warnings.length > 0) {
        lines.push('');
        lines.push('warnings:');
        for (const w of result.warnings) lines.push(`  ⚠  ${w}`);
    }
    return lines.join('\n') + '\n';
}

function reasonLabel(reason: string, matchedGlob?: string): string {
    switch (reason) {
        case 'deps-match':
            return matchedGlob ? `deps match (${matchedGlob})` : 'deps match';
        case 'always-run':
            return 'selected: alwaysRun';
        case 'global-match':
            return matchedGlob ? `global match (${matchedGlob})` : 'global match';
        case 'on-missing-fail-closed':
            return 'selected: onMissing fail-closed';
        default:
            return reason;
    }
}
