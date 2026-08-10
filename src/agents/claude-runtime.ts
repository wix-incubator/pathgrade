import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const SDK_VERSION = '0.2.116' as const;
const CLAUDE_CODE_VERSION = '2.1.116' as const;
const pathgradeRequire = createRequire(import.meta.url);

export interface VerifiedBundledClaudeRuntime {
    sdkVersion: typeof SDK_VERSION;
    embeddedBinaryVersion: typeof CLAUDE_CODE_VERSION;
    provenance: 'bundled';
}

let verifiedRuntime: VerifiedBundledClaudeRuntime | undefined;

function packagingDefect(message: string): Error {
    return new Error(`Pathgrade packaging defect: bundled Claude ${message}`);
}

function resolveSdkPackageJson(): string {
    try {
        return join(dirname(pathgradeRequire.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json');
    } catch {
        throw packagingDefect('Agent SDK is unavailable');
    }
}

function resolveBundledClaudeExecutable(): string {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const packageNames = process.platform === 'linux'
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}`,
        ]
        : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`];
    try {
        const requireFromSdk = createRequire(resolveSdkPackageJson());
        for (const packageName of packageNames) {
            try {
                const packageJsonPath = requireFromSdk.resolve(`${packageName}/package.json`);
                const executable = join(dirname(packageJsonPath), `claude${suffix}`);
                if (existsSync(executable)) return executable;
            } catch {
                continue;
            }
        }
    } catch {
        // Resolve below so every missing artifact gets the same diagnostic.
    }
    throw packagingDefect(`native artifact for ${process.platform}/${process.arch} is unavailable`);
}

export async function verifyBundledClaudeRuntime(): Promise<VerifiedBundledClaudeRuntime> {
    if (verifiedRuntime) return verifiedRuntime;

    const packageJsonPath = resolveSdkPackageJson();
    let metadata: { version?: unknown; claudeCodeVersion?: unknown };
    try {
        metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
            version?: unknown;
            claudeCodeVersion?: unknown;
        };
    } catch {
        throw packagingDefect('Agent SDK metadata is unreadable');
    }
    if (metadata.version !== SDK_VERSION || metadata.claudeCodeVersion !== CLAUDE_CODE_VERSION) {
        throw packagingDefect(`versions must be SDK ${SDK_VERSION} and Claude Code ${CLAUDE_CODE_VERSION}`);
    }

    const executable = resolveBundledClaudeExecutable();
    const output = await new Promise<string>((resolveOutput, reject) => {
        const child = spawn(executable, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
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
    });
    if (output !== `${CLAUDE_CODE_VERSION} (Claude Code)`) {
        throw packagingDefect(`version probe returned '${output}'`);
    }

    verifiedRuntime = {
        sdkVersion: SDK_VERSION,
        embeddedBinaryVersion: CLAUDE_CODE_VERSION,
        provenance: 'bundled',
    };
    return verifiedRuntime;
}
