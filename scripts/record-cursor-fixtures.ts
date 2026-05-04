/**
 * Cursor stream-json fixture recorder and drift check.
 *
 * Usage (refresh all fixtures against the locally-installed CLI):
 *
 *     pnpm tsx scripts/record-cursor-fixtures.ts
 *
 * Writes NDJSON per Cursor discriminant into `tests/fixtures/cursor/` and
 * prepends each fixture with a one-line header comment recording the exact
 * `cursor-agent --version` string. The comment is JSON-unparseable so
 * `parseCursorStreamJson` / `extractCursorStreamJsonEvents` silently skip it.
 *
 * Drift check: `checkCursorCliDrift({ pinnedVersion, getInstalledVersion })`
 * compares the installed CLI version against the PRD-pinned version and
 * returns `{ status: 'match' | 'mismatch' | 'skipped' }`. Warnings only —
 * never fails CI. When `cursor-agent` is not on PATH the check returns
 * `'skipped'` so CI runners without the binary stay green.
 *
 * Refreshing fixtures: install a matching `cursor-agent` build, ensure
 * `cursor-agent login` has run once, then invoke this script. It re-records
 * each discriminant from scratch and updates the version header.
 */

import { execSync } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** CLI version pinned in the PRD and used by the committed fixtures. */
export const CURSOR_PINNED_CLI_VERSION = '2026.04.17-787b533';

/** Comment marker prepended to every committed fixture. */
export const CURSOR_FIXTURE_HEADER_PREFIX = '// cursor-agent version:';

/** Absolute path to the committed cursor fixtures directory. */
export const CURSOR_FIXTURES_DIR = path.resolve(__dirname, '..', 'tests', 'fixtures', 'cursor');

export function formatFixtureHeader(version: string): string {
  return `${CURSOR_FIXTURE_HEADER_PREFIX} ${version}\n`;
}

export function readFixtureCliVersion(filepath: string): string | undefined {
  const raw = fs.readFileSync(filepath, 'utf8');
  const firstLine = raw.split('\n', 1)[0];
  if (!firstLine.startsWith(CURSOR_FIXTURE_HEADER_PREFIX)) return undefined;
  return firstLine.slice(CURSOR_FIXTURE_HEADER_PREFIX.length).trim();
}

export interface CliVersionDriftResult {
  status: 'match' | 'mismatch' | 'skipped';
  installed?: string;
  pinned?: string;
  message?: string;
}

export function checkCursorCliDrift(opts: {
  pinnedVersion: string;
  getInstalledVersion: () => string | undefined;
}): CliVersionDriftResult {
  let installed: string | undefined;
  try {
    installed = opts.getInstalledVersion();
  } catch {
    return {
      status: 'skipped',
      pinned: opts.pinnedVersion,
      message: 'cursor-agent not installed; drift check skipped',
    };
  }
  if (!installed) {
    return {
      status: 'skipped',
      pinned: opts.pinnedVersion,
      message: 'cursor-agent not installed; drift check skipped',
    };
  }
  if (installed === opts.pinnedVersion) {
    return { status: 'match', installed, pinned: opts.pinnedVersion };
  }
  return {
    status: 'mismatch',
    installed,
    pinned: opts.pinnedVersion,
    message:
      `cursor-agent ${installed} differs from pinned fixture version ${opts.pinnedVersion}; ` +
      `refresh with \`pnpm tsx scripts/record-cursor-fixtures.ts\``,
  };
}

/** Shells out to `cursor-agent --version`. Returns undefined if missing. */
export function getInstalledCursorVersionFromShell(): string | undefined {
  try {
    const out = execSync('cursor-agent --version', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

interface FixtureSpec {
  filename: string;
  prompt: string;
  /** Tool discriminant that the prompt should fire. Used for record-mode docs only. */
  discriminant?: string;
}

/** Per-discriminant prompts shaped to reliably fire the intended Cursor tool. */
const FIXTURE_SPECS: FixtureSpec[] = [
  { filename: 'tool-read.ndjson', discriminant: 'readToolCall', prompt: 'Read ./SKILL.md and summarize it in one sentence.' },
  { filename: 'tool-edit.ndjson', discriminant: 'editToolCall', prompt: 'Create a file ./note.txt containing the word "recorded".' },
  { filename: 'tool-glob.ndjson', discriminant: 'globToolCall', prompt: 'List all *.md files in the workspace.' },
  { filename: 'tool-grep.ndjson', discriminant: 'grepToolCall', prompt: 'Search the workspace for the literal string "TODO".' },
  { filename: 'tool-shell.ndjson', discriminant: 'shellToolCall', prompt: 'Run `ls -la` and paste the output.' },
  { filename: 'tool-webfetch.ndjson', discriminant: 'webFetchToolCall', prompt: 'Fetch https://example.com and summarize the response.' },
  { filename: 'tool-update-todos.ndjson', discriminant: 'updateTodosToolCall', prompt: 'Create a todo list with three items before responding.' },
  { filename: 'tool-multi.ndjson', prompt: 'Read ./SKILL.md, then list all *.md files in the workspace.' },
  { filename: 'envelope-success.ndjson', prompt: 'Reply with the word "ok" and nothing else.' },
  { filename: 'envelope-error.ndjson', prompt: '[intentionally triggers auth failure — run without CURSOR_API_KEY and without a live login]' },
];

async function runRealInvocation(workspace: string, prompt: string): Promise<string> {
  const promptPath = path.join(workspace, '.prompt.md');
  await fs.writeFile(promptPath, prompt, 'utf8');
  const cmd = `cursor-agent -p --output-format stream-json --trust --force --workspace "${workspace}" "$(cat "${promptPath}")" < /dev/null`;
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Entry point used when invoked via `pnpm tsx`. */
async function main(): Promise<void> {
  const version = getInstalledCursorVersionFromShell();
  if (!version) {
    console.error('cursor-agent not found on PATH — install it before recording fixtures.');
    process.exit(1);
  }

  const drift = checkCursorCliDrift({
    pinnedVersion: CURSOR_PINNED_CLI_VERSION,
    getInstalledVersion: () => version,
  });
  if (drift.status === 'mismatch') {
    console.warn(`[drift] ${drift.message}`);
    console.warn('[drift] Continuing — fixtures will be re-pinned to the new version.');
  }

  await fs.ensureDir(CURSOR_FIXTURES_DIR);
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pg-cursor-rec-'));
  try {
    await fs.writeFile(path.join(workspace, 'SKILL.md'), '# Demo skill\n\nDo nothing.\n');
    await fs.writeFile(path.join(workspace, 'README.md'), '# Demo\n\nTODO: nothing\n');

    for (const spec of FIXTURE_SPECS) {
      const target = path.join(CURSOR_FIXTURES_DIR, spec.filename);
      try {
        const raw = await runRealInvocation(workspace, spec.prompt);
        await fs.writeFile(target, formatFixtureHeader(version) + raw);
        console.log(`[ok] ${spec.filename}${spec.discriminant ? ` (${spec.discriminant})` : ''}`);
      } catch (err) {
        console.error(`[fail] ${spec.filename}: ${(err as Error).message}`);
      }
    }
  } finally {
    await fs.remove(workspace).catch(() => {});
  }
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] === __filename) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
