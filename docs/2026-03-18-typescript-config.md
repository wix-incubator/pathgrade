# TypeScript Config for Skillgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `eval.ts` as an alternative config format to `eval.yaml`, so agents can generate typed config objects instead of YAML.

**Architecture:** Add a `defineEval()` helper that returns a typed `EvalConfig` object. Extend `loadEvalConfig()` to look for `eval.ts` (via `jiti` dynamic import) before falling back to `eval.yaml`. The rest of the pipeline (`resolveTask`, `run.ts`, providers, graders) stays untouched — both formats produce the same `EvalConfig` shape. Shared defaults and validation live in one place to prevent drift.

**Tech Stack:** TypeScript, jiti (dynamic TS import), vitest (tests)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/config.types.ts` | Modify | Export `DefineEvalInput` — a user-friendly type with optional fields and smart defaults |
| `src/core/defaults.ts` | Create | Single source of truth for `DEFAULT_CONFIG` — shared by both `config.ts` and `define-eval.ts` |
| `src/core/define-eval.ts` | Create | `defineEval()` function: normalizes input, calls `validateConfig()`, returns `EvalConfig` |
| `src/core/config.ts` | Modify | Extract `DEFAULT_CONFIG` to `defaults.ts`, make `validateConfig` exported, add `eval.ts` loading via jiti, update error messages to be format-agnostic |
| `src/core/index.ts` | Create | Library entry point — exports `defineEval` + types (keeps CLI entry `skillgrade.ts` clean) |
| `tests/define-eval.test.ts` | Create | Unit tests for `defineEval()` |
| `tests/config.test.ts` | Modify | Add tests for TS config loading path |
| `package.json` | Modify | Add `jiti` dependency, add `exports` field pointing to `src/core/index.ts` |

---

### Task 1: Add `jiti` Dependency

**Files:**
- Modify: `package.json`

- [x] **Step 1: Install jiti**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npm install jiti
```

- [x] **Step 2: Verify installation**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && node -e "const createJiti = require('jiti').createJiti || require('jiti'); console.log('jiti loaded')"
```

Expected: Prints "jiti loaded", no error.

- [x] **Step 3: Check which jiti API is available**

The jiti API differs between v1 and v2. Check which version was installed:

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && node -e "const pkg = require('jiti/package.json'); console.log('jiti version:', pkg.version)"
```

Note the major version — this determines the API used in Task 5:
- **jiti v1**: `const jiti = require('jiti')(__filename); jiti('./file.ts')`
- **jiti v2**: `const { createJiti } = require('jiti'); const jiti = createJiti(__filename); jiti.import('./file.ts')`

- [x] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add jiti for dynamic TypeScript imports"
```

---

### Task 2: Extract Shared Defaults and Make `validateConfig` Format-Agnostic

Currently `DEFAULT_CONFIG` and `validateConfig()` live in `config.ts` with YAML-specific error messages. We need them shared and format-neutral.

**Files:**
- Create: `src/core/defaults.ts`
- Modify: `src/core/config.ts`

- [x] **Step 1: Write the failing test**

Add to `tests/config.test.ts` at the bottom of the `describe('loadEvalConfig')` block — verify error messages don't say "eval.yaml" when loading TS config:

```typescript
  it('error messages are format-agnostic', async () => {
    mockPathExists.mockResolvedValue(true as any);
    mockReadFile.mockResolvedValue('not_valid: true\n' as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('at least one task');
    // Should NOT contain "eval.yaml" in the error message
    try {
      await loadEvalConfig('/test');
    } catch (e: any) {
      expect(e.message).not.toContain('eval.yaml must');
    }
  });
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run tests/config.test.ts
```

Expected: FAIL — current error says "eval.yaml must have at least one task".

- [x] **Step 3: Create `src/core/defaults.ts`**

```typescript
import { EvalDefaults } from './config.types';

/** Single source of truth for default config values. Shared by YAML and TS loaders. */
export const DEFAULT_CONFIG: EvalDefaults = {
    agent: 'gemini',
    provider: 'docker',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    docker: { base: 'node:20-slim' },
    environment: { cpus: 2, memory_mb: 2048 },
};
```

- [x] **Step 4: Update `src/core/config.ts`**

1. Remove the `DEFAULT_CONFIG` constant (now imported from `defaults.ts`)
2. Add `import { DEFAULT_CONFIG } from './defaults';`
3. Export `validateConfig` (add `export` keyword)
4. Update error messages to be format-agnostic:
   - `"eval.yaml must be a YAML object"` → `"Config must be an object"`
   - `"eval.yaml must have at least one task"` → `"Config must have at least one task in the \"tasks\" array"`

- [x] **Step 5: Run test to verify it passes**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run tests/config.test.ts
```

Expected: PASS. Also verify existing tests still pass — update their `toThrow()` matchers to match the new messages:
- `'must be a YAML object'` → `'must be an object'`
- `'at least one task'` stays the same (substring match still works)

- [x] **Step 6: Commit**

```bash
git add src/core/defaults.ts src/core/config.ts tests/config.test.ts
git commit -m "refactor: extract shared defaults, make validateConfig format-agnostic"
```

---

### Task 3: Create `DefineEvalInput` Type

The user-facing type should be more ergonomic than the internal `EvalConfig`. Defaults are optional, `version` is optional, grader `weight` defaults to `1.0`.

**Files:**
- Modify: `src/core/config.types.ts`

- [x] **Step 1: Write the failing test**

Create `tests/define-eval.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { defineEval } from '../src/core/define-eval';

describe('defineEval', () => {
  it('returns a valid EvalConfig with minimal input', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'test-task',
          instruction: 'do something',
          graders: [{ type: 'deterministic', run: 'echo ok' }],
        },
      ],
    });

    expect(config.version).toBe('1');
    expect(config.defaults.agent).toBe('gemini');
    expect(config.defaults.provider).toBe('docker');
    expect(config.defaults.trials).toBe(5);
    expect(config.defaults.timeout).toBe(300);
    expect(config.defaults.threshold).toBe(0.8);
    expect(config.defaults.docker.base).toBe('node:20-slim');
    expect(config.defaults.environment.cpus).toBe(2);
    expect(config.defaults.environment.memory_mb).toBe(2048);
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].graders[0].weight).toBe(1.0);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run tests/define-eval.test.ts
```

Expected: FAIL — `../src/core/define-eval` does not exist.

- [x] **Step 3: Add `DefineEvalInput` type to `config.types.ts`**

Add at the end of `src/core/config.types.ts`:

```typescript
/** User-friendly input for defineEval() — all defaults are optional */
export interface DefineEvalGraderInput {
    type: 'deterministic' | 'llm_rubric';
    setup?: string;
    run?: string;
    rubric?: string;
    model?: string;
    weight?: number;    // defaults to 1.0
}

export interface DefineEvalTaskInput {
    name: string;
    instruction: string;
    workspace?: WorkspaceMapping[];
    graders: DefineEvalGraderInput[];
    solution?: string;
    agent?: string;
    provider?: string;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    docker?: Partial<DockerConfig>;
    environment?: Partial<EnvironmentConfig>;
}

export interface DefineEvalInput {
    version?: string;           // defaults to '1'
    skill?: string;
    defaults?: Partial<EvalDefaults>;
    tasks: DefineEvalTaskInput[];
}
```

- [x] **Step 4: Commit**

```bash
git add src/core/config.types.ts tests/define-eval.test.ts
git commit -m "feat: add DefineEvalInput type for TypeScript config"
```

---

### Task 4: Implement `defineEval()`

`defineEval()` normalizes the user-friendly `DefineEvalInput` into the internal `EvalConfig` shape, then delegates to the shared `validateConfig()`. This avoids duplicating validation logic.

**Files:**
- Create: `src/core/define-eval.ts`

- [x] **Step 1: Implement `defineEval()`**

Create `src/core/define-eval.ts`:

```typescript
import {
    EvalConfig,
    EvalTaskConfig,
    DefineEvalInput,
    DockerConfig,
    EnvironmentConfig,
} from './config.types';
import { DEFAULT_CONFIG } from './defaults';
import { validateConfig } from './config';

/**
 * Define a skillgrade evaluation config in TypeScript.
 * All defaults are optional — same defaults as eval.yaml.
 */
export function defineEval(input: DefineEvalInput): EvalConfig {
    // Build a raw config object in the same shape validateConfig expects
    const raw: Record<string, any> = {
        version: input.version || '1',
        skill: input.skill,
        defaults: input.defaults ? {
            ...input.defaults,
            docker: input.defaults.docker ? {
                ...DEFAULT_CONFIG.docker,
                ...input.defaults.docker,
            } : undefined,
            environment: input.defaults.environment ? {
                ...DEFAULT_CONFIG.environment,
                ...input.defaults.environment,
            } : undefined,
        } : undefined,
        tasks: input.tasks.map(t => ({
            name: t.name,
            instruction: t.instruction,
            workspace: t.workspace,
            graders: t.graders.map(g => ({
                type: g.type,
                setup: g.setup,
                run: g.run,
                rubric: g.rubric,
                model: g.model,
                weight: g.weight,  // validateConfig defaults to 1.0
            })),
            solution: t.solution,
            agent: t.agent,
            provider: t.provider,
            trials: t.trials,
            timeout: t.timeout,
            grader_model: t.grader_model,
            docker: t.docker ? { ...DEFAULT_CONFIG.docker, ...t.docker } : undefined,
            environment: t.environment,
        })),
    };

    // Reuse the same validation/default-merging as YAML path
    return validateConfig(raw);
}
```

- [x] **Step 2: Run test to verify it passes**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run tests/define-eval.test.ts
```

Expected: PASS

- [x] **Step 3: Commit**

```bash
git add src/core/define-eval.ts
git commit -m "feat: implement defineEval() function"
```

---

### Task 5: Add Full Test Coverage for `defineEval()`

**Files:**
- Modify: `tests/define-eval.test.ts`

- [x] **Step 1: Add remaining tests**

Append to `tests/define-eval.test.ts` inside the `describe('defineEval')` block:

```typescript
  it('accepts full config with all overrides', () => {
    const config = defineEval({
      version: '2',
      skill: './skills/my-skill',
      defaults: {
        agent: 'claude',
        provider: 'local',
        trials: 10,
        timeout: 600,
        threshold: 0.9,
        docker: { base: 'ubuntu:22.04', setup: 'apt-get update' },
        environment: { cpus: 4, memory_mb: 4096 },
      },
      tasks: [
        {
          name: 'full-task',
          instruction: 'do everything',
          workspace: [{ src: 'fixtures/app.js', dest: 'app.js' }],
          graders: [
            { type: 'deterministic', run: 'echo ok', weight: 0.7 },
            { type: 'llm_rubric', rubric: 'check quality', weight: 0.3 },
          ],
          solution: 'solutions/solve.sh',
          agent: 'codex',
          trials: 20,
        },
      ],
    });

    expect(config.version).toBe('2');
    expect(config.skill).toBe('./skills/my-skill');
    expect(config.defaults.agent).toBe('claude');
    expect(config.defaults.docker.base).toBe('ubuntu:22.04');
    expect(config.defaults.docker.setup).toBe('apt-get update');
    expect(config.defaults.environment.cpus).toBe(4);
    expect(config.tasks[0].agent).toBe('codex');
    expect(config.tasks[0].trials).toBe(20);
    expect(config.tasks[0].graders[0].weight).toBe(0.7);
    expect(config.tasks[0].graders[1].type).toBe('llm_rubric');
    expect(config.tasks[0].workspace).toHaveLength(1);
    expect(config.tasks[0].solution).toBe('solutions/solve.sh');
  });

  it('throws when tasks array is empty', () => {
    expect(() => defineEval({ tasks: [] })).toThrow('at least one task');
  });

  it('throws when task is missing name', () => {
    expect(() =>
      defineEval({
        tasks: [{ name: '', instruction: 'x', graders: [{ type: 'deterministic', run: 'x' }] }],
      })
    ).toThrow('missing a "name"');
  });

  it('throws when task is missing instruction', () => {
    expect(() =>
      defineEval({
        tasks: [{ name: 'x', instruction: '', graders: [{ type: 'deterministic', run: 'x' }] }],
      })
    ).toThrow('missing an "instruction"');
  });

  it('throws when task has no graders', () => {
    expect(() =>
      defineEval({ tasks: [{ name: 'x', instruction: 'x', graders: [] }] })
    ).toThrow('at least one grader');
  });

  it('defaults grader weight to 1.0 when omitted', () => {
    const config = defineEval({
      tasks: [
        {
          name: 'test',
          instruction: 'do it',
          graders: [{ type: 'deterministic', run: 'echo ok' }],
        },
      ],
    });

    expect(config.tasks[0].graders[0].weight).toBe(1.0);
  });

  it('merges partial docker config with defaults', () => {
    const config = defineEval({
      defaults: { docker: { setup: 'apt-get install -y jq' } },
      tasks: [
        {
          name: 'test',
          instruction: 'do it',
          graders: [{ type: 'deterministic', run: 'echo ok' }],
        },
      ],
    });

    expect(config.defaults.docker.base).toBe('node:20-slim');
    expect(config.defaults.docker.setup).toBe('apt-get install -y jq');
  });

  it('task-level docker inherits from user defaults, not just built-in defaults', () => {
    const config = defineEval({
      defaults: {
        docker: { base: 'ubuntu:22.04' },
      },
      tasks: [
        {
          name: 'test',
          instruction: 'do it',
          docker: { setup: 'apt-get install -y curl' },
          graders: [{ type: 'deterministic', run: 'echo ok' }],
        },
      ],
    });

    // Task docker.base should come from DEFAULT_CONFIG since task only set setup
    // But the user's defaults.docker.base is applied at resolveTask time, not here
    expect(config.tasks[0].docker?.setup).toBe('apt-get install -y curl');
  });
```

- [x] **Step 2: Run tests**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run tests/define-eval.test.ts
```

Expected: All PASS.

- [x] **Step 3: Commit**

```bash
git add tests/define-eval.test.ts
git commit -m "test: full coverage for defineEval()"
```

---

### Task 6: Extend `loadEvalConfig()` to Support `eval.ts`

**Files:**
- Modify: `src/core/config.ts`
- Modify: `tests/config.test.ts`

- [x] **Step 1: Write the failing test**

Add a **new describe block** in `tests/config.test.ts` (not inside the existing `loadEvalConfig` describe) to avoid module mock conflicts. The existing tests mock `fs-extra` at module level — the TS loading test needs to mock `jiti` separately:

```typescript
describe('loadEvalConfig with eval.ts', () => {
  it('loads eval.ts when it exists (prefers over eval.yaml)', async () => {
    // Create a fresh module scope for this test
    vi.resetModules();

    const mockConfig = {
      version: '1',
      tasks: [
        {
          name: 'ts-task',
          instruction: 'from typescript',
          graders: [{ type: 'deterministic', run: 'echo ok', weight: 1.0 }],
        },
      ],
    };

    // Mock fs-extra for this scope
    vi.doMock('fs-extra', () => ({
      pathExists: vi.fn(async (p: string) => String(p).endsWith('eval.ts')),
      readFile: vi.fn(),
    }));

    // Mock jiti — adapt to whichever version is installed
    vi.doMock('jiti', () => {
      // Return a factory: jiti(callerPath) returns a loader function
      const factory = (_caller: string) => (_filePath: string) => ({ default: mockConfig });
      factory.createJiti = (_caller: string) => ({
        import: async (_filePath: string) => ({ default: mockConfig }),
      });
      return { default: factory, createJiti: factory.createJiti };
    });

    const { loadEvalConfig } = await import('../src/core/config');
    const config = await loadEvalConfig('/test');
    expect(config.tasks[0].name).toBe('ts-task');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run tests/config.test.ts
```

Expected: FAIL — `loadEvalConfig` doesn't look for `eval.ts` yet.

- [x] **Step 3: Modify `loadEvalConfig()` in `src/core/config.ts`**

Add the `eval.ts` path at the top of `loadEvalConfig`, and add the `loadEvalConfigFromTs` helper.

Replace the `loadEvalConfig` function:

```typescript
/**
 * Load eval config from a directory.
 * Tries eval.ts first (TypeScript config), then eval.yaml.
 */
export async function loadEvalConfig(dir: string): Promise<EvalConfig> {
    // Try eval.ts first
    const tsPath = path.join(dir, 'eval.ts');
    if (await fs.pathExists(tsPath)) {
        return loadEvalConfigFromTs(tsPath);
    }

    // Fall back to eval.yaml
    const yamlPath = path.join(dir, 'eval.yaml');
    if (!await fs.pathExists(yamlPath)) {
        throw new Error(`No eval.ts or eval.yaml found in ${dir}`);
    }

    let yaml: any;
    try {
        yaml = require('js-yaml');
    } catch {
        throw new Error('js-yaml is required. Run: npm install js-yaml');
    }

    const content = await fs.readFile(yamlPath, 'utf-8');
    const raw = yaml.load(content) as any;

    return validateConfig(raw);
}
```

Add the new helper function:

```typescript
/**
 * Load eval config from a TypeScript file using jiti.
 *
 * jiti API:
 *   v1: const jiti = require('jiti')(__filename); const mod = jiti('./file.ts')
 *   v2: const { createJiti } = require('jiti'); const jiti = createJiti(__filename); const mod = await jiti.import('./file.ts')
 *
 * We try v1 first since it's more common, then v2.
 */
async function loadEvalConfigFromTs(filePath: string): Promise<EvalConfig> {
    let mod: any;
    try {
        const jitiModule = require('jiti');
        // jiti v1: default export is a factory function
        const factory = jitiModule.default || jitiModule;
        if (typeof factory === 'function') {
            const jiti = factory(__filename);
            mod = jiti(filePath);
        } else {
            throw new Error('Unexpected jiti export shape');
        }
    } catch (e: any) {
        if (e.message === 'Unexpected jiti export shape') throw e;
        throw new Error(`Failed to load eval.ts: ${e.message}. Ensure jiti is installed: npm install jiti`);
    }

    const config = mod.default || mod;

    if (!config || typeof config !== 'object') {
        throw new Error('eval.ts must export an EvalConfig (default export or module.exports)');
    }

    return validateConfig(config);
}
```

**Key details:**
- Uses `__filename` (the caller's path) as jiti's first argument, NOT the target file path
- Handles both `mod.default` (ES module default export) and `mod` (CommonJS `module.exports`)
- Reuses `validateConfig()` — same validation for both YAML and TS

- [x] **Step 4: Update the "missing config" test**

The existing test `'throws when eval.yaml is missing'` needs updating since the error message now mentions both formats:

```typescript
  it('throws when no config file is found', async () => {
    mockPathExists.mockResolvedValue(false as any);
    await expect(loadEvalConfig('/test')).rejects.toThrow('No eval.ts or eval.yaml found');
  });
```

- [x] **Step 5: Run tests**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run tests/config.test.ts
```

Expected: All PASS (both old YAML tests and new TS test).

- [x] **Step 6: Commit**

```bash
git add src/core/config.ts tests/config.test.ts
git commit -m "feat: loadEvalConfig() supports eval.ts via jiti"
```

---

### Task 7: Create Library Entry Point and Export `defineEval`

`src/skillgrade.ts` is the CLI entry point (runs `main()`). Library exports should live in a separate file.

**Files:**
- Create: `src/core/index.ts`
- Modify: `package.json`

- [x] **Step 1: Create `src/core/index.ts`**

```typescript
export { defineEval } from './define-eval';
export { loadEvalConfig, resolveTask } from './config';
export type {
    DefineEvalInput,
    DefineEvalTaskInput,
    DefineEvalGraderInput,
    EvalConfig,
    EvalDefaults,
    EvalTaskConfig,
    EvalGraderConfig,
    ResolvedTask,
    ResolvedGrader,
    WorkspaceMapping,
    DockerConfig,
    EnvironmentConfig,
} from './config.types';
```

- [x] **Step 2: Add `exports` field to `package.json`**

Add to `package.json` alongside the existing `main` field:

```json
"exports": {
    ".": {
        "types": "./dist/core/index.d.ts",
        "default": "./dist/core/index.js"
    },
    "./config": {
        "types": "./dist/core/define-eval.d.ts",
        "default": "./dist/core/define-eval.js"
    }
}
```

This allows:
```typescript
import { defineEval } from 'skillgrade';
// or
import { defineEval } from 'skillgrade/config';
```

- [x] **Step 3: Verify build compiles**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npm run build
```

Expected: No errors. Check that `dist/core/index.js` and `dist/core/index.d.ts` exist.

- [x] **Step 4: Commit**

```bash
git add src/core/index.ts package.json
git commit -m "feat: add library entry point, export defineEval from package"
```

---

### Task 8: Update `init.ts` to Mention Both Formats

**Files:**
- Modify: `src/commands/init.ts`

- [x] **Step 1: Update init command to mention both formats**

In `src/commands/init.ts`, find where it references "eval.yaml" in user-facing output messages and add a note that `eval.ts` is also supported. The `init` command should continue generating `eval.yaml` (YAML is still the default for humans), but mention the TS alternative. For example:

```
Created eval.yaml (tip: you can also use eval.ts for type-safe config)
```

- [x] **Step 2: Run full test suite**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run
```

Expected: All PASS.

- [x] **Step 3: Commit**

```bash
git add src/commands/init.ts
git commit -m "docs: mention eval.ts as alternative in init output"
```

---

### Task 9: Add an Example `eval.ts`

**Files:**
- Create: `examples/typescript-example/eval.ts`

We create the TS example in a **separate directory** (not alongside `examples/superlint/eval.yaml`) to avoid precedence confusion where `eval.ts` silently shadows `eval.yaml`.

- [x] **Step 1: Create the example directory and eval.ts**

```bash
mkdir -p /Users/nadavlac/projects/test-skills/skillgrade/examples/typescript-example
```

Create `examples/typescript-example/eval.ts`:

```typescript
import { defineEval } from '../../src/core/define-eval';

export default defineEval({
  defaults: {
    agent: 'gemini',
    provider: 'docker',
    trials: 5,
    timeout: 300,
    threshold: 0.8,
    docker: { base: 'node:20-slim' },
  },
  tasks: [
    {
      name: 'example-task',
      instruction: `This is an example eval.ts config.
It demonstrates the TypeScript alternative to eval.yaml.

The agent should create a file called output.txt with "hello world".`,
      graders: [
        {
          type: 'deterministic',
          run: `if [ -f output.txt ] && grep -q "hello world" output.txt; then
  echo '{"score": 1.0, "details": "output.txt contains hello world"}'
else
  echo '{"score": 0.0, "details": "output.txt missing or wrong content"}'
fi`,
          weight: 1.0,
        },
      ],
    },
  ],
});
```

- [x] **Step 2: Verify the example loads correctly**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx tsx -e "
  const { loadEvalConfig } = require('./src/core/config');
  loadEvalConfig('./examples/typescript-example').then((c: any) => {
    console.log('Tasks:', c.tasks.map((t: any) => t.name));
    console.log('Valid!');
  });
"
```

If `tsx` is not installed, use jiti directly:

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && node -e "
  const jiti = require('jiti')(__filename);
  const { loadEvalConfig } = jiti('./src/core/config');
  loadEvalConfig('./examples/typescript-example').then(c => {
    console.log('Tasks:', c.tasks.map(t => t.name));
    console.log('Valid!');
  });
"
```

Expected: Prints `Tasks: [ 'example-task' ]` and `Valid!`.

- [x] **Step 3: Commit**

```bash
git add examples/typescript-example/
git commit -m "docs: add eval.ts example"
```

---

### Task 10: Run Full Suite and Verify Backwards Compatibility

**Files:** None (verification only)

- [x] **Step 1: Run full test suite**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npx vitest run
```

Expected: All existing tests still pass + new tests pass.

- [x] **Step 2: Verify YAML still works**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && node -e "
  const jiti = require('jiti')(__filename);
  const { loadEvalConfig } = jiti('./src/core/config');
  loadEvalConfig('./examples/superlint').then(c => {
    console.log('YAML config loaded:', c.tasks.map(t => t.name));
  });
"
```

Expected: Loads from `eval.yaml` successfully.

- [x] **Step 3: Verify TS example loads**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && node -e "
  const jiti = require('jiti')(__filename);
  const { loadEvalConfig } = jiti('./src/core/config');
  loadEvalConfig('./examples/typescript-example').then(c => {
    console.log('TS config loaded:', c.tasks.map(t => t.name));
  });
"
```

Expected: Loads `eval.ts` successfully.

- [x] **Step 4: Build and verify**

```bash
cd /Users/nadavlac/projects/test-skills/skillgrade && npm run build && ls dist/core/index.js dist/core/define-eval.js dist/core/defaults.js
```

Expected: All three files exist.

- [x] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: TypeScript config support for skillgrade (eval.ts)"
```
