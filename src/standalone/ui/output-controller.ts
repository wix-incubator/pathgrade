import { CalmRenderer } from './calm-renderer.js';
import { StandaloneUiDecoder } from './protocol.js';
import type { Writable } from 'node:stream';

const RAW_OUTPUT_LIMIT = 2 * 1024 * 1024;

interface OutputStreams {
    stdout: Writable & {
        columns?: number;
        isTTY?: boolean;
        getColorDepth?: (env?: NodeJS.ProcessEnv) => number;
    };
    stderr: Writable;
}

export class StandaloneOutputController {
    private readonly renderer: CalmRenderer;
    private readonly decoder: StandaloneUiDecoder;
    private rawStdout: Buffer[] = [];
    private rawBytes = 0;
    private invalid = false;
    private warned = false;
    private protocolSeen = false;
    private finalReceived = false;
    private runnerFailed = false;
    private readonly passthrough: boolean;

    constructor(
        private readonly env: NodeJS.ProcessEnv = process.env,
        private readonly streams: OutputStreams = { stdout: process.stdout, stderr: process.stderr },
    ) {
        this.passthrough = env.PATHGRADE_REPORTER_MODE === 'json';
        this.renderer = new CalmRenderer({ env, stream: streams.stdout });
        this.decoder = new StandaloneUiDecoder(
            event => {
                if (event.type === 'run_finish') {
                    this.finalReceived = true;
                    this.runnerFailed = event.failed > 0;
                    if (this.runnerFailed) this.flushRaw();
                }
                this.renderer.handle(event);
            },
            () => this.protocolFailure(),
        );
    }

    stdout(chunk: Buffer | string): void {
        if (this.passthrough) {
            this.streams.stdout.write(chunk);
            return;
        }
        if (this.invalid) {
            this.streams.stdout.write(chunk);
            return;
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.rawStdout.push(buffer);
        this.rawBytes += buffer.length;
        while (this.rawBytes > RAW_OUTPUT_LIMIT && this.rawStdout.length > 1) {
            this.rawBytes -= this.rawStdout.shift()!.length;
        }
    }

    stderr(chunk: Buffer | string): void {
        this.renderer.externalWrite(chunk, this.streams.stderr);
    }

    protocol(chunk: Buffer | string): void {
        if (this.passthrough) return;
        this.protocolSeen = true;
        this.decoder.push(chunk);
    }

    finish(exitCode: number): void {
        if (this.passthrough) {
            this.renderer.dispose();
            return;
        }
        this.decoder.end();
        if (!this.protocolSeen) {
            this.protocolFailure();
        }
        this.renderer.dispose();
        if (this.invalid || (exitCode !== 0 && (!this.finalReceived || this.runnerFailed))) {
            this.flushRaw();
        }
    }

    dispose(): void {
        this.renderer.dispose();
    }

    private protocolFailure(): void {
        if (this.invalid) return;
        this.invalid = true;
        this.renderer.fail();
        if (!this.warned) {
            this.warned = true;
            this.streams.stderr.write('pathgrade standalone: rich output unavailable; using raw Vitest output\n');
        }
        this.flushRaw();
    }

    private flushRaw(): void {
        for (const chunk of this.rawStdout) this.streams.stdout.write(chunk);
        this.rawStdout = [];
        this.rawBytes = 0;
    }
}
