import type { Writable } from 'node:stream';
import type { StandaloneUiEvent } from './events.js';
import { displayWidth, formatDuration, truncateEnd, truncateMiddle } from './format.js';
import { createStandaloneTheme, type StandaloneTheme } from './theme.js';

interface ActiveCase {
    id: string;
    label: string;
    startedAt: number;
}

export interface CalmRendererOptions {
    stream?: Writable & { columns?: number; isTTY?: boolean; getColorDepth?: (env?: NodeJS.ProcessEnv) => number };
    env?: NodeJS.ProcessEnv;
    now?: () => number;
}

export class CalmRenderer {
    private readonly stream;
    private readonly env;
    private readonly theme: StandaloneTheme;
    private readonly now;
    private readonly active = new Map<string, ActiveCase>();
    private dynamicLines = 0;
    private frame = 0;
    private timer?: ReturnType<typeof setInterval>;
    private started = false;
    private finished = false;
    private readonly traceMode: boolean;
    private readonly quiet: boolean;
    private readonly onSignal = () => this.restoreTerminal();

    constructor(options: CalmRendererOptions = {}) {
        this.stream = options.stream ?? process.stdout;
        this.env = options.env ?? process.env;
        this.theme = createStandaloneTheme(this.stream, this.env);
        this.now = options.now ?? Date.now;
        this.traceMode = this.env.PATHGRADE_VERBOSE === '1';
        this.quiet = this.env.PATHGRADE_QUIET === '1';
        if (this.theme.interactive && !this.traceMode && !this.quiet) {
            process.once('SIGINT', this.onSignal);
            process.once('SIGTERM', this.onSignal);
        }
    }

    handle(event: StandaloneUiEvent): void {
        if (this.finished) return;
        if (event.type === 'run_start') return this.start(event.files.length);
        if (event.type === 'case_start') return this.startCase(event);
        if (event.type === 'case_finish') return this.finishCase(event);
        if (event.type === 'run_finish') return this.finishRun(event);
        if (event.type === 'run_error') this.fail();
    }

    externalWrite(chunk: Buffer | string, target: Writable = process.stderr): void {
        this.clearDynamic();
        target.write(chunk);
        this.renderDynamic();
    }

    fail(): void {
        this.clearDynamic();
        this.stopTimer();
        this.restoreTerminal();
        this.finished = true;
    }

    dispose(): void {
        this.clearDynamic();
        this.stopTimer();
        this.restoreTerminal();
    }

    private start(fileCount: number): void {
        if (this.started) return;
        this.started = true;
        if (!this.traceMode && !this.quiet) {
            this.write(`${this.theme.green(this.theme.bold('pathgrade'))} ${this.theme.bold('standalone')}\n`);
            this.write(`${fileCount} eval ${fileCount === 1 ? 'file' : 'files'}\n\n`);
        } else if (this.traceMode) {
            this.write(`${this.theme.green(this.theme.bold('pathgrade'))} ${this.theme.bold('trace')}\n`);
        }
    }

    private startCase(event: Extract<StandaloneUiEvent, { type: 'case_start' }>): void {
        this.active.set(event.id, {
            id: event.id,
            label: `${event.file} › ${event.name}`,
            startedAt: event.startedAt,
        });
        if (this.theme.interactive && !this.traceMode && !this.quiet && !this.timer) {
            this.stream.write('\x1b[?25l');
            this.timer = setInterval(() => this.renderDynamic(), 125);
            this.timer.unref?.();
        }
        this.renderDynamic();
    }

    private finishCase(event: Extract<StandaloneUiEvent, { type: 'case_finish' }>): void {
        this.active.delete(event.id);
        if (!this.traceMode && (!this.quiet || event.state === 'failed')) {
            this.clearDynamic();
            this.writeCompleted(event);
        }
        this.renderDynamic();
    }

    private finishRun(event: Extract<StandaloneUiEvent, { type: 'run_finish' }>): void {
        this.clearDynamic();
        this.stopTimer();
        this.restoreTerminal();
        const status = event.status === 'pass'
            ? this.theme.green(this.theme.bold('PASS'))
            : this.theme.red(this.theme.bold('FAIL'));
        const counts = [
            `${event.fileCount} ${event.fileCount === 1 ? 'file' : 'files'}`,
            event.passed ? `${event.passed} passed` : '',
            event.failed ? `${event.failed} failed` : '',
            event.skipped ? `${event.skipped} skipped` : '',
            formatDuration(event.durationMs),
        ].filter(Boolean).join(' · ');
        this.write(`${this.traceMode ? '\n' : ''}${status}  ${counts}\n`);
        const threshold = event.threshold === undefined ? '' : ` · threshold ${event.threshold.toFixed(2)}`;
        this.write(`      overall score ${event.overallScore.toFixed(2)}${threshold}\n`);
        this.write(`      results ${this.theme.cyan(event.resultsPath)}\n`);
        this.finished = true;
    }

    private writeCompleted(event: Extract<StandaloneUiEvent, { type: 'case_finish' }>): void {
        const icon = this.theme.interactive
            ? (event.state === 'passed' ? '✓' : event.state === 'failed' ? '✗' : '–')
            : (event.state === 'passed' ? 'PASS' : event.state === 'failed' ? 'FAIL' : 'SKIP');
        const coloredIcon = event.state === 'passed'
            ? this.theme.green(icon)
            : event.state === 'failed' ? this.theme.red(icon) : this.theme.yellow(icon);
        const width = this.columns();
        this.write(`${coloredIcon} ${truncateEnd(`${event.file} › ${event.name}`, Math.max(8, width - displayWidth(icon) - 1))}\n`);
        const status = event.state === 'passed'
            ? this.theme.green('PASS')
            : event.state === 'failed' ? this.theme.red('FAIL') : this.theme.yellow('SKIP');
        const score = event.score === undefined ? '' : `  score ${event.score.toFixed(2)}`;
        this.write(`  ${status}${score}  ${this.theme.dim(formatDuration(event.durationMs))}\n\n`);
    }

    private renderDynamic(): void {
        if (!this.theme.interactive || this.traceMode || this.quiet || this.finished) return;
        this.clearDynamic();
        const visible = [...this.active.values()].slice(0, 6);
        const lines = visible.map(item => {
            const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
            const marker = this.theme.cyan(frames[this.frame % frames.length]);
            const elapsed = formatDuration(this.now() - item.startedAt);
            const suffix = `  RUN  ${elapsed}`;
            const available = Math.max(8, this.columns() - displayWidth(suffix) - 2);
            return `${marker} ${truncateMiddle(item.label, available)}${suffix}`;
        });
        if (this.active.size > visible.length) lines.push(this.theme.dim(`  and ${this.active.size - visible.length} more`));
        if (lines.length) this.write(`${lines.join('\n')}\n`);
        this.dynamicLines = lines.length;
        this.frame++;
    }

    private clearDynamic(): void {
        if (!this.dynamicLines) return;
        this.stream.write(`\x1b[${this.dynamicLines}A`);
        for (let index = 0; index < this.dynamicLines; index++) {
            this.stream.write('\x1b[2K');
            if (index < this.dynamicLines - 1) this.stream.write('\x1b[1B');
        }
        if (this.dynamicLines > 1) this.stream.write(`\x1b[${this.dynamicLines - 1}A`);
        this.stream.write('\r');
        this.dynamicLines = 0;
    }

    private stopTimer(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }

    private restoreTerminal(): void {
        process.removeListener('SIGINT', this.onSignal);
        process.removeListener('SIGTERM', this.onSignal);
        if (this.theme.interactive && !this.traceMode && !this.quiet) this.stream.write('\x1b[?25h');
    }

    private columns(): number {
        return Math.max(20, this.stream.columns ?? 80);
    }

    private write(value: string): void {
        this.stream.write(value);
    }
}
