// eslint-disable-next-line no-control-regex -- ANSI escape-sequence parser
const ANSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export function stripAnsi(value: string): string {
    return value.replace(ANSI_PATTERN, '');
}

export function displayWidth(value: string): number {
    let width = 0;
    for (const char of stripAnsi(value)) width += isWide(char) ? 2 : 1;
    return width;
}

export function truncateEnd(value: string, width: number): string {
    value = stripAnsi(value);
    if (width <= 0) return '';
    if (displayWidth(value) <= width) return value;
    if (width === 1) return '…';
    return takeWidth(value, width - 1) + '…';
}

export function truncateMiddle(value: string, width: number): string {
    value = stripAnsi(value);
    if (width <= 0) return '';
    if (displayWidth(value) <= width) return value;
    if (width === 1) return '…';
    const leftWidth = Math.ceil((width - 1) / 2);
    const rightWidth = Math.floor((width - 1) / 2);
    return takeWidth(value, leftWidth) + '…' + takeWidthFromEnd(value, rightWidth);
}

export function formatDuration(durationMs: number): string {
    const seconds = Math.max(0, Math.round(durationMs / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function takeWidth(value: string, maxWidth: number): string {
    let result = '';
    let width = 0;
    for (const char of value) {
        const next = isWide(char) ? 2 : 1;
        if (width + next > maxWidth) break;
        result += char;
        width += next;
    }
    return result;
}

function takeWidthFromEnd(value: string, maxWidth: number): string {
    let result = '';
    let width = 0;
    for (const char of Array.from(value).reverse()) {
        const next = isWide(char) ? 2 : 1;
        if (width + next > maxWidth) break;
        result = char + result;
        width += next;
    }
    return result;
}

function isWide(char: string): boolean {
    const code = char.codePointAt(0) ?? 0;
    return /\p{Extended_Pictographic}/u.test(char)
        || (code >= 0x1100 && (
            code <= 0x115f || code === 0x2329 || code === 0x232a
            || (code >= 0x2e80 && code <= 0xa4cf)
            || (code >= 0xac00 && code <= 0xd7a3)
            || (code >= 0xf900 && code <= 0xfaff)
            || (code >= 0xfe10 && code <= 0xfe6f)
            || (code >= 0xff00 && code <= 0xff60)
            || (code >= 0x1f300 && code <= 0x1faff)
            || (code >= 0x20000 && code <= 0x3fffd)
        ));
}
