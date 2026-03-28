# Conversation Reactions: Replacing Implicit Replies with Explicit Reactions

**Date:** 2026-03-28
**Status:** Draft

## Problem

Conversation replies are too implicit. The current design has three pain points:

1. **Opaque selection logic.** The runtime uses a hidden 3-tier fallback: pattern-matched replies > ordered (no-`when`) replies > persona LLM. Eval authors must read the runtime code to predict which reply fires on a given turn.

2. **Ambiguous config.** Ordered and pattern-matched replies live in the same flat array. The only way to tell them apart is checking whether `when` is present. Reading the config doesn't reveal the conversation flow.

3. **Unnecessary concepts.** In practice, ordered replies are only used for a single "first context dump" after the opener. They could just be pattern-matched reactions like everything else. The ordered queue concept adds complexity without real value.

## Design

### Core Model

Replace the 3-tier reply system with two simple concepts:

```
opener  ->  agent responds  ->  reactions (pattern-matched)  ->  persona fallback
```

- **Reactions** are pattern-matched responses. Each one declares a `when` regex and a `reply`. When the agent's message matches the pattern, the reply is sent.
- **Persona** is the fallback when no reaction matches. Unchanged from current behavior.
- **No ordered queue.** Every reply has a `when` trigger. No implicit priority tiers.

### Config Shape

**Before (current):**

```ts
conversation: {
  opener: 'I want to start a new project...',
  completion: { max_turns: 12, signal: 'artifacts/project-brief-*.md' },
  replies: [
    { content: "It's for the Wix Stores platform..." },
    { content: "Yes, that's right", when: "right\\?|correct\\?" },
    { content: 'Solve user pain point', when: 'goal|trying to achieve' },
  ],
  persona: { ... },
}
```

**After (new):**

```ts
conversation: {
  opener: 'I want to start a new project...',
  completion: { max_turns: 12, signal: 'artifacts/project-brief-*.md' },
  reactions: [
    { when: 'platform|tell me more|details', reply: "It's for the Wix Stores platform..." },
    { when: 'right\\?|correct\\?|confirm',   reply: "Yes, that's right" },
    { when: 'goal|trying to achieve',        reply: 'Solve user pain point' },
    { when: 'target|audience|who',           reply: 'Self-Creator' },
    { when: 'approve|feedback|look right',   reply: 'Looks good, no changes' },
  ],
  persona: { ... },
}
```

### Key Design Decisions

#### 1. `when` is required on every reaction

Every reaction must have a `when` pattern. There are no "unconditional" entries. This eliminates the implicit ordered-vs-pattern distinction that made the old system confusing.

#### 2. Reactions are reusable by default — deliberate behavioral change

**This is a deliberate change from current semantics.** The current system consumes pattern replies on use (`splice()`). The new system keeps reactions alive by default.

**Why:** The 10 duplicate "Looks good" entries in `ck-product-strategy` are direct evidence that consume-on-use is the wrong default. The natural mental model for reactions is "whenever X happens, say Y" — not "say Y the first time X happens, then never again."

**Migration impact:** Every existing eval must be audited during migration. For each reaction, ask: "should this fire more than once?" If not, add `once: true`. The migration section below provides specific guidance per eval.

For the rare case where a reaction should only fire once, add `once: true`:

```ts
{ when: 'platform|tell me more', reply: "It's for the Wix Stores platform...", once: true }
```

#### 3. `when` comes first, `reply` second

The field order reads as: "**when** X happens, **reply** with Y." This matches the mental model of reactions as event handlers.

#### 4. All patterns are case-insensitive

Patterns are compiled with the `i` flag, same as the current implementation. This is the right default for matching conversational text. No per-reaction flag override is needed for now — the field can be added later without changing the shape.

#### 5. First-match wins — pattern shadowing

When multiple reactions match the agent's message, the first matching entry in the array is used. The array does not imply execution order (reactions don't fire sequentially), but it does define match priority when patterns overlap.

**Shadowing risk:** With reusable reactions, the first matching reaction permanently shadows later overlapping patterns (unlike consume-on-use where shadowed patterns eventually get their turn). The runtime will log a debug warning when multiple reactions match the same message, so eval authors can spot unintentional shadowing during development.

#### 6. `reply` supports file paths

Like the current `content` field, `reply` is resolved via `resolveFileOrInline()` — it can be an inline string or a path to a file relative to the eval directory.

#### 7. Regex validation at config load time

Invalid `when` patterns (e.g., `'(unclosed'`) are caught during `validateConfig`, not at runtime. Validation wraps `new RegExp(when, 'i')` in a try-catch and throws a clear error:

```
Task "scripted-gift-card" reactions[0].when is not a valid regex: Unterminated group
```

`compileReactions()` also wraps `new RegExp()` in a try-catch as defense-in-depth, though validation should always catch this first.

### Type Changes

**`src/core/config.types.ts`:**

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

// Update ConversationConfig
export interface ConversationConfig {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ConversationReactionConfig[];   // was: replies?: ConversationReplyConfig[]
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}

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

// Update ResolvedConversation
export interface ResolvedConversation {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ResolvedConversationReaction[];  // was: replies?: ResolvedConversationReply[]
    persona?: ConversationPersonaConfig;
    step_graders?: ResolvedStepGrader[];
}

// Update DefineEvalConversationInput
export interface DefineEvalConversationInput {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ConversationReactionConfig[];   // was: replies
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}
```

**`src/types.ts`:**

```ts
// Simplify — no more scripted vs scripted_pattern distinction
export type ConversationReplySource = 'opener' | 'reaction' | 'persona_llm';
```

### Runtime Changes

**`src/conversationRunner.ts`:**

Replace the `ReplyPool` with a simpler `CompiledReaction` model:

```ts
interface CompiledReaction {
    when: RegExp;
    reply: string;
    once: boolean;
    used: boolean;  // tracks whether a once-reaction has already fired
}

function compileReactions(conversation: ResolvedConversation): CompiledReaction[] {
    return (conversation.reactions ?? []).map((r) => {
        try {
            return {
                when: new RegExp(r.when, 'i'),
                reply: r.reply,
                once: r.once ?? false,
                used: false,
            };
        } catch (err) {
            // Defense-in-depth — validation should catch this first
            throw new Error(`Invalid reaction regex "${r.when}": ${(err as Error).message}`);
        }
    });
}
```

Replace `pickReply()` with `pickReaction()`:

```ts
async function pickReaction(
    assistantMessage: string,
    reactions: CompiledReaction[],
    conversation: ResolvedConversation,
    transcript: ConversationTurn[],
    env: Record<string, string> | undefined,
    graderModel: string | undefined
): Promise<{
    content: string;
    source: ConversationReplySource;
    personaInputTokens?: number;
    personaOutputTokens?: number;
} | null> {

    // Find all matching reactions for shadowing detection
    const matches = reactions.filter((r) => {
        if (r.once && r.used) return false;
        return r.when.test(assistantMessage);
    });

    if (matches.length > 1) {
        console.warn(
            `[reactions] ${matches.length} reactions matched — using first. ` +
            `Patterns: ${matches.map(m => m.when.source).join(', ')}`
        );
    }

    if (matches.length > 0) {
        const match = matches[0];
        if (match.once) match.used = true;
        return { content: match.reply, source: 'reaction' };
    }

    // Fallback: persona (unchanged)
    if (conversation.persona) {
        // ... existing persona logic, unchanged ...
    }

    return null;
}
```

### Validation Changes

**`src/core/config.ts`:**

Update internal raw types:

```ts
// Rename
interface RawReaction {       // was: RawReply
    when?: string;            // was: content + optional when
    reply?: string;
    once?: boolean;
}

interface RawConversation {
    opener?: string;
    completion?: { ... };
    reactions?: RawReaction[];   // was: replies?: RawReply[]
    persona?: { ... };
    step_graders?: RawStepGrader[];
}
```

Update validation block (currently lines 208-221):

- `reactions` must be an array when provided.
- `reactions: []` (empty array) without `persona` is rejected: "must include at least one of reactions (non-empty) or persona."
- Each reaction must have a `when` (non-empty string) and a `reply` (non-empty string).
- Each `when` must be a valid regex — wrap `new RegExp(when, 'i')` in try-catch, throw descriptive error on failure.
- `once` must be a boolean when provided.

Update `resolveConversation()` (currently lines 454-487):

```ts
async function resolveConversation(
    conversation: ConversationConfig,
    baseDir: string
): Promise<ResolvedConversation> {
    return {
        opener: await resolveFileOrInline(conversation.opener, baseDir),
        completion: conversation.completion,
        reactions: conversation.reactions
            ? await Promise.all(
                conversation.reactions.map(async (reaction) => ({
                    reply: await resolveFileOrInline(reaction.reply, baseDir),
                    when: reaction.when,
                    once: reaction.once,
                }))
            )
            : undefined,
        // ... persona and step_graders unchanged ...
    };
}
```

### `no_replies` Behavioral Change

**This is a behavioral change, not "unchanged."**

With reusable reactions, the `no_replies` completion reason behaves differently:

- **Reusable reactions without persona:** `no_replies` only fires when the agent says something that no reaction pattern matches. The pool never drains, so `no_replies` means "unmatched message" rather than "exhausted pool."
- **All `once: true` reactions without persona:** behaves like the old system — reactions drain, then `no_replies` fires.
- **Any reactions with persona:** `no_replies` is unreachable (persona always provides a fallback).

This is the correct behavior for the new model. The completion reason name `no_replies` still accurately describes what happened: no reply was available for the agent's message.

### Session Log & Output

The `ConversationReplySource` type simplifies from four values to three:

| Before | After |
|--------|-------|
| `opener` | `opener` (unchanged) |
| `scripted` | removed |
| `scripted_pattern` | `reaction` |
| `persona_llm` | `persona_llm` (unchanged) |

**Grader transcript headers** (`src/graders/index.ts`, lines 77-79): The `reply_source` field in session log entries changes from `scripted`/`scripted_pattern` to `reaction`. LLM rubric transcripts that render this value will show the new label. Existing rubric `.md` files should be audited for hardcoded references to old source names.

**Viewer badges** (`src/viewer.html`, line 841): The `user_message_source` badge renders the source value directly. Old reports (generated before this change) will still show `scripted`/`scripted_pattern`. New reports will show `reaction`. No backward-compat mapping needed — old reports are static HTML snapshots.

### Migration

This is a breaking change to the eval config format. All existing evals need updating.

**Steps for each eval:**

1. **Field rename**: `replies` -> `reactions` at the conversation config level.
2. **Ordered replies** (no `when`): Add a `when` pattern. Use `{ when: '.*', reply: '...', once: true }` as a safe catch-all equivalent if the original intent was "send this first regardless of what the agent says."
3. **Pattern replies** (with `when`): Rename `content` to `reply`. The `when` field stays the same.
4. **Duplicated entries**: Replace N copies of the same reply with a single entry (reusable by default).
5. **Audit reusability**: For each reaction, decide: should this fire more than once? If not, add `once: true`. Most confirmations and approvals ("Yes, that's right", "Looks good") should be reusable. Context-specific answers ("It's for the Wix Stores platform") are candidates for `once: true`.

**Specific eval migration:**

- `examples/ck-new/ck-new.eval.ts`:
  - 1 ordered reply: `{ content: "It's for the Wix Stores platform..." }` -> `{ when: '.*', reply: "It's for the Wix Stores platform...", once: true }` (or pick a specific pattern like `'platform|tell me|details|what.*about'`)
  - 7 pattern replies: rename `content` to `reply`, no duplication to remove

- `examples/ck-product-strategy/ck-product-strategy.eval.ts`:
  - 1 ordered reply: same treatment as above
  - 3x `Skip` with same pattern -> 1x `{ when: '...', reply: 'Skip' }` (reusable)
  - 2x `Go with your recommended direction` -> 1x reusable
  - 3x `Yes, that's correct` -> 1x reusable
  - 10x `Looks good — continue` -> 1x reusable

### Test Changes

**`tests/conversationRunner.test.ts`:**

- **`makeConversation` helper** (line 47): This is the central migration point. Update its default `replies: []` to `reactions: []`. All 20+ tests that inherit this default will pick up the change.
- Replace all `replies: [{ content, when }]` with `reactions: [{ when, reply }]`.
- Replace `replies: [{ content }]` (ordered) with `reactions: [{ when, reply }]` (add appropriate patterns).
- Update source assertions: `'scripted'` and `'scripted_pattern'` become `'reaction'`.
- Remove tests that specifically verify ordered-vs-pattern priority (the distinction no longer exists).
- Add tests for `once: true` behavior.
- Add tests verifying reusable-by-default (same reaction fires multiple times).
- Add test for pattern shadowing warning.

**`tests/evalRunner.test.ts`:**

- Line 144: test description references "scripted multi-turn conversations" — update wording.
- Line 181: assertion `['opener', 'scripted']` -> `['opener', 'reaction']`.
- Line 185: test description references "scripted replies" — update wording.
- Lines 258-261: assertion `['opener', 'scripted', 'persona_llm']` -> `['opener', 'reaction', 'persona_llm']`.
- Update reply config shapes in test setup (`replies` -> `reactions`, `content` -> `reply`, add `when`).

## Scope

| Area | Files |
|------|-------|
| Types | `src/core/config.types.ts` |
| Runtime types | `src/types.ts` |
| Validation + resolution | `src/core/config.ts` (includes `RawConversation`/`RawReply` renames, validation block, `resolveConversation()`) |
| Runtime | `src/conversationRunner.ts` |
| Grader transcript | `src/graders/index.ts` (lines 77-79, `reply_source` rendering) |
| Viewer | `src/viewer.html` (line 841, `user_message_source` badge) |
| Examples | `examples/ck-new/ck-new.eval.ts`, `examples/ck-product-strategy/ck-product-strategy.eval.ts` |
| Tests | `tests/conversationRunner.test.ts`, `tests/evalRunner.test.ts` |

No changes to: persona logic, completion logic, step graders, grader framework, agent interface, environment providers.
