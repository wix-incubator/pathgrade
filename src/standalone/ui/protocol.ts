import fs from 'node:fs';
import {
    isStandaloneUiEvent,
    STANDALONE_UI_FD,
    type StandaloneUiEvent,
} from './events.js';

export interface StandaloneUiSink {
    emit(event: StandaloneUiEvent): void;
}

export function createStandaloneUiSink(
    enabled: boolean,
    write: (line: string) => void = defaultWrite,
): StandaloneUiSink {
    let available = enabled;
    return {
        emit(event) {
            if (!available) return;
            try {
                write(`${JSON.stringify(event)}\n`);
            } catch {
                available = false;
            }
        },
    };
}

function defaultWrite(line: string): void {
    fs.writeSync(STANDALONE_UI_FD, line);
}

export class StandaloneUiDecoder {
    private pending = '';
    private failed = false;

    constructor(
        private readonly onEvent: (event: StandaloneUiEvent) => void,
        private readonly onInvalid: () => void,
    ) {}

    push(chunk: Buffer | string): void {
        if (this.failed) return;
        this.pending += chunk.toString();
        const lines = this.pending.split('\n');
        this.pending = lines.pop() ?? '';
        for (const line of lines) {
            if (!line) continue;
            this.decodeLine(line);
        }
    }

    end(): void {
        if (!this.failed && this.pending.trim()) this.decodeLine(this.pending);
        this.pending = '';
    }

    private decodeLine(line: string): void {
        try {
            const parsed: unknown = JSON.parse(line);
            if (!isStandaloneUiEvent(parsed)) throw new Error('unsupported event');
            this.onEvent(parsed);
        } catch {
            this.failed = true;
            this.onInvalid();
        }
    }
}
