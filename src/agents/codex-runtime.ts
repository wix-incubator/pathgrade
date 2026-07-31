import { spawn } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CODEX_VERSION = '0.144.0' as const;
const pathgradeRequire = createRequire(import.meta.url);

export interface BundledCodexCommand {
    executable: string;
    argsPrefix: string[];
    packageVersion: string;
    provenance: 'bundled';
}

export interface VerifiedBundledCodexRuntime {
    packageVersion: typeof CODEX_VERSION;
    nativeVersion: typeof CODEX_VERSION;
    provenance: 'bundled';
}

let verifiedRuntime: VerifiedBundledCodexRuntime | undefined;

function packagingDefect(message: string): Error {
    return new Error(`Pathgrade packaging defect: bundled Codex ${message}`);
}

/** @internal Exported for package-layout regression coverage. */
export function resolveBundledCodexNativeArtifact(packageJsonPath: string): string {
    const target = `${process.platform}:${process.arch}`;
    const platformPackageByTarget: Record<string, string> = {
        'darwin:x64': '@openai/codex-darwin-x64',
        'darwin:arm64': '@openai/codex-darwin-arm64',
        'linux:x64': '@openai/codex-linux-x64',
        'linux:arm64': '@openai/codex-linux-arm64',
    };
    const platformPackage = platformPackageByTarget[target];
    if (!platformPackage) {
        throw packagingDefect(`does not support ${process.platform}/${process.arch}`);
    }
    let artifactPackageJson: string;
    try {
        const codexRequire = createRequire(packageJsonPath);
        artifactPackageJson = codexRequire.resolve(`${platformPackage}/package.json`);
    } catch {
        throw packagingDefect(`native artifact ${platformPackage} is unavailable`);
    }
    const targetTripleByTarget: Record<string, string> = {
        'darwin:x64': 'x86_64-apple-darwin',
        'darwin:arm64': 'aarch64-apple-darwin',
        'linux:x64': 'x86_64-unknown-linux-musl',
        'linux:arm64': 'aarch64-unknown-linux-musl',
    };
    const targetTriple = targetTripleByTarget[target]!;
    const executable = join(
        dirname(artifactPackageJson),
        'vendor',
        targetTriple,
        'bin',
        process.platform === 'win32' ? 'codex.exe' : 'codex',
    );
    if (!existsSync(executable)) {
        throw packagingDefect(`native artifact ${platformPackage} is unavailable`);
    }
    return executable;
}

export function resolveBundledCodexCommand(): BundledCodexCommand {
    if (process.platform === 'win32') {
        throw new Error(
            'pathgrade standalone: native Windows is unsupported; use WSL with x64 or arm64',
        );
    }

    let packageJsonPath: string;
    try {
        packageJsonPath = pathgradeRequire.resolve('@openai/codex/package.json');
    } catch {
        throw packagingDefect('@openai/codex is unavailable');
    }

    let metadata: { version?: unknown; bin?: unknown };
    try {
        metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown; bin?: unknown };
    } catch {
        throw packagingDefect('package metadata is unreadable');
    }
    const launcher = typeof metadata.bin === 'object' && metadata.bin !== null
        ? (metadata.bin as { codex?: unknown }).codex
        : undefined;
    if (typeof launcher !== 'string') throw packagingDefect('launcher is unavailable');
    if (metadata.version !== CODEX_VERSION) {
        throw packagingDefect(`version must be ${CODEX_VERSION}`);
    }
    const launcherPath = resolve(dirname(packageJsonPath), launcher);
    if (!existsSync(launcherPath)) throw packagingDefect('launcher is unavailable');
    resolveBundledCodexNativeArtifact(packageJsonPath);

    return {
        executable: process.execPath,
        argsPrefix: [launcherPath],
        packageVersion: CODEX_VERSION,
        provenance: 'bundled',
    };
}

export async function verifyBundledCodexRuntime(
    command: BundledCodexCommand,
): Promise<VerifiedBundledCodexRuntime> {
    if (verifiedRuntime) return verifiedRuntime;
    const shimDir = mkdtempSync(join(tmpdir(), 'pathgrade-codex-path-'));
    const shimPath = join(shimDir, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    writeFileSync(
        shimPath,
        process.platform === 'win32' ? '@exit /b 127\r\n' : '#!/bin/sh\nexit 127\n',
    );
    if (process.platform !== 'win32') chmodSync(shimPath, 0o755);

    const output = await new Promise<string>((resolveOutput, reject) => {
        const child = spawn(command.executable, [...command.argsPrefix, '--version'], {
            shell: false,
            env: { ...process.env, PATH: shimDir },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', () => reject(packagingDefect('version probe could not start')));
        child.once('exit', (code, signal) => {
            if (signal || code !== 0) {
                reject(packagingDefect(`version probe failed${signal ? ` with ${signal}` : ` with exit ${code}`}`));
                return;
            }
            if (stderr.trim()) {
                reject(packagingDefect('version probe wrote to stderr'));
                return;
            }
            resolveOutput(stdout.trim());
        });
    }).finally(() => {
        rmSync(shimDir, { recursive: true, force: true });
    });
    if (output !== `codex-cli ${CODEX_VERSION}`) {
        throw packagingDefect(`version probe returned '${output}'`);
    }
    verifiedRuntime = {
        packageVersion: CODEX_VERSION,
        nativeVersion: CODEX_VERSION,
        provenance: 'bundled',
    };
    return verifiedRuntime;
}
