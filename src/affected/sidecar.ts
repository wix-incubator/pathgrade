/**
 * Selection sidecar — plumbing between CLI and reporter.
 *
 * `pathgrade run --changed` computes selection in the CLI, before vitest
 * spawns. `PathgradeReporter` runs inside the vitest process and can't
 * see that decision directly. The sidecar bridges them: the CLI writes a
 * small JSON file at `.pathgrade/selection.json`; the reporter reads it
 * (if present) at run-end and merges it into `results.json`.
 *
 * Shape mirrors Issue 10's wire format but flattens `selected` to file
 * paths and summarizes `changed_files` as a count — downstream consumers
 * (PR comments, dashboards) want the decision, not the per-trial reason
 * breakdown.
 */

import * as path from 'path';
import fs from 'fs-extra';
import { getPathgradeDir } from '../reporters/results-path.js';
import type { SelectionResult } from './types.js';
import type { PathgradeSelectionReport } from '../types.js';

export const SIDECAR_FILENAME = 'selection.json';

export function getSidecarPath(cwd: string): string {
    return path.join(getPathgradeDir(cwd), SIDECAR_FILENAME);
}

/**
 * Flatten a `SelectionResult` into the compact shape written to
 * `.pathgrade/selection.json` (and merged into `results.json` as
 * `PathgradeReport.selection`).
 */
export function toSelectionReport(result: SelectionResult): PathgradeSelectionReport {
    const report: PathgradeSelectionReport = {
        base_ref: result.baseRef,
        changed_files_count: result.changedFiles.length,
        selected: result.selected.map(s => s.file).sort(),
        skipped: [...result.skipped].sort((a, b) => a.file.localeCompare(b.file)).map(s => ({
            file: s.file,
            reason: s.reason,
        })),
    };
    if (result.globalMatch !== undefined) report.global_match = result.globalMatch;
    return report;
}

export async function writeSidecar(cwd: string, result: SelectionResult): Promise<void> {
    const sidecarPath = getSidecarPath(cwd);
    await fs.ensureDir(path.dirname(sidecarPath));
    await fs.writeJSON(sidecarPath, toSelectionReport(result), { spaces: 2 });
}

/**
 * Read the sidecar if present. Returns `null` when missing, and `null`
 * with an optional warning when the file exists but is malformed — the
 * reporter is expected to tolerate corruption rather than break the run.
 */
export async function readSidecar(
    cwd: string,
    onWarning?: (msg: string) => void,
): Promise<PathgradeSelectionReport | null> {
    const sidecarPath = getSidecarPath(cwd);
    if (!(await fs.pathExists(sidecarPath))) return null;
    try {
        const raw = await fs.readJSON(sidecarPath);
        if (!isSelectionReport(raw)) {
            onWarning?.(`${sidecarPath}: malformed sidecar (shape mismatch), ignoring.`);
            return null;
        }
        return raw;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onWarning?.(`${sidecarPath}: malformed sidecar (${msg}), ignoring.`);
        return null;
    }
}

export async function clearSidecar(cwd: string): Promise<void> {
    const sidecarPath = getSidecarPath(cwd);
    try {
        await fs.remove(sidecarPath);
    } catch {
        // Best-effort clear — a missing file is the expected case.
    }
}

function isSelectionReport(value: unknown): value is PathgradeSelectionReport {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.base_ref === 'string' &&
        typeof v.changed_files_count === 'number' &&
        Array.isArray(v.selected) &&
        Array.isArray(v.skipped)
    );
}
