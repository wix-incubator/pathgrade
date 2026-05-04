/**
 * Verbose live-streaming emitter.
 *
 * Formats per-turn agent events into one-line human-readable output and
 * writes them to a sink (default: `process.stderr`). The emitter is
 * orthogonal to `--diagnostics`: it streams while the agent runs, rather
 * than summarizing after the fact.
 *
 * See `docs/prds/PRD_VERBOSE_LIVE_STREAMING.md` for the full design.
 */
import { fmt } from '../utils/cli.js';

/** Maximum characters retained in a prompt/reply preview before truncation. */
export const PREVIEW_MAX_CHARS = 80;

/** Maximum characters retained in a retry error message before truncation. */
export const RETRY_ERROR_MAX_CHARS = 120;

/** Ellipsis appended to truncated strings. */
export const TRUNCATION_SUFFIX = '…';

/** Newline replacement in single-line previews. */
export const NEWLINE_REPLACEMENT = '⏎';

export interface VerboseSink {
    write(line: string): void;
}

export interface VerboseEmitterOptions {
    enabled: boolean;
    /** Output sink. Defaults to a stderr-backed sink. */
    sink?: VerboseSink;
    /**
     * Optional test-name header printed once before the first real event.
     * Helps the reader locate the beginning of each test block.
     */
    testName?: string;
}

export interface TurnStartArgs {
    turn: number;
    kind: 'agent_start' | 'user_reply';
    message: string;
}

export interface ToolEventArgs {
    action: string;
    summary: string;
}

export interface TurnEndArgs {
    turn: number;
    durationMs: number;
    outputLines: number;
    messagePreview: string;
}

export interface RetryArgs {
    attempt: number;
    maxAttempts: number;
    errorMessage: string;
}

export interface ReactionFiredArgs {
    turn: number;
    reactionIndex: number;
    pattern: string;
    reply: string;
}

export interface BlockedPromptArgs {
    sourceTool: string;
    promptIndex: number;
    promptCount: number;
}

export interface ConversationEndArgs {
    reason: string;
    turns: number;
    durationMs: number;
    /** Present when `reason === 'error'` / `'timeout'` / `'agent_crashed'`. */
    detail?: string;
}

export interface VerboseEmitter {
    readonly enabled: boolean;
    turnStart(args: TurnStartArgs): void;
    toolEvent(args: ToolEventArgs): void;
    turnEnd(args: TurnEndArgs): void;
    retry(args: RetryArgs): void;
    reactionFired(args: ReactionFiredArgs): void;
    blockedPrompt(args: BlockedPromptArgs): void;
    conversationEnd(args: ConversationEndArgs): void;
}

/**
 * Build a preview string: strip newlines, truncate to a max length.
 * `null` / `undefined` becomes an empty string so formatting never throws.
 */
export function preview(text: string | null | undefined, max: number = PREVIEW_MAX_CHARS): string {
    const normalized = (text ?? '').replace(/\r?\n/g, NEWLINE_REPLACEMENT);
    if (normalized.length <= max) return normalized;
    return normalized.slice(0, max) + TRUNCATION_SUFFIX;
}

function stderrSink(): VerboseSink {
    return {
        write(line: string): void {
            // Bypass vitest's stdout capture: vitest's default reporter
            // does not hijack stderr, so writes here reach the user's
            // terminal while a test is still running.
            process.stderr.write(line + '\n');
        },
    };
}

function formatDurationSeconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function disabledEmitter(): VerboseEmitter {
    return {
        enabled: false,
        turnStart() {},
        toolEvent() {},
        turnEnd() {},
        retry() {},
        reactionFired() {},
        blockedPrompt() {},
        conversationEnd() {},
    };
}

export function createVerboseEmitter(opts: VerboseEmitterOptions): VerboseEmitter {
    if (!opts.enabled) {
        return disabledEmitter();
    }
    const sink = opts.sink ?? stderrSink();
    const testName = opts.testName;
    let headerPrinted = false;

    const emitHeaderOnce = () => {
        if (headerPrinted) return;
        headerPrinted = true;
        if (testName) {
            sink.write(fmt.bold(`▶ ${testName}`));
        }
    };

    const writeLine = (line: string) => {
        emitHeaderOnce();
        sink.write(line);
    };

    return {
        enabled: true,

        turnStart({ turn, kind, message }) {
            const p = preview(message, PREVIEW_MAX_CHARS);
            writeLine(`${fmt.cyan('→')} Turn ${fmt.bold(String(turn))} ${fmt.dim(`[${kind}]`)} "${p}"`);
        },

        toolEvent({ action, summary }) {
            writeLine(`  ${fmt.dim('·')} ${fmt.cyan(action)} ${summary}`);
        },

        turnEnd({ turn, durationMs, outputLines, messagePreview }) {
            const p = preview(messagePreview, PREVIEW_MAX_CHARS);
            const duration = formatDurationSeconds(durationMs);
            writeLine(
                `${fmt.green('←')} Turn ${fmt.bold(String(turn))}  ${fmt.dim(duration)}  ${fmt.dim(`${outputLines}l`)}  "${p}"`,
            );
        },

        retry({ attempt, maxAttempts, errorMessage }) {
            const msg = preview(errorMessage, RETRY_ERROR_MAX_CHARS);
            writeLine(`  ${fmt.red('⟲')} retry ${attempt}/${maxAttempts}: ${msg}`);
        },

        reactionFired({ reactionIndex, pattern, reply }) {
            const p = preview(reply, PREVIEW_MAX_CHARS);
            writeLine(`  ${fmt.cyan('⚡')} reaction ${fmt.bold(`#${reactionIndex}`)} ${fmt.dim(pattern)} → "${p}"`);
        },

        blockedPrompt({ sourceTool, promptIndex, promptCount }) {
            writeLine(
                `  ${fmt.dim('⎔')} blocked prompt from ${sourceTool} ${fmt.dim(`#${promptIndex + 1}/${promptCount}`)}`,
            );
        },

        conversationEnd({ reason, turns, durationMs, detail }) {
            const duration = formatDurationSeconds(durationMs);
            const detailSuffix = detail
                ? `  ${fmt.red('detail=')}${preview(detail, RETRY_ERROR_MAX_CHARS)}`
                : '';
            writeLine(
                `${fmt.bold('■')} end  ${fmt.dim('reason=')}${reason}  ${fmt.dim('turns=')}${turns}  ${fmt.dim(duration)}${detailSuffix}`,
            );
        },
    };
}
