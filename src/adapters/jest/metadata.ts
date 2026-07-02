import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PathgradeTestMeta } from '@wix/pathgrade/adapter-kit';

const METADATA_ENV = 'PATHGRADE_JEST_METADATA_PATH';
const FALLBACK_METADATA_FILE = 'jest-metadata.jsonl';

interface MetadataRecord {
    caseId: string;
    metadata: PathgradeTestMeta[];
}

export function resolveJestMetadataPath(cwd = process.cwd()): string {
    return process.env[METADATA_ENV] ?? path.join(cwd, '.pathgrade', FALLBACK_METADATA_FILE);
}

export function withJestMetadataEnv(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
    return {
        ...env,
        [METADATA_ENV]: env[METADATA_ENV] ?? path.join(cwd, '.pathgrade', `${process.pid}-${Date.now()}-${FALLBACK_METADATA_FILE}`),
    };
}

export function appendJestMetadata(caseId: string, metadata: PathgradeTestMeta[]): void {
    if (metadata.length === 0) return;

    const metadataPath = resolveJestMetadataPath();
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.appendFileSync(metadataPath, `${JSON.stringify({ caseId, metadata })}\n`, 'utf8');
}

export function readJestMetadata(metadataPath = resolveJestMetadataPath()): Map<string, PathgradeTestMeta[]> {
    if (!fs.existsSync(metadataPath)) return new Map();

    const metadataByCaseId = new Map<string, PathgradeTestMeta[]>();
    for (const line of fs.readFileSync(metadataPath, 'utf8').split('\n')) {
        if (line.trim().length === 0) continue;
        const entry = JSON.parse(line) as MetadataRecord;
        metadataByCaseId.set(entry.caseId, entry.metadata);
    }
    return metadataByCaseId;
}

export function removeJestMetadata(metadataPath = resolveJestMetadataPath()): void {
    fs.rmSync(metadataPath, { force: true });
}
