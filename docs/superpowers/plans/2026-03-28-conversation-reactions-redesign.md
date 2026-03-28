# Conversation Reactions Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the implicit 3-tier reply system (pattern-matched → ordered queue → persona) with explicit, reusable reactions — every reply has a `when` pattern, reactions are reusable by default, and the config reads as "when X happens, reply with Y."

**Architecture:** Remove `ReplyPool` (ordered queue + consumed pattern replies) from `conversationRunner.ts`, replace with a flat `CompiledReaction[]` array where each entry has a compiled `RegExp`, a `reply` string, and an optional `once` flag. The `pickReaction()` function finds the first matching reaction (skipping `once`-reactions already used), returning `'reaction'` as the source. Types, validation, config resolution, tests, and example evals all update to match.

**Tech Stack:** TypeScript, vitest

**Commit strategy:** Per-task commits are local TDD checkpoints. Intermediate commits between Task 1 and Task 6 leave the codebase in a non-compiling state (types renamed before all consumers updated). Squash into compilable units before pushing to remote or opening a PR.

---

## File Structure

**Modify:**
- `src/core/config.types.ts:31-34,59-65,67-70,77-83,181-187` — replace `ConversationReplyConfig` / `ResolvedConversationReply` with reaction equivalents, update `ConversationConfig`, `ResolvedConversation`, `DefineEvalConversationInput`
- `src/types.ts:17` — simplify `ConversationReplySource` from 4 values to 3
- `src/core/index.ts:18` — update re-export from `ConversationReplyConfig` to `ConversationReactionConfig`
- `src/core/config.ts:58-75,208-213,277-285,461-467` — update `RawConversation`, `RawReply` → `RawReaction`, validation, resolution
- `src/conversationRunner.ts:26-34,58-71,255-314` — replace `ReplyPool` / `createReplyPool` / `pickReply` with `CompiledReaction[]` / `compileReactions` / `pickReaction`
- `tests/conversationRunner.test.ts` — update `makeConversation` helper and all test assertions for new API
- `tests/evalRunner.test.ts` — update conversation configs and source assertions
- `examples/ck-new/ck-new.eval.ts:42-58` — migrate `replies` → `reactions`
- `examples/ck-product-strategy/ck-product-strategy.eval.ts:31-67` — migrate and deduplicate `replies` → `reactions`

**No changes needed:**
- `src/graders/index.ts:77-79` — renders `reply_source` dynamically, will show `'reaction'` automatically
- `src/viewer.html:841` — renders `user_message_source` dynamically, will show `'reaction'` automatically

---

### Task 1: Update Type Definitions

**Files:**
- Modify: `src/core/config.types.ts:31-34,59-65,67-70,77-83,181-187`
- Modify: `src/types.ts:17`
- Modify: `src/core/index.ts:18`

- [ ] **Step 1: Replace ConversationReplyConfig with ConversationReactionConfig**

In `src/core/config.types.ts`, replace lines 31-34:

```ts
// Remove
export interface ConversationReplyConfig {
    content: string;
    when?: string;
}

// Add
export interface ConversationReactionConfig {
    when: string;           // regex pattern (compiled with 'i' flag)
    reply: string;          // response content (inline or file path)
    once?: boolean;         // if true, reaction is consumed after first use (default: false)
}
```

- [ ] **Step 2: Update ConversationConfig**

In `src/core/config.types.ts`, update lines 59-65:

```ts
export interface ConversationConfig {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ConversationReactionConfig[];   // was: replies?: ConversationReplyConfig[]
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}
```

- [ ] **Step 3: Replace ResolvedConversationReply with ResolvedConversationReaction**

In `src/core/config.types.ts`, replace lines 67-70:

```ts
// Remove
export interface ResolvedConversationReply {
    content: string;
    when?: string;
}

// Add
export interface ResolvedConversationReaction {
    when: string;
    reply: string;
    once?: boolean;
}
```

- [ ] **Step 4: Update ResolvedConversation**

In `src/core/config.types.ts`, update lines 77-83:

```ts
export interface ResolvedConversation {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ResolvedConversationReaction[];  // was: replies?: ResolvedConversationReply[]
    persona?: ConversationPersonaConfig;
    step_graders?: ResolvedStepGrader[];
}
```

- [ ] **Step 5: Update DefineEvalConversationInput**

In `src/core/config.types.ts`, update lines 181-187:

```ts
export interface DefineEvalConversationInput {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ConversationReactionConfig[];   // was: replies?: ConversationReplyConfig[]
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}
```

- [ ] **Step 6: Simplify ConversationReplySource**

In `src/types.ts`, update line 17:

```ts
// Was: export type ConversationReplySource = 'opener' | 'scripted' | 'scripted_pattern' | 'persona_llm';
export type ConversationReplySource = 'opener' | 'reaction' | 'persona_llm';
```

- [ ] **Step 7: Update public API re-export**

In `src/core/index.ts`, update line 18:

```ts
// Was: ConversationReplyConfig,
ConversationReactionConfig,
```

- [ ] **Step 8: Verify the project compiles with type errors only in downstream consumers**

Run: `npx tsc --noEmit 2>&1 | head -40`
Expected: Type errors in `config.ts`, `conversationRunner.ts`, test files, and example evals — but NOT in `config.types.ts`, `types.ts`, or `index.ts` themselves.

- [ ] **Step 9: Commit**

```bash
git add src/core/config.types.ts src/types.ts src/core/index.ts
git commit -m "refactor: replace ConversationReplyConfig types with ConversationReactionConfig"
```

---

### Task 2: Write Failing Reaction Tests

**Files:**
- Modify: `tests/conversationRunner.test.ts`

- [ ] **Step 1: Update makeConversation helper to use reactions**

In `tests/conversationRunner.test.ts`, update the `makeConversation` function (lines 47-56):

```ts
function makeConversation(overrides: Partial<ResolvedConversation> = {}): ResolvedConversation {
  return {
    opener: 'Hello agent, start the task.',
    completion: {
      max_turns: 5,
    },
    reactions: [],
    ...overrides,
  };
}
```

- [ ] **Step 2: Update max_turns test to use reactions**

In the `'completes on max_turns'` test (lines 78-84), update the conversation config:

```ts
      const conversation = makeConversation({
        completion: { max_turns: maxTurns },
        reactions: [
          { when: '.*', reply: 'Reply 1' },
          { when: '.*', reply: 'Reply 2' },
        ],
      });
```

- [ ] **Step 3: Update turn number test to use reactions**

In the `'records correct turn numbers'` test (lines 108-111), update:

```ts
      const conversation = makeConversation({
        completion: { max_turns: 2 },
        reactions: [{ when: '.*', reply: 'Keep going' }],
      });
```

- [ ] **Step 4: Update done_phrase test to use reactions**

In the `'stops when agent response contains done_phrase'` test (lines 137-140), update:

```ts
      const conversation = makeConversation({
        completion: { max_turns: 10, done_phrase: 'task complete' },
        reactions: [{ when: '.*', reply: 'Continue please.' }],
      });
```

- [ ] **Step 5: Update no_replies tests to use reactions**

In `'returns no_replies when reply pool is empty'` test (lines 216-220):

```ts
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [{ when: '.*', reply: 'One scripted reply.', once: true }],
      });
```

Note: The pattern must be `'.*'` (not a specific keyword like `'budget'`) because the mock agent responses are `'First response'` and `'Second response'` — a specific pattern would fail to match on turn 1, producing `total_turns: 1` instead of the expected `total_turns: 2`.

In `'returns no_replies with zero scripted replies'` test (lines 243-246):

```ts
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [],
      });
```

- [ ] **Step 6: Update source tracking test — rename scripted to reaction**

In `'records scripted reply as source in turn log'` test (lines 270-273), update to:

```ts
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [{ when: '.*', reply: 'Scripted reply text' }],
      });
```

And update assertions (lines 285-287):

```ts
      expect(result.conversation.turns[0].user_message_source).toBe('opener');
      expect(result.conversation.turns[1].user_message_source).toBe('reaction');
      expect(result.conversation.turns[1].user_message).toBe('Scripted reply text');
```

- [ ] **Step 7: Update pattern-match test — rename scripted_pattern to reaction**

In `'uses scripted_pattern reply when agent response matches when pattern'` test (lines 300-306), update to:

```ts
      const conversation = makeConversation({
        completion: { max_turns: 10, done_phrase: 'task complete' },
        reactions: [
          { when: 'budget', reply: 'The budget is $500.' },
          { when: '.*', reply: 'The fallback reply' },
        ],
      });
```

And update assertion (line 321):

```ts
      expect(turn2.user_message_source).toBe('reaction');
```

- [ ] **Step 8: Replace ordered-fallback test with reusable-reaction test**

Replace the `'falls back to ordered queue when pattern does not match'` test (lines 325-354) with a test that verifies reactions are reusable:

```ts
    it('reuses the same reaction on multiple matching turns', async () => {
      const responses = [
        { rawOutput: 'What is the budget?', assistantMessage: 'What is the budget?', exitCode: 0 },
        { rawOutput: 'What is the budget again?', assistantMessage: 'What is the budget again?', exitCode: 0 },
        { rawOutput: 'Task complete!', assistantMessage: 'Task complete!', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10, done_phrase: 'task complete' },
        reactions: [
          { when: 'budget', reply: 'The budget is $500.' },
        ],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      // Same reaction fires on turns 2 and 3 (reusable by default)
      expect(result.conversation.turns[1].user_message).toBe('The budget is $500.');
      expect(result.conversation.turns[1].user_message_source).toBe('reaction');
      expect(result.conversation.turns[2].user_message).toBe('The budget is $500.');
      expect(result.conversation.turns[2].user_message_source).toBe('reaction');
    });
```

- [ ] **Step 9: Add once:true test**

Add a new test in the `'uses pattern-matched replies when regex matches'` describe block:

```ts
    it('once:true reactions fire only once then are skipped', async () => {
      const responses = [
        { rawOutput: 'What is the budget?', assistantMessage: 'What is the budget?', exitCode: 0 },
        { rawOutput: 'What is the budget?', assistantMessage: 'What is the budget?', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [
          { when: 'budget', reply: 'The budget is $500.', once: true },
        ],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      // Turn 2: once-reaction fires
      expect(result.conversation.turns[1].user_message).toBe('The budget is $500.');
      expect(result.conversation.turns[1].user_message_source).toBe('reaction');
      // Turn 2 agent asks about budget again, but once-reaction already used → no_replies
      expect(result.conversation.completion_reason).toBe('no_replies');
      expect(result.conversation.total_turns).toBe(2);
    });
```

- [ ] **Step 10: Add test for "reactions exist but none match → no_replies"**

Add a new test in the `'uses pattern-matched replies when regex matches'` describe block:

```ts
    it('returns no_replies when reactions exist but none match agent response', async () => {
      const responses = [
        { rawOutput: 'Tell me about the timeline.', assistantMessage: 'Tell me about the timeline.', exitCode: 0 },
      ];
      const { agent } = makeSessionAgent(responses);
      const provider = makeProvider();
      const conversation = makeConversation({
        completion: { max_turns: 10 },
        reactions: [
          { when: 'budget', reply: 'The budget is $500.' },
          { when: 'team', reply: 'The team is 5 people.' },
        ],
      });

      const result = await runConversationTrial({
        agent,
        conversation,
        provider,
        runtime: mockRuntime,
        taskPath: '/task',
        timeoutSec: 30,
        timestamp,
      });

      // Agent said "timeline" which matches neither "budget" nor "team", no persona → no_replies
      expect(result.conversation.completion_reason).toBe('no_replies');
      expect(result.conversation.total_turns).toBe(1);
    });
```

- [ ] **Step 11: Update remaining tests that reference replies**

In the `'returns correct inputText'` test (lines 494-497):

```ts
      const conversation = makeConversation({
        opener: 'Opener message',
        completion: { max_turns: 10, done_phrase: 'task complete' },
        reactions: [{ when: '.*', reply: 'User reply 2' }],
      });
```

- [ ] **Step 12: Run the updated tests to verify they fail**

Run: `npx vitest run tests/conversationRunner.test.ts 2>&1 | tail -20`
Expected: FAIL — type errors or runtime failures because `conversationRunner.ts` still uses the old `ReplyPool` API.

- [ ] **Step 13: Commit**

```bash
git add tests/conversationRunner.test.ts
git commit -m "test: update conversationRunner tests for reaction API (failing)"
```

---

### Task 3: Update Config Validation and Resolution

**Files:**
- Modify: `src/core/config.ts:58-75,208-213,277-285,461-467`

- [ ] **Step 1: Update RawConversation and RawReply interfaces**

In `src/core/config.ts`, replace `RawConversation` (lines 58-70) and `RawReply` (lines 72-75):

```ts
interface RawConversation {
    opener?: string;
    completion?: {
        max_turns?: number;
        signal?: string;
        done_phrase?: string;
        done_when?: string;
        timeout?: number;
    };
    reactions?: RawReaction[];
    persona?: { description?: string; facts?: string[]; model?: string };
    step_graders?: RawStepGrader[];
}

interface RawReaction {
    when?: string;
    reply?: string;
    once?: boolean;
}
```

- [ ] **Step 2: Update validation logic**

In `src/core/config.ts`, replace the replies validation block (lines 208-213):

```ts
            if (t.conversation.reactions !== undefined && !Array.isArray(t.conversation.reactions)) {
                throw new Error(`Task "${t.name}" conversation.reactions must be an array when provided`);
            }
            if (!t.conversation.persona && (!Array.isArray(t.conversation.reactions) || t.conversation.reactions.length === 0)) {
                throw new Error(`Task "${t.name}" conversation must include at least one of "reactions" or "persona"`);
            }
            if (Array.isArray(t.conversation.reactions)) {
                for (let rIdx = 0; rIdx < t.conversation.reactions.length; rIdx++) {
                    const r = t.conversation.reactions[rIdx];
                    if (!r?.when || typeof r.when !== 'string') {
                        throw new Error(`Task "${t.name}" reactions[${rIdx}].when must be a non-empty string`);
                    }
                    if (!r?.reply || typeof r.reply !== 'string') {
                        throw new Error(`Task "${t.name}" reactions[${rIdx}].reply must be a non-empty string`);
                    }
                    if (r.once !== undefined && typeof r.once !== 'boolean') {
                        throw new Error(`Task "${t.name}" reactions[${rIdx}].once must be a boolean when provided`);
                    }
                    try {
                        new RegExp(r.when, 'i');
                    } catch (e) {
                        throw new Error(`Task "${t.name}" reactions[${rIdx}].when is not a valid regex: ${(e as Error).message}`);
                    }
                }
            }
```

- [ ] **Step 3: Update conversation task construction**

In `src/core/config.ts`, replace the replies mapping in the conversation task return (lines 277-285):

```ts
                    reactions: t.conversation!.reactions?.map((reaction: RawReaction) => {
                        if (!reaction?.when) {
                            throw new Error(`Task "${t.name}" conversation reactions must include "when"`);
                        }
                        if (!reaction?.reply) {
                            throw new Error(`Task "${t.name}" conversation reactions must include "reply"`);
                        }
                        return {
                            when: reaction.when,
                            reply: reaction.reply,
                            once: reaction.once,
                        };
                    }),
```

- [ ] **Step 4: Update resolveConversation function**

In `src/core/config.ts`, replace the replies resolution block (lines 461-468):

```ts
        reactions: conversation.reactions
            ? await Promise.all(
                conversation.reactions.map(async (reaction) => ({
                    when: reaction.when,
                    reply: await resolveFileOrInline(reaction.reply, baseDir),
                    once: reaction.once,
                }))
            )
            : undefined,
```

- [ ] **Step 5: Update imports**

In `src/core/config.ts`, update the import from `config.types` (around line 8) to include the new types. Replace `ConversationConfig` usage — the import already pulls it in, so just ensure `ResolvedConversation` and `ResolvedStepGrader` are still imported. No new imports needed since the types are used through `ConversationConfig`.

- [ ] **Step 6: Verify config module compiles**

Run: `npx tsc --noEmit 2>&1 | grep "config\\.ts" | head -10`
Expected: No errors in `src/core/config.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/core/config.ts
git commit -m "refactor: update config validation and resolution for reactions API"
```

---

### Task 4: Update Conversation Runner

**Files:**
- Modify: `src/conversationRunner.ts:26-34,58-71,255-314,327`

- [ ] **Step 1: Replace CompiledReply and ReplyPool with CompiledReaction**

In `src/conversationRunner.ts`, replace lines 26-34:

```ts
// Remove
interface CompiledReply {
    content: string;
    when: RegExp;
}

interface ReplyPool {
    orderedQueue: string[];
    patternReplies: CompiledReply[];
}

// Add
interface CompiledReaction {
    when: RegExp;
    reply: string;
    once: boolean;
    used: boolean;
}
```

- [ ] **Step 2: Replace createReplyPool with compileReactions**

In `src/conversationRunner.ts`, replace lines 58-71:

```ts
// Remove
function createReplyPool(conversation: ResolvedConversation): ReplyPool {
    const replies = conversation.replies ?? [];
    return {
        orderedQueue: replies
            .filter((reply) => !reply.when)
            .map((reply) => reply.content),
        patternReplies: replies
            .filter((reply) => reply.when)
            .map((reply) => ({
                content: reply.content,
                when: new RegExp(reply.when!, 'i'),
            })),
    };
}

// Add
function compileReactions(conversation: ResolvedConversation): CompiledReaction[] {
    return (conversation.reactions ?? []).map((r) => ({
        when: new RegExp(r.when, 'i'),
        reply: r.reply,
        once: r.once ?? false,
        used: false,
    }));
}
```

- [ ] **Step 3: Replace pickReply with pickReaction**

In `src/conversationRunner.ts`, replace lines 255-314:

```ts
async function pickReaction(
    assistantMessage: string,
    reactions: CompiledReaction[],
    conversation: ResolvedConversation,
    transcript: NonNullable<TrialResult['conversation']>['turns'],
    env: Record<string, string> | undefined,
    graderModel: string | undefined
): Promise<{
    content: string;
    source: ConversationReplySource;
    personaInputTokens?: number;
    personaOutputTokens?: number;
} | null> {
    // Find first matching reaction (skip once-reactions already used)
    const match = reactions.find((r) => {
        if (r.once && r.used) return false;
        return r.when.test(assistantMessage);
    });

    if (match) {
        if (match.once) match.used = true;
        return { content: match.reply, source: 'reaction' };
    }

    // Fallback: persona (unchanged)
    if (conversation.persona) {
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const personaReply = await generatePersonaReply(
                    conversation.persona,
                    transcript,
                    assistantMessage,
                    env,
                    graderModel
                );
                if (!personaReply.content.trim()) {
                    throw new Error('Persona returned empty content');
                }
                return {
                    content: personaReply.content,
                    source: 'persona_llm',
                    personaInputTokens: personaReply.inputTokens,
                    personaOutputTokens: personaReply.outputTokens,
                };
            } catch (err) {
                if (attempt === 0) continue;
            }
        }
        return null;
    }

    return null;
}
```

- [ ] **Step 4: Update runConversationTrial to use compileReactions and pickReaction**

In `src/conversationRunner.ts`, update line 327:

```ts
// Was: const replyPool = createReplyPool(opts.conversation);
// NOTE: compileReactions MUST be called inside runConversationTrial (not hoisted outside).
// Each CompiledReaction has mutable `used` state for once:true tracking.
// Calling it per-trial ensures once-reactions reset across trials.
const reactions = compileReactions(opts.conversation);
```

And update lines 639-646:

```ts
// Was: const reply = await pickReply(assistantMessage, replyPool, ...)
        const reply = await pickReaction(
            assistantMessage,
            reactions,
            opts.conversation,
            turns,
            opts.env,
            opts.graderModel
        );
```

- [ ] **Step 5: Run conversationRunner tests**

Run: `npx vitest run tests/conversationRunner.test.ts 2>&1 | tail -30`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/conversationRunner.ts
git commit -m "refactor: replace ReplyPool with CompiledReaction in conversation runner"
```

---

### Task 5: Update evalRunner Tests

**Files:**
- Modify: `tests/evalRunner.test.ts`

- [ ] **Step 1: Update scripted multi-turn conversation test**

In `tests/evalRunner.test.ts`, find the `'runs scripted multi-turn conversations and stops on done_phrase'` test. Update the conversation config (around line 183):

```ts
        reactions: [
          { when: '.*', reply: 'The goal is validating demand quickly.' },
        ],
```

And update the source assertion (around line 196):

```ts
    expect(report.trials[0].conversation?.turns.map(turn => turn.user_message_source)).toEqual(['opener', 'reaction']);
```

- [ ] **Step 2: Update persona fallback test**

In `tests/evalRunner.test.ts`, find the `'falls back to persona replies after scripted replies are exhausted'` test. Update the conversation config (around line 247):

```ts
        reactions: [
          { when: '.*', reply: 'It is a gift card feature for Wix Stores.', once: true },
        ],
```

Note: Keep the same reply text as the original test (`'It is a gift card feature for Wix Stores.'`) to avoid breaking the `reply` mock assertion at line 261-263 which checks this exact string.

And update the source assertions (around line 273):

```ts
    expect(report.trials[0].conversation?.turns.map(turn => turn.user_message_source)).toEqual([
      'opener',
      'reaction',
      'persona_llm',
    ]);
```

- [ ] **Step 3: Update any remaining tests that reference replies**

Search for any other test in `tests/evalRunner.test.ts` with `replies:` in conversation configs and update them to `reactions:` with proper `{ when, reply }` shape. Also search for `'scripted'` or `'scripted_pattern'` in assertions and replace with `'reaction'`.

In the retry-on-transient-failure test (around line 334), update:

```ts
        reactions: [
          { when: '.*', reply: 'Continue.' },
        ],
```

In the step graders test (around line 378), update:

```ts
        reactions: [
          { when: '.*', reply: 'Continue.' },
        ],
```

- [ ] **Step 4: Run evalRunner tests**

Run: `npx vitest run tests/evalRunner.test.ts 2>&1 | tail -20`
Expected: All tests PASS.

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run 2>&1 | tail -20`
Expected: All tests PASS (there may be test files beyond the two we've updated — check for failures).

- [ ] **Step 6: Commit**

```bash
git add tests/evalRunner.test.ts
git commit -m "test: update evalRunner tests for reaction API"
```

---

### Task 6: Migrate Example Evals

**Files:**
- Modify: `examples/ck-new/ck-new.eval.ts:42-58`
- Modify: `examples/ck-product-strategy/ck-product-strategy.eval.ts:31-67`

- [ ] **Step 1: Migrate ck-new scripted-gift-card task**

In `examples/ck-new/ck-new.eval.ts`, replace lines 42-58 (`replies` array) with:

```ts
        reactions: [
          { when: 'platform|tell me more|details', reply: `It's for the Wix Stores platform. Online store owners have been\nrequesting the ability to sell digital gift cards that customers\ncan purchase and redeem at checkout.\n` },
          {
            reply: "Yes, that's right. The goal is to solve a user pain point, and the target group is Self-Creator.",
            when: "right\\?|correct\\?|confirm|sound right",
          },
          { when: 'goal|trying to achieve|what are you trying', reply: 'Solve user pain point' },
          { when: 'target|audience|who|Self-Creator|adjust if needed', reply: 'Self-Creator' },
          { when: 'knowledge base|KB.*MCP|enrich.*brief|paste.*doc.*skip', reply: 'Skip' },
          { when: 'gameplan|strategy doc', reply: 'Skip for now' },
          {
            when: 'take on this so far|what.*so far|ready to write|write the brief|next step',
            reply: 'Looks good so far. Please write the brief now.',
          },
          { when: "look right|approve|feedback|changes|edit|you'd change|anything.*change|move on|before moving", reply: 'Looks good, no changes' },
          { when: 'github|repo|reference', reply: 'No, skip repos for now' },
        ],
```

- [ ] **Step 2: Migrate ck-product-strategy scripted-smart-cart task**

In `examples/ck-product-strategy/ck-product-strategy.eval.ts`, replace lines 31-67 (`replies` array) with deduplicated reactions:

```ts
        reactions: [
          {
            when: 'platform|tell me more|details|about.*feature|describe',
            reply: `It's about adding AI-powered product recommendations to the Wix Stores
shopping cart. Store owners want to increase average order value by suggesting
relevant products at checkout. Let's start from scratch.\n`,
          },
          { when: 'knowledge base|KB|kb-retrieval|MCP|npx|paste.*doc.*skip|enrich', reply: 'Skip' },
          { when: 'start.*scratch|from scratch|continue.*left off|start.*strategy', reply: 'Start strategy from scratch' },
          { when: 'missing|proceed.*assumption|how.*proceed|critical.*missing', reply: 'Proceed with assumptions' },
          { when: 'gameplan|domain.*game', reply: 'No gameplan available, proceed without it' },
          { when: "annual.*plan.*not found|can't find.*annual|add.*annual.*plan", reply: 'Proceed without it' },
          { when: 'direction.*[ABC]|which.*option|choose.*direction|Direction \\d|Option [ABC]', reply: 'Go with your recommended direction' },
          {
            when: 'finalized product strategy|final product strategy|execution-ready KPI spec|PRD-ready strategy doc|save.*artifacts/product|saved to|next artifact',
            reply: 'Looks good — save the final strategy to artifacts/product/product-strategy-smart-cart.md',
          },
          { when: "correct\\?|right\\?|confirm|sound right|accurate\\?", reply: "Yes, that's correct" },
          { when: 'Looks good|I have feedback|approve|how does.*look|section look|what do you think', reply: 'Looks good — continue' },
        ],
```

Note: The 10 copies of `'Looks good — continue'` collapse to a single reaction (reusable by default). Same for the other duplicated entries.

- [ ] **Step 3: Verify examples type-check**

Run: `npx tsc --noEmit 2>&1 | grep "examples" | head -10`
Expected: No type errors in example files.

- [ ] **Step 4: Commit**

```bash
git add examples/ck-new/ck-new.eval.ts examples/ck-product-strategy/ck-product-strategy.eval.ts
git commit -m "refactor: migrate example evals from replies to reactions"
```

---

### Task 7: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Full type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 2: Full test suite**

Run: `npx vitest run`
Expected: All tests pass.

- [ ] **Step 3: Verify no stale references to old API**

Run: `grep -rn "ConversationReplyConfig\|ResolvedConversationReply\|orderedQueue\|patternReplies\|createReplyPool\|pickReply\|'scripted_pattern'\|'scripted'" src/ tests/ examples/ --include="*.ts" --include="*.html"`
Expected: No matches. All old API references have been replaced.

- [ ] **Step 4: Commit any remaining cleanup**

If the grep in Step 3 finds stale references, fix them and commit:

```bash
git add -A
git commit -m "refactor: clean up remaining old reply API references"
```
