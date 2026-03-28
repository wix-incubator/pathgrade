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

#### 2. Reactions are reusable by default

Reactions are **not** consumed on use. If the agent asks for confirmation three times, the same reaction fires three times. This eliminates the need to duplicate entries (the `ck-product-strategy` eval currently has 10 copies of the same reply).

For the rare case where a reaction should only fire once, add `once: true`:

```ts
{ when: 'platform|tell me more', reply: "It's for the Wix Stores platform...", once: true }
```

#### 3. `when` comes first, `reply` second

The field order reads as: "**when** X happens, **reply** with Y." This matches the mental model of reactions as event handlers.

#### 4. All patterns are case-insensitive

Patterns are compiled with the `i` flag, same as the current implementation. This is the right default for matching conversational text. No per-reaction flag override is needed for now — the field can be added later without changing the shape.

#### 5. First-match wins

When multiple reactions match the agent's message, the first matching entry in the array is used. The array does not imply execution order (reactions don't fire sequentially), but it does define match priority when patterns overlap.

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

// Update ResolvedConversation
export interface ResolvedConversationReaction {
    when: string;
    reply: string;
    once?: boolean;
}

export interface ResolvedConversation {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ResolvedConversationReaction[];  // was: replies?: ResolvedConversationReply[]
    persona?: ConversationPersonaConfig;
    step_graders?: ResolvedStepGrader[];
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
    return (conversation.reactions ?? []).map((r) => ({
        when: new RegExp(r.when, 'i'),
        reply: r.reply,
        once: r.once ?? false,
        used: false,
    }));
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

    // Tier 1: find first matching reaction
    const match = reactions.find((r) => {
        if (r.once && r.used) return false;
        return r.when.test(assistantMessage);
    });

    if (match) {
        if (match.once) match.used = true;
        return { content: match.reply, source: 'reaction' };
    }

    // Tier 2: persona fallback (unchanged)
    if (conversation.persona) {
        // ... existing persona logic, unchanged ...
    }

    return null;
}
```

### Validation Changes

**`src/core/config.ts`:**

Update conversation validation:

- `reactions` must be an array when provided.
- Each reaction must have a `when` (non-empty string) and a `reply` (non-empty string).
- `once` must be a boolean when provided.
- At least one of `reactions` or `persona` must be present (unchanged rule).

### DefineEval Changes

**`src/core/config.types.ts` — `DefineEvalConversationInput`:**

```ts
export interface DefineEvalConversationInput {
    opener: string;
    completion: ConversationCompletionConfig;
    reactions?: ConversationReactionConfig[];   // was: replies
    persona?: ConversationPersonaConfig;
    step_graders?: StepGraderConfig[];
}
```

### Migration

This is a breaking change to the eval config format. All existing evals need updating:

1. **Ordered replies** (no `when`): Add a `when` pattern that matches the agent's likely first question. Review the conversation flow to pick an appropriate trigger.
2. **Pattern replies** (with `when`): Rename `content` to `reply`. The `when` field stays the same.
3. **Duplicated entries**: Replace N copies of the same reply with a single entry (reusable by default).
4. **Field rename**: `replies` -> `reactions` at the conversation config level.

**Affected files:**
- `examples/ck-new/ck-new.eval.ts` — 1 ordered + 7 pattern replies
- `examples/ck-product-strategy/ck-product-strategy.eval.ts` — 1 ordered + many duplicated pattern replies

### Session Log & Output

The `ConversationReplySource` type simplifies from four values to three:

| Before | After |
|--------|-------|
| `opener` | `opener` (unchanged) |
| `scripted` | removed |
| `scripted_pattern` | `reaction` |
| `persona_llm` | `persona_llm` (unchanged) |

Existing log consumers and graders that check `user_message_source` need updating to use the new values.

### Test Changes

Tests in `tests/conversationRunner.test.ts` need updating:

- Replace all `replies: [{ content, when }]` with `reactions: [{ when, reply }]`.
- Replace `replies: [{ content }]` (ordered) with `reactions: [{ when, reply }]` (add appropriate patterns).
- Update source assertions: `'scripted'` and `'scripted_pattern'` become `'reaction'`.
- Remove tests that specifically verify ordered-vs-pattern priority (the distinction no longer exists).
- Add tests for `once: true` behavior.
- Add tests verifying reusable-by-default (same reaction fires multiple times).

## Scope

This change touches:

| Area | Files |
|------|-------|
| Types | `src/core/config.types.ts` |
| Runtime types | `src/types.ts` |
| Validation | `src/core/config.ts` |
| Runtime | `src/conversationRunner.ts` |
| Examples | `examples/ck-new/ck-new.eval.ts`, `examples/ck-product-strategy/ck-product-strategy.eval.ts` |
| Tests | `tests/conversationRunner.test.ts` |

No changes to: persona logic, completion logic (including `no_replies` completion reason when all reactions exhausted and no persona), step graders, grader framework, agent interface, environment providers.
