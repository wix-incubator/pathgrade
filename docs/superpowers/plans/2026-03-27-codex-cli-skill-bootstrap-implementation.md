# Codex CLI Skill Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PathGrade-owned Codex bootstrap so `pathgrade --agent=codex` discovers repo-local skills through staged workspace files and a generated `AGENTS.md`, with the same discovery behavior in isolated and host-auth modes.

**Architecture:** Keep `detectSkills()` as the source of truth, stage detected skills into a neutral workspace-owned directory, and generate provider-facing instruction files from shared skill metadata. Preserve the existing Claude bootstrap, add Codex `AGENTS.md` composition against staged skill paths, and keep the change contained to local-provider setup plus docs/tests.

**Tech Stack:** TypeScript, Node.js, fs-extra, vitest

---

## File Structure

**Create:**
- `src/providers/skill-bootstrap.ts` — parse skill metadata, stage skills into workspace paths, render `CLAUDE.md`, and compose a PathGrade-managed `AGENTS.md` section

**Modify:**
- `src/providers/local.ts:18-123` — replace inline bootstrap logic with shared helper calls and emit Codex-facing assets
- `tests/providers.local.test.ts:47-116` — assert staged skill paths, generated `AGENTS.md`, and no-skill behavior
- `tests/local-provider-auth.test.ts:33-73` — assert the Codex bootstrap exists in both isolated and host-auth modes
- `README.md:13-48` — document Codex bootstrap behavior and clarify that auth mode does not change skill discovery

---

### Task 1: Add Shared Skill Bootstrap Helpers

**Files:**
- Create: `src/providers/skill-bootstrap.ts`
- Test: `tests/providers.local.test.ts`

- [ ] **Step 1: Write failing provider bootstrap tests**

In `tests/providers.local.test.ts`, add coverage that checks:

```typescript
it('stages detected skills into .pathgrade/skills for provider-neutral bootstrap', async () => {
  const runtime = await provider.setup(taskDir, [skillDir], setupOpts);
  const stagedPath = path.join(runtime.workspacePath, '.pathgrade', 'skills', path.basename(skillDir), 'SKILL.md');
  expect(await fsExtra.pathExists(stagedPath)).toBe(true);
});

it('generates AGENTS.md with a PathGrade-managed Codex section that points to staged skills', async () => {
  const content = await fsExtra.readFile(path.join(runtime.workspacePath, 'AGENTS.md'), 'utf-8');
  expect(content).toContain('PathGrade-managed skill bootstrap');
  expect(content).toContain('.pathgrade/skills/');
  expect(content).toContain('my-skill');
});

it('preserves existing AGENTS.md content when composing PathGrade instructions', async () => {
  await fsExtra.writeFile(path.join(taskDir, 'AGENTS.md'), '# Existing repo instructions');
  const content = await fsExtra.readFile(path.join(runtime.workspacePath, 'AGENTS.md'), 'utf-8');
  expect(content).toContain('# Existing repo instructions');
  expect(content).toContain('PathGrade-managed skill bootstrap');
});
```

- [ ] **Step 2: Run the focused provider tests and verify they fail**

Run: `npx vitest run tests/providers.local.test.ts -t "stages detected skills|generates AGENTS.md|preserves existing AGENTS.md"`
Expected: FAIL because `LocalProvider` does not stage `.pathgrade/skills` or generate/combine `AGENTS.md`

- [ ] **Step 3: Implement shared skill bootstrap helpers**

Create `src/providers/skill-bootstrap.ts` with focused helpers like:

```typescript
export interface SkillDescriptor {
  directoryName: string;
  displayName: string;
  description: string;
  sourcePath: string;
}

export async function readSkillDescriptors(skillsPaths: string[]): Promise<SkillDescriptor[]> {
  // parse SKILL.md frontmatter, fall back to basename
}

export async function stageSkills(
  workspacePath: string,
  targetDir: string,
  skillsPaths: string[],
): Promise<SkillDescriptor[]> {
  // copy each skill into workspace-owned bootstrap directories
}

export function buildClaudeMd(skills: SkillDescriptor[]): string | null {
  // keep current Claude instructions, now driven from shared descriptors
}

export function composeAgentsMd(existingContent: string | null, skills: SkillDescriptor[]): string | null {
  // append a clearly delimited PathGrade-managed section that references .pathgrade/skills/*
}
```

- [ ] **Step 4: Run the focused provider tests and verify they pass**

Run: `npx vitest run tests/providers.local.test.ts -t "stages detected skills|generates AGENTS.md|preserves existing AGENTS.md"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/skill-bootstrap.ts tests/providers.local.test.ts
git commit -m "feat(provider): add shared skill bootstrap helpers"
```

---

### Task 2: Refactor LocalProvider To Materialize Codex Bootstrap

**Files:**
- Modify: `src/providers/local.ts:18-123`
- Test: `tests/providers.local.test.ts`
- Test: `tests/local-provider-auth.test.ts`

- [ ] **Step 1: Write failing auth-mode parity tests**

In `tests/local-provider-auth.test.ts`, add assertions like:

```typescript
it('materializes the same Codex bootstrap files in host auth mode', async () => {
  const runtime = await provider.setup(taskDir, [skillDir], { ...baseOpts, authMode: 'host' });
  expect(await fsExtra.pathExists(path.join(runtime.workspacePath, '.pathgrade', 'skills', path.basename(skillDir), 'SKILL.md'))).toBe(true);
  expect(await fsExtra.pathExists(path.join(runtime.workspacePath, 'AGENTS.md'))).toBe(true);
});

it('materializes the same Codex bootstrap files in isolated mode', async () => {
  const runtime = await provider.setup(taskDir, [skillDir], { ...baseOpts, authMode: 'isolated' });
  expect(await fsExtra.pathExists(path.join(runtime.workspacePath, '.pathgrade', 'skills', path.basename(skillDir), 'SKILL.md'))).toBe(true);
  expect(await fsExtra.pathExists(path.join(runtime.workspacePath, 'AGENTS.md'))).toBe(true);
});
```

- [ ] **Step 2: Run the local-provider suites and verify they fail**

Run: `npx vitest run tests/providers.local.test.ts tests/local-provider-auth.test.ts`
Expected: FAIL because the new Codex bootstrap is not emitted yet

- [ ] **Step 3: Replace inline bootstrap logic in LocalProvider with shared helper calls**

In `src/providers/local.ts`, refactor setup so it:

```typescript
await fs.copy(taskPath, workspacePath);

const stagedSkills = await stageSkills(workspacePath, path.join('.pathgrade', 'skills'), skillsPaths);
await stageSkills(workspacePath, path.join('.agents', 'skills'), skillsPaths);
await stageSkills(workspacePath, path.join('.claude', 'skills'), skillsPaths);

const claudeMd = buildClaudeMd(stagedSkills);
if (claudeMd) await fs.writeFile(path.join(workspacePath, 'CLAUDE.md'), claudeMd);

const agentsPath = path.join(workspacePath, 'AGENTS.md');
const existingAgents = await fs.pathExists(agentsPath)
  ? await fs.readFile(agentsPath, 'utf-8')
  : null;
const agentsMd = composeAgentsMd(existingAgents, stagedSkills);
if (agentsMd) await fs.writeFile(agentsPath, agentsMd);
```

Keep the auth-mode branch behavior unchanged except for the fact that both branches now inherit the same workspace bootstrap assets.

- [ ] **Step 4: Run the local-provider suites and verify they pass**

Run: `npx vitest run tests/providers.local.test.ts tests/local-provider-auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/providers/local.ts tests/providers.local.test.ts tests/local-provider-auth.test.ts
git commit -m "feat(codex): bootstrap trial-local AGENTS skill discovery"
```

---

### Task 3: Document The Codex Bootstrap Contract

**Files:**
- Modify: `README.md:13-48`
- Test: `tests/providers.local.test.ts`
- Test: `tests/local-provider-auth.test.ts`

- [ ] **Step 1: Write the README updates**

In `README.md`, add concise documentation that:

- Codex is supported as a local execution agent
- PathGrade stages detected skills into the trial workspace for Codex runs
- PathGrade generates a trial `AGENTS.md` section so Codex can find staged skills
- auth mode affects credentials, not whether PathGrade-managed skills are discoverable

Example wording:

```md
For Claude and Codex runs, PathGrade bootstraps trial-local instruction files automatically.
Claude receives `CLAUDE.md` plus `.claude/skills/`.
Codex receives a composed root `AGENTS.md` section pointing at staged skills under `.pathgrade/skills/`.
```

- [ ] **Step 2: Run the regression suite for bootstrap behavior**

Run: `npx vitest run tests/providers.local.test.ts tests/local-provider-auth.test.ts`
Expected: PASS

- [ ] **Step 3: Run the full test suite or the nearest practical subset**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document codex skill bootstrap behavior"
```
