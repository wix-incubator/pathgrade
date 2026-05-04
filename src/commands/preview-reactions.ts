import * as path from 'path';
import { loadReactionSnapshotMessages, loadReactionsFromFile } from '../sdk/reaction-loader.js';
import { previewReactions } from '../sdk/reaction-preview.js';
import type { ReactionPreviewResult, ReactionPreviewStatus } from '../sdk/types.js';

type PreviewFormat = 'cli' | 'json';

export interface PreviewReactionsCommandOptions {
    snapshot: string;
    reactions: string;
    format?: PreviewFormat;
    cwd?: string;
    write?: (chunk: string) => void;
}

function readFlag(args: string[], flag: string): string | undefined {
    const exactIndex = args.findIndex((arg) => arg === flag);
    if (exactIndex >= 0) {
        return args[exactIndex + 1];
    }

    const inline = args.find((arg) => arg.startsWith(`${flag}=`));
    return inline ? inline.slice(flag.length + 1) : undefined;
}

function truncate(value: string, limit: number): string {
    if (value.length <= limit) return value;
    return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function getStatus(result: ReactionPreviewResult['turns'][number]['reactions'][number]): ReactionPreviewStatus {
    if (result.status) return result.status;
    if (result.fired) return 'fired';
    if (result.kind === 'text' && result.unlessMatched) return 'vetoed';
    return 'no-match';
}

function formatCli(result: ReactionPreviewResult): string {
    if (result.turns.length === 0) {
        return 'No agent turns found in snapshot.\n';
    }

    const lines: string[] = [];
    for (const turn of result.turns) {
        lines.push(`Turn ${turn.turn}: ${truncate(turn.agentMessage, 120)}`);
        if (turn.reactions.length === 0) {
            lines.push('  (no reactions)');
            continue;
        }

        for (const reaction of turn.reactions) {
            const reply = reaction.kind === 'text' ? reaction.reply : undefined;
            const replySuffix = reply ? ` -> ${truncate(reply, 80)}` : '';
            lines.push(`  [${reaction.reactionIndex}] ${getStatus(reaction)}${replySuffix}`);
        }
    }

    return `${lines.join('\n')}\n`;
}

function parseArgs(args: string[]): PreviewReactionsCommandOptions {
    const snapshot = readFlag(args, '--snapshot');
    if (!snapshot) {
        throw new Error('Missing required --snapshot <path> flag for preview-reactions.');
    }

    const reactions = readFlag(args, '--reactions');
    if (!reactions) {
        throw new Error('Missing required --reactions <path> flag for preview-reactions.');
    }

    const format = (readFlag(args, '--format') ?? 'cli') as PreviewFormat;
    if (format !== 'cli' && format !== 'json') {
        throw new Error('Invalid --format value. Expected "cli" or "json".');
    }

    return { snapshot, reactions, format };
}

async function buildPreview(
    opts: PreviewReactionsCommandOptions,
): Promise<ReactionPreviewResult> {
    const cwd = opts.cwd ?? process.cwd();
    const snapshotPath = path.resolve(cwd, opts.snapshot);
    const reactionsPath = path.resolve(cwd, opts.reactions);
    const messages = await loadReactionSnapshotMessages(snapshotPath);
    const reactions = await loadReactionsFromFile(reactionsPath);
    return previewReactions(messages, reactions);
}

export async function runPreviewReactions(
    input: string[] | PreviewReactionsCommandOptions,
): Promise<number> {
    const opts = Array.isArray(input) ? parseArgs(input) : input;
    const result = await buildPreview(opts);

    if (Array.isArray(input)) {
        if ((opts.format ?? 'cli') === 'json') {
            console.log(JSON.stringify(result, null, 2));
        } else {
            console.log(formatCli(result).trimEnd());
        }
        return 0;
    }

    const write = opts.write ?? ((chunk: string) => process.stdout.write(chunk));
    if ((opts.format ?? 'cli') === 'json') {
        write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
        write(formatCli(result));
    }
    return 0;
}
