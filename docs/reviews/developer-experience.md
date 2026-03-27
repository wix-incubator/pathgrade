# Public API & Developer Experience Review

Reviewed: 2026-03-26
Scope: eval.ts schema, CLI UX, failure diagnostics, documentation accuracy, progressive disclosure, package exports, version handling

---

## Critical

### 1. README example, templates, and `init` prompt all omit the required `type` field

The `type` field is required on every task (enforced at both the TypeScript type level and runtime validation), but it is missing from:

- **README.md:91-117** -- the `eval.ts` Reference example has no `type` field on the task
- **templates/eval.ts.template:11-37** -- the scaffolded template has no `type` field
- **src/commands/init.ts:302-344** -- the inline fallback template (`getInlineTemplate()`) has no `type` field
- **src/commands/init.ts:178-205** -- the LLM generation prompt example has no `type` field

This means every new user who runs `pathgrade init` (without an API key), or who copies the README example, will get a config that immediately fails with:

```
Task "fix-linting-errors" is missing a "type" field. Must be 'instruction' or 'conversation'.
```

The TypeScript types (`DefineEvalTaskInput` at `src/core/config.types.ts:210`) correctly require `type`, so IDE autocompletion will catch this -- but only if the user has `@wix/pathgrade` installed locally for types. Anyone writing eval.ts by hand from the README will hit this wall.

**Suggestion**: Either add `type: 'instruction'` to all examples and templates, or (better) make it optional and default to `'instruction'` when `instruction` is present.

### 2. Workspace `dest` field is silently ignored

Users can specify `dest` in workspace mappings (e.g., `{ src: 'fixtures/broken-app.js', dest: 'app.js' }`), and the type system accepts it (`WorkspaceMapping.dest` at `src/core/config.types.ts:18`), but the actual file copy logic in `prepareTempTaskDir` ignores `dest` entirely:

```typescript
// src/commands/run.ts:307
const destInTmp = path.join(tmpDir, path.basename(w.src));
```

This uses `path.basename(w.src)` instead of `w.dest`. A user who writes `{ src: 'fixtures/broken-app.js', dest: 'app.js' }` (as shown in the README example at line 97) expects the file to appear as `app.js` in the workspace, but it will actually appear as `broken-app.js`. Absolute `dest` paths like `/usr/local/bin/superlint` (README line 98) are completely non-functional.

The `chmod` field is similarly accepted in the type but never applied.

---

## Major

### 3. `package.json` `main`/`types` conflict with `exports`

`package.json:5-6`:
```json
"main": "dist/pathgrade.js",
"types": "dist/pathgrade.d.ts",
```

`package.json:7-16`:
```json
"exports": {
  ".": {
    "types": "./dist/core/index.d.ts",
    "default": "./dist/core/index.js"
  }
}
```

The `main` field points to the CLI entry point (`dist/pathgrade.js`) while `exports["."]` points to the library entry (`dist/core/index.js`). Modern bundlers and Node.js with `exports` support will use `dist/core/index.js` (correct). But older tooling or TypeScript configs using `moduleResolution: "node"` fall back to `main`, which resolves to the CLI script -- not the library. The `types` field (`dist/pathgrade.d.ts`) points to the CLI types, not the library types, so `import { defineEval } from '@wix/pathgrade'` may show wrong types in some setups.

**Suggestion**: Set `main` to `dist/core/index.js` and `types` to `dist/core/index.d.ts` so all resolution strategies agree.

### 4. `--agent=claude` help text says "default: claude" but actual default is "gemini"

`src/pathgrade.ts:132`:
```
--agent=claude                Override agent (default: claude)
```

The actual default agent in `src/core/defaults.ts:5` is `'gemini'`. The README (line 38) correctly says the agent is auto-detected from the API key, but the help text is wrong. A developer running `pathgrade --help` will be misled.

### 5. `grader.setup` field is accepted but never executed

The `setup` field on graders is defined in the types (`src/core/config.types.ts:76`), accepted through validation (`src/core/config.ts:234`), and shown in the README example (line 103: `setup: 'npm install typescript'`). However, no code ever runs the setup commands. The comment says "runs during image build" but there is no image build -- pathgrade runs locally.

A user who adds `setup: 'npm install typescript'` will see no error but their grader dependencies will not be installed, causing silent grader failures.

**Suggestion**: Either implement setup command execution before running graders, or remove the field from the types/docs and throw a clear error if someone provides it.

### 6. `resolveFileOrInline` has ambiguous path-vs-content heuristic

`src/core/config.ts:426-439`:
```typescript
async function resolveFileOrInline(value: string, baseDir: string): Promise<string> {
    const trimmed = value.trim();
    if (trimmed.includes('\n')) return trimmed;
    const candidate = path.resolve(baseDir, trimmed);
    if (await fs.pathExists(candidate)) {
        return (await fs.readFile(candidate, 'utf-8')).trim();
    }
    return trimmed;
}
```

If a user's single-line instruction happens to match a filename that exists in their project directory (e.g., `instruction: 'test'` when a file called `test` exists), pathgrade will silently read the file contents instead of using the string literal. This applies to `instruction`, `rubric`, `run`, `opener`, reply `content`, and persona `description`. There is no escape hatch or warning, and the behavior depends on the filesystem state at resolution time.

---

## Minor

### 7. `version: '1'` is accepted but never validated or used

`src/core/config.ts:139` sets `version = config.version || '1'` and stores it in the config, but no code ever reads `config.version` after that. Passing `version: '99'` or `version: 'banana'` is silently accepted. The field adds cognitive overhead without providing value.

If versioning is planned for the future, it should at least validate against known versions: `if (version !== '1') throw new Error(...)`.

### 8. `--trials=abc` silently becomes `NaN`

`src/pathgrade.ts:79`:
```typescript
const explicitTrials = getFlag('trials') ? parseInt(getFlag('trials')!) : undefined;
```

`parseInt('abc')` returns `NaN`, which propagates through the system without validation. The same applies to `--parallel` and `--threshold`. No error message is shown.

**Suggestion**: Validate parsed numbers and show a clear error: `error: --trials must be a positive integer, got "abc"`.

### 9. README uses `skill` but the actual field name is `skillPath`

README.md:80:
```typescript
// skill: 'path/to/my-skill',
```

The actual property name in `DefineEvalInput` is `skillPath` (`src/core/config.types.ts:214`). A user copying this commented-out example and uncommenting it will get a TypeScript error (if using types) or the field will be silently ignored at runtime.

### 10. Missing API key produces no actionable guidance when running evals

When a user runs `pathgrade` without any API key set, the error surfaces deep in the agent creation or LLM call layer. The CLI entry point (`src/pathgrade.ts`) does not check for API keys upfront. Compare with `pathgrade init` which at least prints "Install Claude CLI or set an API key..." (`src/commands/init.ts:82`).

The `run` command should detect missing credentials early and print a message like:
```
error: No agent credentials found.
Set GEMINI_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY to run evals.
```

### 11. `pathgrade preview` with no prior results gives an opaque message

`src/reporters/cli.ts:14`:
```typescript
console.log(`\n  No reports found in ${resolved}\n`);
```

This prints the raw temp directory path (e.g., `/var/folders/.../pathgrade/my-skill/results`) without context. A better message would suggest running evals first: `"No reports found. Run pathgrade first to generate results."`.

### 12. Grader error vs agent failure indistinguishable in output

When a deterministic grader fails to produce JSON, the output at `src/graders/index.ts:46` is:
```
Grader did not output JSON. stdout: (empty) stderr: (empty)
```

This appears in the trial results the same way a score of 0 from a correctly-functioning grader would (reward=0, FAIL). The user has no clear signal that the grader itself is broken vs. the agent failing the task. Consider prefixing infrastructure errors distinctly (e.g., `[grader error]`) or using a different status like `ERROR` instead of `FAIL`.

### 13. Browser preview server never closes

`src/reporters/browser.ts` starts an HTTP server that never gets a shutdown signal. The process will hang after `pathgrade preview browser`. There is no "press Ctrl+C to stop" message or automatic browser opening. The user sees the URL printed but must know to manually open it and then Ctrl+C when done.

---

## Nits

### 14. Inconsistent naming: `eval` vs `task` across the codebase

The CLI uses `--eval=NAME` and `pathgrade <eval-name>`, but the config schema uses `tasks: [...]`, code variables use `tasksToRun`, and error messages mix both: `eval "fix-linting" not found` (line 86 of run.ts) vs `task "foo" has no solution defined` (line 155). The deprecated `--task` flag adds to the confusion. Picking one term consistently would reduce cognitive load.

### 15. `pass_rate` is actually `mean_reward`, not a pass rate

`src/evalRunner.ts:128`:
```typescript
pass_rate: totalReward / numTrials,
```

This divides total reward (sum of weighted scores) by trial count. A true "pass rate" would be `successes / numTrials` where success is a binary determination. If trials score 0.3, 0.4, 0.3, the "pass_rate" would be 0.33 (mean reward) but the actual pass rate (reward >= 0.5) would be 0.0. The CLI output label "Pass Rate" (`src/utils/cli.ts:69`) is misleading.

### 16. The `@wix/pathgrade/config` export path is unused

`package.json:12-15` exports `@wix/pathgrade/config` pointing to `define-eval.js`, but the README and all templates import `defineEval` from `@wix/pathgrade` (the main export at `src/core/index.ts:1`), which already re-exports `defineEval`. The `/config` subpath is undocumented and redundant.

### 17. `--smoke` / `--reliable` / `--regression` names don't describe what they do

Without reading the help or README, a user might wonder: "smoke for what? reliable how?" The flag names describe the *use case* but not the *behavior*. The help text (`src/pathgrade.ts:123-125`) does explain them, which helps, but the preset names could be more self-describing (e.g., `--quick`, `--standard`, `--thorough`). This is a very subjective nit.

### 18. `grader_model` default is not set in `DEFAULT_CONFIG`

`src/core/defaults.ts` does not include `grader_model`, so its default is `undefined`. The README example at line 87 shows `grader_model: 'gemini-3-flash-preview'` as if it were a default, but it is not -- you must specify it explicitly or rely on the LLM utility's provider auto-detection. This is not necessarily wrong, but the README gives the impression it is a built-in default.
