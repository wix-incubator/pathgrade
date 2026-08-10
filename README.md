# Pathgrade

**Evaluate AI coding agents with Vitest or Jest.** Write evals as normal `.eval.ts` files, run Claude Code, Codex, or Cursor in isolated sandboxes, and score the result with deterministic checks, rubric judges, and tool-usage assertions.

## Why Pathgrade?

- Write evals in plain TypeScript with Vitest or Jest
- Run each trial in an isolated workspace and HOME directory
- Seed trials from fixtures, real skills, or mocked MCP servers
- Score both final artifacts and the workflow that produced them
- Debug long conversations with preserved workspaces and run snapshots
- Use the same evals locally and in CI

## Standalone—Node only

Run a TypeScript eval without adding Pathgrade, Vitest, Claude, or Codex to the target project:

```text
npx @wix/pathgrade standalone
npx @wix/pathgrade standalone run path/to/example.eval.ts
npm install --global @wix/pathgrade
pathgrade standalone
```

Standalone v0 supports Node.js 22 or 24 on macOS, Linux, or WSL (`x64` and `arm64`). It runs Claude through the bundled Claude Agent SDK and Claude Code binary, or Codex through the bundled Codex `app-server`; credentials and network access for the selected provider are still required. No local Pathgrade, Vitest, Claude, or Codex install is used, and there is no fallback to `PATH`, `npx`, or a target `node_modules` for those runtimes.

Evals may import from root `vitest`, `@wix/pathgrade`, and the documented standalone Pathgrade eval subpaths. Vitest subpaths such as `vitest/config` are not supported in standalone v0. Application dependencies remain your responsibility and must be installed or otherwise resolvable by the target project.

Standalone ignores project Vitest configuration and does not load `.env`. Its temporary HOME, cache, and workspace isolation prevents accidental project mutation, but local workspace isolation is not a security sandbox. Jest, Cursor, Codex `exec`, Docker, declarative specs, recording, and baselines are deferred beyond standalone v0.

Standalone uses a compact, color-aware progress view in interactive terminals and stable line-oriented output in CI or redirected streams. Use `--verbose` for an agent-labeled live trace, `--quiet` for failures and the final status only, or `--diagnostics` for expanded final diagnostics. `--quiet` and `--verbose` are mutually exclusive. Color is semantic and never replaces status text; `NO_COLOR` or `FORCE_COLOR=0` disables it.

Existing project-local `@wix/pathgrade` commands remain unchanged unless you select the explicit `standalone` namespace; project-local configuration, `.env`, adapters, and executable overrides retain their current behavior. This release installs and publishes only `@wix/pathgrade`: no unscoped `pathgrade` package is installed or published.

## Quick Start

**Prerequisites**: Node.js 20.11+, Vitest 4+ or Jest 30+, and at least one configured agent runtime. Claude uses the bundled `@anthropic-ai/claude-agent-sdk` binary by default; Codex requires the `codex` CLI; Cursor requires the `cursor-agent` CLI.

```bash
yarn add -D @wix/pathgrade
```

For Jest projects, install Jest too:

```bash
yarn add -D @wix/pathgrade jest
```

### Authentication

By default, Pathgrade tries to reuse the agent CLI's native auth before falling back to explicit environment variables.

- **Claude**
  - macOS: reuses Claude Code OAuth from Keychain
  - other platforms: forwards `ANTHROPIC_API_KEY` when present
- **Codex**
  - forwards `OPENAI_API_KEY` when present
  - or runs `codex login --with-api-key` inside the sandbox when an API key is present
  - `codex exec` can reuse cached `~/.codex/auth.json` when no key is available; `app-server` may reject cached ChatGPT-token refreshes, so prefer `OPENAI_API_KEY` for the default transport
- **Cursor**
  - forwards `CURSOR_API_KEY` when set
  - macOS: reuses `cursor-agent login` OAuth tokens from the login Keychain
  - surfaces a clear error when neither is available (run `cursor-agent login` or set `CURSOR_API_KEY`)

If you set `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, or `CURSOR_API_BASE_URL`, set the matching API key too.

Override credentials per test with `env`:

```typescript
const agent = await createAgent({
    agent: 'claude',
    env: {
        ANTHROPIC_API_KEY: process.env.MY_ANTHROPIC_KEY!,
    },
});
```

### Transport (Codex only)

Codex supports two transports and Pathgrade defaults to `app-server`:

- `app-server` (default) — uses `codex app-server` and keeps native thread state. Required for `AskUserReaction` handshakes (`request_user_input` reaches the model). Prefer `OPENAI_API_KEY`; cached ChatGPT auth can fail if the app-server asks Pathgrade to refresh tokens.
- `exec` — uses `codex exec` and re-injects the transcript every turn. Kept for stateless CI matrices that don't need the handshake.

Precedence: `createAgent({ transport })` > `PATHGRADE_CODEX_TRANSPORT` env > default (`app-server`). An invalid env value throws at `createAgent` time.

```typescript
const agent = await createAgent({
    agent: 'codex',
    transport: 'exec', // opt out of app-server
});
```

If `transport: 'exec'` is resolved and any `AskUserReaction` is present in `ConverseOptions.reactions`, the conversation fails fast before turn 1 — the handshake cannot fire under `exec`. Set `allowUnreachableReactions: true` on `runConversation` to silence the guard.

Migrating from `exec` to `app-server`:

- Export `OPENAI_API_KEY`, or set `transport: 'exec'` / `PATHGRADE_CODEX_TRANSPORT=exec` to stay on the old transport and its cached-auth behavior.
- The `noninteractive-user-question` runtime policy no longer attaches under `app-server`. Snapshots that captured model output influenced by that policy text may need re-recording.
- `MAX_TURN_RETRIES` does not apply under `app-server` — a crashed turn ends the conversation with `completionReason: 'agent_crashed'`.

### Plugin Setup

Create a `vitest.config.ts` with the built-in Vitest adapter plugin:

```typescript
import { defineConfig } from 'vitest/config';
import { pathgrade } from '@wix/pathgrade/adapters/vitest';

export default defineConfig({
    plugins: [pathgrade({ timeout: 120 })],
});
```

The plugin registers the setup hooks Pathgrade needs, wires in the reporter, and automatically cleans up agent workspaces after each test.

For Pathgrade CLI behavior, use `pathgrade.config.ts`:

```typescript
export default {
    runner: {
        adapter: 'vitest', // default; use 'jest' for Jest projects
        args: [],
    },
    evals: {
        include: ['**/*.eval.ts'],
        exclude: ['**/fixtures/**'],
    },
    affected: {
        global: ['package.json', 'yarn.lock'],
    },
};
```

### First Eval

Write an eval file such as `hello.eval.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { createAgent, check, evaluate } from '@wix/pathgrade';

describe('hello world', () => {
    it('agent creates the requested file', async () => {
        const agent = await createAgent({
            agent: 'claude',
            workspace: path.join(__dirname, 'fixtures'),
        });

        await agent.prompt('Create a file called hello.txt with the text "Hello, world!"');

        const result = await evaluate(agent, [
            check('hello.txt exists', ({ workspace }) =>
                fs.existsSync(path.join(workspace, 'hello.txt'))),
        ]);

        expect(result.score).toBe(1);
    });
});
```

Run your evals:

```bash
npx pathgrade run
```

`pathgrade run` is the recommended wrapper: it loads `.env`, warns when no auth is configured, and adds Pathgrade-specific flags such as `--changed`, `--diagnostics`, and `--verbose`. Plain `npx vitest run` or direct Jest runs work too if you configure the Pathgrade adapter hooks yourself.

## Core Concepts

- **Agent**: the coding agent under test, such as Claude, Codex, or Cursor
- **Workspace**: an isolated directory where the agent works, optionally seeded from fixtures
- **Scorer**: a function or judge that evaluates output or behavior
- **Evaluation**: the aggregated result of one or more scorers, returned as a score from `0.0` to `1.0`

## Scorers

Scorers evaluate the agent's output and behavior. `evaluate()` runs all scorers and computes a weighted average between `0.0` and `1.0`.

Use `check()` for binary requirements, `score()` for partial credit, `judge()` for rubric-based evaluation, and `toolUsage()` when the workflow matters as much as the final output.

### `check()` - Boolean gate

```typescript
check('tests-pass', async ({ runCommand }) => {
    const { exitCode } = await runCommand('npm test');
    return exitCode === 0;
});
```

### `score()` - Partial credit

```typescript
score('coverage', async ({ runCommand }) => {
    const { stdout } = await runCommand('npx coverage-summary');
    return parseFloat(stdout) / 100;
});
```

### `judge()` - Rubric evaluation

```typescript
judge('workflow-quality', {
    rubric: `Did the agent read the file before editing? (0-0.5)
Was the fix minimal and correct? (0-0.5)`,
});
```

Judge scorers also support:

- `retry` for transient judge failures
- `includeToolEvents` when the rubric should see the tool trace
- `input` for extra context such as generated file contents or command output
- `tools` to let the judge LLM read workspace artifacts itself via a bounded tool-use loop (`readFile`, `listDir`, `grep`, `getToolEvents`)

Example with artifact-backed input:

```typescript
judge('output-quality', {
    rubric: 'Is the generated markdown correct and complete?',
    includeToolEvents: true,
    input: async ({ artifacts }) => ({
        'output.md': await artifacts.read('output.md'),
    }),
});
```

Example with tool-using judge (the judge reads the file itself — no pre-computed probe):

```typescript
judge('spec-structure', {
    rubric: `Read artifacts/spec.md. Score 1.0 if it contains Intent Hierarchy,
             Functional Requirements, and API Surface sections. 0.33 per section.`,
    tools: ['readFile'],
});
```

Tool-using judges currently require the Anthropic HTTP provider (`ANTHROPIC_API_KEY`); other providers produce a clean `provider_not_supported` error. See the [User Guide](docs/USER_GUIDE.md#tool-using-judges) for the full tool list, failure codes, and the migration recipe from `input`-helper probes.

### `toolUsage()` - Tool event matching

```typescript
toolUsage('expected-workflow', [
    { action: 'read_file', min: 1, weight: 0.3 },
    { action: 'edit_file', min: 1, weight: 0.3 },
    { action: 'run_shell', commandContains: 'test', min: 1, weight: 0.4 },
]);
```

## Conversations

Pathgrade currently supports three agent backends: `claude`, `codex`, and `cursor`. Set the backend per test via `createAgent({ agent: 'claude' })`, or omit `agent` and use `PATHGRADE_AGENT` as the process-wide fallback.

### `agent.prompt()` - One shot

Send a single instruction and let the agent work to completion:

```typescript
const agent = await createAgent({ agent: 'claude', workspace: 'fixtures' });
await agent.prompt('Create a file called hello.txt with the text "Hello, world!"');
```

### `startChat()` - Imperative

Drive the conversation yourself:

```typescript
const chat = await agent.startChat('Set up a new TypeScript project.');
await chat.reply('Use strict mode and add eslint.');
if (await chat.hasFile('tsconfig.json')) {
    await chat.reply('Now add a build script.');
}
chat.end();
```

### `runConversation()` - Scripted or persona-driven

Drive the loop with reactions:

```typescript
const result = await agent.runConversation({
    firstMessage: 'I want to create a new feature.',
    maxTurns: 12,
    until: async ({ hasFile }) => await hasFile('project-brief.md'),
    reactions: [
        { when: /goal/i, reply: 'Solve a user pain point' },
        { when: /audience/i, reply: 'Self-Creator' },
    ],
});
```

Or let a persona answer on the user's behalf:

```typescript
const result = await agent.runConversation({
    firstMessage: 'I want to create a new feature.',
    maxTurns: 12,
    until: async ({ hasFile }) => await hasFile('project-brief.md'),
    persona: {
        description: 'A product manager who communicates concisely.',
        facts: ['The feature is for online stores'],
    },
});
```

`runConversation()` also supports `stepScorers`, so long conversations can be graded at intermediate milestones instead of only at the end.

## Advanced SDK Features

Pathgrade exposes a few useful features that are easy to miss from the basic examples:

- `createAgent({ skillDir, workspace })` stages a real skill and a fixture workspace into the sandbox, which is how Pathgrade's skill examples are evaluated.
- `createAgent({ debug: true })` preserves the final workspace under `pathgrade-debug/<test-name>/`; when you use `runConversation()`, it also writes `run-snapshot.json`.
- `evaluate.fromSnapshot(snapshotPath, scorers)` re-runs grading against a saved snapshot without re-running the agent.
- `previewReactions(messages, reactions)` lets you inspect which scripted reactions would fire offline.
- `conversationWindow` on agents and personas keeps long transcripts bounded with summarization instead of sending the full conversation every turn.
- `copyIgnore` and `DEFAULT_COPY_IGNORE` let you control what gets copied into the sandbox when seeding from large fixtures or skill directories.

See [sdk-showcase](examples/sdk-showcase/) for a single example suite that demonstrates these APIs together.

## MCP Mock Servers

Simulate MCP tools when testing Claude, Codex app-server, or Cursor evals:

```typescript
import { mockMcpServer } from '@wix/pathgrade/mcp-mock';

const mock = mockMcpServer({
    name: 'weather',
    tools: [{
        name: 'get_weather',
        description: 'Get weather for a city',
        when: 'weather',
        response: { temp: 72, unit: 'F' },
    }],
});

const agent = await createAgent({ agent: 'claude', mcpMock: mock });
```

## CLI

```bash
pathgrade run [--changed] [--since=<ref>] [--changed-files=<path>] [--adapter=<name|path>] [--diagnostics] [--verbose] [--quiet] [-- runner-args]
pathgrade init [--force]
pathgrade validate <file.eval.ts>
pathgrade validate --affected
pathgrade analyze [--skill=<name>] [--dir=<path>]
pathgrade affected [--since=<ref>] [--changed-files=<path>] [--explain] [--json]
pathgrade preview [browser] [--last=N] [--filter=text]
pathgrade preview-reactions --snapshot <run-snapshot.json> --reactions <file.ts>
pathgrade report [--results-path=<path>] [--no-comment] [--comment-id=<id>]
```

Useful details:

- `pathgrade run --changed` computes affected evals first, writes selection metadata to `.pathgrade/selection.json`, and only then launches the selected runner adapter. Vitest is the default adapter; Jest is selected with `runner.adapter: 'jest'` or `--adapter=jest`.
- `pathgrade preview browser` starts a local viewer on `http://localhost:3847`.
- `pathgrade report` posts or updates a PR comment in GitHub Actions; locally it prints the markdown report and then the numeric pass rate.
- `pathgrade validate --affected` is a strict mode for CI: every discovered eval must either live under a `SKILL.md` anchor or export valid `__pathgradeMeta`.

Run `pathgrade --help` for the full help text.

## Configuration

```typescript
// pathgrade.config.ts
export default {
    runner: {
        adapter: 'vitest',
        args: [],
    },
    evals: {
        include: ['**/*.eval.ts'],   // default
        exclude: ['**/fixtures/**'], // replaces the default exclude list if set
    },
    affected: {
        global: ['package.json', 'yarn.lock'],
    },
    ci: { threshold: 0.8 },
};
```

Pathgrade reads `pathgrade.config.*` for CLI and affected-selection behavior. `runner.adapter` and `--adapter=<name|path>` select the runner; `--adapter` wins over config. Built-in adapters currently include `vitest`, `jest`, and the narrow `node-test` proof adapter.

Third-party runner adapters are supported through `@wix/pathgrade/adapter-kit`. Adapter names resolve as follows:

- `vitest`, `jest`, `node-test`: built-in adapters
- `demo`: package `@wix/pathgrade-adapter-demo`, resolved from the project
- `@scope/pathgrade-adapter-demo` or another specifier containing `/`: package specifier, resolved from the project
- `./local-adapter.mjs` or `/abs/local-adapter.mjs`: local adapter module

External adapter modules used by `pathgrade run` must export `createPathgradeInvocationAdapter({ config })`, returning a `RunnerInvocationAdapter`. Modules used by lower-level orchestration can also export `createPathgradeAdapter()`, returning a `RunnerAdapter` with `discover`, `invoke`, and `collectNormalizedRunSnapshot`.

Vitest runner behavior still belongs in `vitest.config.ts`:

```typescript
import { pathgrade } from '@wix/pathgrade/adapters/vitest';

pathgrade({
    timeout: 300,                // seconds, default: 300
    reporter: 'cli',             // 'cli' | 'browser' | 'json'
    diagnostics: false,          // print full diagnostics for passing evals too
    verbose: false,              // stream live per-turn events to stderr while evals run
});
```

Jest runner behavior still belongs in `jest.config.*`. Pathgrade injects only the setup and reporter it needs when you use `pathgrade run --adapter=jest`; transforms, test environment, module resolution, and ESM/TypeScript support remain your Jest config's job.

For direct Jest runs, configure the same entry points explicitly:

```js
// jest.config.mjs
export default {
    setupFilesAfterEnv: ['@wix/pathgrade/adapters/jest/setup'],
    reporters: ['default', '@wix/pathgrade/adapters/jest/reporter'],
};
```

Notes:

- Legacy `@wix/pathgrade/plugin` and `@wix/pathgrade/plugin/vitest` imports remain as compatibility fallbacks, but new config should use `@wix/pathgrade/adapters/vitest` and `pathgrade.config.*`.
- `reporter: 'browser'` writes results JSON and opens the viewer automatically after the run.
- SDK-only consumers can import `@wix/pathgrade` without installing Vitest or Jest. Adapter users need their selected runner available.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude auth and the required key when using `ANTHROPIC_BASE_URL` |
| `OPENAI_API_KEY` | Codex auth and the required key when using `OPENAI_BASE_URL` |
| `CURSOR_API_KEY` | Cursor auth and the required key when using `CURSOR_API_BASE_URL` |
| `ANTHROPIC_BASE_URL` | Custom Anthropic-compatible endpoint |
| `OPENAI_BASE_URL` | Custom OpenAI-compatible endpoint |
| `CURSOR_API_BASE_URL` | Custom Cursor-compatible endpoint |
| `PATHGRADE_AGENT` | Fallback agent for all tests (`claude`, `codex`, or `cursor`). `createAgent({ agent })` wins over this. |
| `PATHGRADE_CODEX_TRANSPORT` | Fallback Codex transport (`exec` or `app-server`). `createAgent({ transport })` wins over this. |
| `PATHGRADE_VERBOSE` | `1` enables live per-turn streaming to stderr |
| `PATHGRADE_DIAGNOSTICS` | `1` prints full diagnostics for passing evals too |
| `NO_COLOR` | Disable ANSI colors |

### Experimental `node:test` Adapter

`node-test` is a small proof adapter for validating the runner boundary without Vitest. It is intentionally narrow: eval files import the `test` wrapper from `@wix/pathgrade/adapters/node-test`, run through Node's built-in test runner, and still produce the normal `.pathgrade/results.json` and trace artifacts.

```ts
import { test } from '@wix/pathgrade/adapters/node-test';
import { createAgent, evaluate, check } from '@wix/pathgrade';

test('minimal node proof', async () => {
    const agent = await createAgent({ workspace: process.cwd() });
    await evaluate(agent, [check('passes', () => true)]);
});
```

Run it with:

```bash
pathgrade run --adapter=node-test
```

This proof validates Pathgrade's adapter, lifecycle, result capture, and reporting boundaries. It does not imply Mocha, Playwright, or runnerless CLI support.

`pathgrade run` loads `.env` from the working directory automatically.

## CI / GitHub Actions

Run evals on every PR and post results as a PR comment:

```yaml
jobs:
  eval:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # required for affected selection
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci

      - name: Run affected evals
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: npx pathgrade run --changed

      - name: Post PR report
        if: always()
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx pathgrade report

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: pathgrade-reports
          path: .pathgrade/
```

- `fetch-depth: 0` is required for `--changed`; shallow clones break merge-base resolution.
- Evals under a `SKILL.md` are tracked automatically; use `__pathgradeMeta` for cross-skill or non-standard dependencies.
- Set `ci: { threshold: 0.8 }` in `pathgrade.config.ts` to fail the run when the mean test score drops below your threshold.

See the [User Guide - CI Integration](docs/USER_GUIDE.md#ci-integration) for the full reference.

## Links

- [User Guide](docs/USER_GUIDE.md) - full API reference and usage patterns
- Examples:
  - [start-chat](examples/start-chat/) - multi-turn conversation
  - [sdk-showcase](examples/sdk-showcase/) - advanced SDK features in one suite
  - [tool-judge-demo](examples/tool-judge-demo/) - `judge({ tools })` reading workspace artifacts

## Note on AI provider dependencies

Pathgrade is released under the MIT license. Pathgrade can use third-party AI agent tools and SDKs to run evaluations, including `@anthropic-ai/claude-agent-sdk` for Claude, Codex CLI for Codex, and `cursor-agent` for Cursor. These tools, SDKs, hosted services, and related authentication methods are governed by their respective provider terms, which are separate from Pathgrade's MIT license.

In particular, `@anthropic-ai/claude-agent-sdk` is governed by Anthropic's Commercial Terms of Service, except where Anthropic specifies a different license for a specific component or dependency.

## License

MIT
