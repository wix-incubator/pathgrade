# Multi-Turn Conversation Support for Skillgrade

**Date:** 2026-03-20
**Status:** Draft
**Author:** nadavlac + claude

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Stories](#3-user-stories)
4. [Design Overview](#4-design-overview)
5. [eval.yaml Schema](#5-evalyaml-schema)
6. [TypeScript Types](#6-typescript-types)
7. [Execution Flow](#7-execution-flow)
8. [Reply Dispatch System](#8-reply-dispatch-system)
9. [LLM Persona Simulation](#9-llm-persona-simulation)
10. [Agent Session Continuation](#10-agent-session-continuation)
11. [Conversation Completion](#11-conversation-completion)
12. [Per-Step Grading](#12-per-step-grading)
13. [Session Logging](#13-session-logging)
14. [CI / GitHub Actions](#14-ci--github-actions)
15. [Migration Compatibility](#15-migration-compatibility)
16. [Error Handling](#16-error-handling)
17. [Example: ck-new Evaluation](#17-example-ck-new-evaluation)
18. [Implementation Plan](#18-implementation-plan)

---

## 1. Problem Statement

### Current State

Skillgrade evaluates whether AI agents correctly discover and use Agent Skills. The current model is **single-turn**: one instruction is sent to the agent, the agent runs autonomously, then grading happens.

```
Current flow:
  instruction → agent.run() → single response → grade
```

This works for skills where the agent receives all information upfront:
- **ck-status**: "Show me the project status" → agent runs detect-phase.js → output
- **superlint**: "Fix linting errors" → agent finds tool, runs it → files modified

### The Problem

Many skills are **conversational** — they require multiple back-and-forth turns between the agent and the user. The skill asks a question, waits for the user's answer, then proceeds based on that answer.

**ck-new** is the canonical example. Its workflow:
1. Agent asks: "Tell me what you're working on"
2. User describes the project
3. Agent asks: "Sounds like this is in [domain] — right?"
4. User confirms or corrects
5. Agent asks: "What's your goal?" (multiple choice)
6. User selects
7. Agent asks: "Who's the target group?" (multiple choice)
8. User selects
9. Agent generates and saves the project brief

This **cannot be tested** with the current single-turn model. If we pack all answers into the instruction, the agent sees everything upfront — this doesn't test whether the skill correctly guides the conversation, handles unexpected answers, or follows its prescribed one-question-at-a-time flow.

### Impact

Without multi-turn support, an entire class of skills is untestable:
- **ck-new** (conversational intake → project brief)
- **ck-product-strategy** (section-by-section validation with user)
- **ck-ux-concepts** (iterative concept generation with feedback)
- Any skill with `disable-model-invocation: true` that expects interactive dialogue

---

## 2. Goals & Non-Goals

### Goals

1. **Support multi-turn conversations** in skillgrade evaluations with pre-defined or LLM-simulated user replies
2. **Support scripted replies** for deterministic, repeatable testing
3. **Support LLM-simulated users** for realistic end-to-end evaluation
4. **Support per-step grading** to verify the agent follows the skill's prescribed workflow at each stage
5. **Support flexible completion detection** — max turns, file signals, phrase matching, timeout
6. **Maintain migration compatibility** — existing single-turn eval.yaml files require at most minor migration
7. **Preserve non-interactive CI execution** via GitHub Actions so deterministic evals and selected agent-backed evals can run automatically on pull requests, pushes, and scheduled jobs

### Non-Goals

1. **Real-time human-in-the-loop** — the simulated user is always automated (scripted or LLM), never a live person during eval runs
2. **Branching conversation trees** — we don't model if/else conversation paths. The dispatch system handles ordering flexibility, but there's no explicit state machine
3. **Agent-to-agent conversations** — only agent ↔ simulated-user, not agent ↔ agent
4. **Streaming support** — turn boundaries are clean request/response pairs, not streamed tokens
5. **Full upstream compatibility at the codebase level** — this design is intended for a new repository derived from skillgrade, not for a low-risk in-place patch to the existing upstream project

---

## 3. User Stories

### Story 1: Eval author tests ck-new with scripted replies

> As an eval author, I want to define a sequence of user replies so that ck-new receives predictable answers to its intake questions, and I can verify it produces a correct project brief.

**Acceptance criteria:**
- eval.yaml supports a `conversation:` field with `opener` and `replies`
- Replies are sent to the agent in sequence
- The agent produces `artifacts/project-brief-*.md`
- Deterministic grader can verify the brief's content

### Story 2: Eval author tests ck-new with an LLM-simulated user

> As an eval author, I want to define a persona with known facts so that the agent gets realistic (but controlled) responses, testing how robust the skill is to varied conversation styles.

**Acceptance criteria:**
- eval.yaml supports a `persona:` field with `description` and `facts`
- An LLM generates user replies based on the persona and conversation context
- Each trial may produce slightly different conversations (realistic variance)
- The final output (project brief) is still graded for correctness

### Story 3: Eval author verifies skill workflow compliance

> As an eval author, I want to run graders at intermediate conversation steps to verify the agent asks the right questions in the right order — not just that the final output is correct.

**Acceptance criteria:**
- `step_graders:` field allows attaching graders to specific turn numbers
- Graders run after the specified turn completes
- Step grader failures are recorded in the trial result alongside end-of-conversation graders

### Story 4: Eval author combines scripted and simulated replies

> As an eval author, I want to pin exact answers for multiple-choice questions (so the agent always gets "Solve user pain point") while letting the LLM handle open-ended questions naturally.

**Acceptance criteria:**
- `replies:` and `persona:` can coexist in the same conversation
- Scripted replies with `when:` patterns match first
- Remaining ordered replies are sent next
- Persona LLM is the fallback when no scripted reply matches

---

## 4. Design Overview

### Architecture Decision: Sequential Local CLI Invocations with Session Continuation

Each conversation turn is a **separate local agent CLI invocation** using the agent's native session continuation mechanism when available:

```
Turn 1:  claude -p "opener message"                → raw output 1 + assistant message 1
Turn 2:  claude -p "scripted reply" -c             → raw output 2 + assistant message 2
Turn 3:  claude -p "LLM-generated reply" -c        → raw output 3 + assistant message 3
...
Turn N:  (completion condition met)                 → end conversation
```

All turns in a trial share the same **isolated local trial root**:

```text
trial-root/
  workspace/   # task files and artifacts
  home/        # HOME for agent CLI session state
  xdg/         # XDG_CONFIG_HOME / XDG_STATE_HOME
  tmp/         # TMPDIR for prompt files and scratch data
```

Every CLI invocation in the trial runs with:
- `cwd = trial-root/workspace`
- `HOME = trial-root/home`
- `XDG_CONFIG_HOME = trial-root/xdg`
- `XDG_STATE_HOME = trial-root/xdg/state`
- `TMPDIR = trial-root/tmp`

This preserves session files across turns while preventing cross-trial contamination on the host.

**Why this approach over alternatives:**

| Approach | Pros | Cons |
|----------|------|------|
| **Sequential local CLI (chosen)** | Clean turn boundaries, works with existing CLIs, independently loggable turns, easy per-trial HOME isolation | Process spawn per turn, relies on agent continuation flags or transcript fallback |
| Interactive stdin piping | True real-time, single process | Fragile stdout parsing, ANSI codes break detection, agent-specific prompts |
| Prompt stuffing | Zero architecture changes | Unrealistic — agent sees all answers upfront, defeats the purpose |

### High-Level Flow

```
┌──────────────────────────────────────────────────────────────────┐
│                    ConversationRunner                            │
│                                                                  │
│  1. Send opener to agent (first CLI invocation)                  │
│  2. Agent responds                                               │
│  3. Normalize assistant-facing message from CLI output           │
│  4. Check completion conditions → done? → go to grading          │
│  5. Run step_graders for this turn (if defined)                  │
│  6. Pick next reply:                                             │
│     a. Pattern-matched scripted reply?  → use it                 │
│     b. Next ordered scripted reply?     → use it                 │
│     c. Persona LLM?                    → generate reply          │
│     d. None available?                 → end conversation        │
│  7. Send reply to agent (continuation CLI invocation)            │
│  8. Go to step 2                                                 │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Implementation Vehicle: Hard Fork / New Repository

This design should be implemented in a **new repository derived from skillgrade**, not as a direct in-place evolution of the current upstream project.

Rationale:
- The current skillgrade runtime is strongly shaped around **single-turn execution** and **Docker-based isolation**
- This design changes the product boundary to **local-only execution**, **session-aware multi-turn orchestration**, and **conversation-native grading**
- Preserving the current upstream surface while making these changes would add compatibility work without improving the core multi-turn architecture

Implementation guidance:
- Start from a hard fork or repository copy of skillgrade
- Reuse the existing config loader, grader infrastructure, agent registry, and reporting code where practical
- Remove Docker/provider complexity early and simplify the runtime around a local-only conversation runner

---

## 5. eval.yaml Schema

### Single-turn (existing, unchanged)

```yaml
tasks:
  - name: fix-linting
    instruction: "Fix the linting errors in app.js"
    graders:
      - type: deterministic
        run: bash tests/test.sh
        weight: 1.0
```

### Multi-turn (new)

```yaml
tasks:
  - name: create-project-brief
    conversation:
      # ── Opening message (replaces instruction) ──────────────
      opener: |
        I want to start a new project. I have an idea for a gift card
        feature for online stores.

      # ── Completion conditions (whichever triggers first) ────
      completion:
        max_turns: 10                           # hard cap on turns
        signal: "artifacts/project-brief-*.md"  # file glob, checked after each agent turn
        done_phrase: "brief.*saved|brief.*created" # regex on normalized assistant message
        timeout: 300                            # hard deadline in seconds for entire conversation

      # ── Scripted replies (deterministic) ────────────────────
      replies:
        # Ordered replies (no `when:`) — sent in sequence
        - content: |
            It's for the Wix Stores platform. Online store owners have been
            requesting the ability to sell digital gift cards.

        # Pattern-matched replies — sent when assistant message matches
        - content: "Solve user pain point"
          when: "goal|trying to achieve|what do you want"
        - content: "Self-Creator"
          when: "target|audience|who is this for"
        - content: "Looks good, no changes needed"
          when: "look right|approve|feedback|any changes|edit"

      # ── LLM persona (fallback for unmatched turns) ─────────
      persona:
        description: |
          You are a product manager at Wix who has worked on the Stores
          platform for 2 years. You communicate directly and concisely.
          You don't over-explain. When asked a multiple-choice question,
          pick the most appropriate option without lengthy justification.
        facts:
          - "The feature is for the Wix Stores platform"
          - "Target users are Self-Creators (store owners managing their own shops)"
          - "Goal: solve user pain point — store owners can't offer gift cards"
          - "Direction: custom designs, denominations, email delivery, checkout redemption"
          - "You don't know technical implementation details"
          - "No GitHub repos to link right now"
          - "The project name should be 'gift-card' or similar"
        model: gpt-4o  # optional, defaults to grader_model or auto-detected

      # ── Per-step graders (optional) ─────────────────────────
      step_graders:
        - after_turn: 1
          graders:
            - type: llm_rubric
              rubric: |
                Did the agent introduce the ck-new skill and ask the user
                to describe what they're working on?
              weight: 1.0

        - after_turn: 3
          graders:
            - type: deterministic
              run: |
                if test -d artifacts; then
                  echo '{"score":1,"details":"artifacts/ directory created mid-conversation"}'
                else
                  echo '{"score":0,"details":"artifacts/ not yet created"}'
                fi
              weight: 1.0

    # ── End-of-conversation graders (same as current) ─────────
    graders:
      - type: deterministic
        run: node graders/check-brief.js complete-info
        weight: 0.5
      - type: llm_rubric
        rubric: |
          Evaluate the full multi-turn conversation. Did the agent:
          1. Follow the ck-new intake flow (one question at a time)?
          2. Produce a well-structured project brief?
          3. Handle user responses appropriately?
        weight: 0.5
```

### Field Reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `conversation.opener` | string | Yes | First message sent to the agent. Equivalent to `instruction` for multi-turn. Can be inline text or file path. |
| `conversation.completion` | object | Yes | When to end the conversation. |
| `conversation.completion.max_turns` | number | Yes | Maximum number of agent turns (hard cap). A turn = one agent invocation + response. |
| `conversation.completion.signal` | string | No | File glob pattern. Conversation ends when a matching file exists in the workspace. Checked after each agent turn. |
| `conversation.completion.done_phrase` | string | No | Regex pattern. Conversation ends when the normalized assistant message matches. |
| `conversation.completion.timeout` | number | No | Hard deadline in seconds for the entire conversation. Each turn receives the remaining time budget. |
| `conversation.replies` | array | No | Scripted user replies. At least one of `replies` or `persona` must be defined. |
| `conversation.replies[].content` | string | Yes | The text to send as a user reply. Can be inline or file path. |
| `conversation.replies[].when` | string | No | Regex pattern to match against the normalized assistant message from the preceding turn. If omitted, the reply is ordered (sent in sequence). |
| `conversation.persona` | object | No | LLM-simulated user definition. At least one of `replies` or `persona` must be defined. |
| `conversation.persona.description` | string | Yes | Who the simulated user is — personality, background, communication style. |
| `conversation.persona.facts` | string[] | Yes | Key information the user "knows." The LLM reveals facts when asked, not all at once. |
| `conversation.persona.model` | string | No | LLM model for persona simulation. Defaults to `grader_model` from task/defaults, or auto-detected from API keys. |
| `conversation.step_graders` | array | No | Graders that run at intermediate conversation steps. |
| `conversation.step_graders[].after_turn` | number | Yes | Run graders after this turn completes (1-indexed). Turn 1 = after agent's first response to the opener. |
| `conversation.step_graders[].graders` | EvalGraderConfig[] | Yes | Same grader format as top-level `graders`. |

**Matching semantics:** `replies[].when` and `completion.done_phrase` are evaluated against the normalized assistant-facing message extracted from the CLI output. They never inspect raw command stdout/stderr or wrapper diagnostics.

---

## 6. TypeScript Types

### New Types (src/core/config.types.ts)

```typescript
/** Scripted user reply for multi-turn conversations */
export interface ConversationReply {
    content: string;          // what the "user" says (inline text or file path)
    when?: string;            // regex — send this reply when assistant_message matches
}

/** LLM-simulated user persona */
export interface ConversationPersona {
    description: string;      // who the simulated user is (personality, background, style)
    facts: string[];          // key info the user "knows" — revealed when relevant, not dumped
    model?: string;           // LLM model for simulation (defaults to grader_model)
}

/** Conversation completion conditions — whichever triggers first */
export interface ConversationCompletion {
    max_turns: number;        // hard cap on agent turns
    signal?: string;          // file glob — done when matching file exists in workspace
    done_phrase?: string;     // regex — done when assistant_message matches
    timeout?: number;         // hard deadline in seconds for the entire conversation
}

/** Graders that run at intermediate conversation steps */
export interface StepGrader {
    after_turn: number;       // 1-indexed turn number
    graders: EvalGraderConfig[];
}

/** Multi-turn conversation definition */
export interface ConversationConfig {
    opener: string;                       // first message to agent (inline or file path)
    completion: ConversationCompletion;
    replies?: ConversationReply[];        // scripted replies (tried first)
    persona?: ConversationPersona;        // LLM fallback when no scripted reply matches
    step_graders?: StepGrader[];          // optional per-step grading
}

/** Resolved conversation — all file references resolved to content */
export interface ResolvedConversation {
    opener: string;                       // resolved to inline content
    completion: ConversationCompletion;
    replies?: ResolvedConversationReply[];
    persona?: ConversationPersona;        // description already inline
    step_graders?: ResolvedStepGrader[];
}

export interface ResolvedConversationReply {
    content: string;                      // resolved to inline content
    when?: string;                        // regex string (unchanged)
}

export interface ResolvedStepGrader {
    after_turn: number;
    graders: ResolvedGrader[];
}
```

### Modified Types

```typescript
/** Single eval task — instruction XOR conversation */
export interface EvalTaskConfig {
    name: string;
    instruction?: string;                 // single-turn (existing)
    conversation?: ConversationConfig;    // multi-turn (new)
    workspace?: WorkspaceMapping[];
    graders: EvalGraderConfig[];
    solution?: string;

    // Per-task overrides
    agent?: string;
    trials?: number;
    timeout?: number;
    grader_model?: string;
    environment?: Partial<EnvironmentConfig>;
}

/** Resolved task — instruction XOR conversation */
export interface ResolvedTask {
    name: string;
    instruction?: string;                 // single-turn (existing)
    conversation?: ResolvedConversation;  // multi-turn (new)
    workspace: WorkspaceMapping[];
    graders: ResolvedGrader[];
    solution?: string;
    agent: string;
    trials: number;
    timeout: number;
    grader_model?: string;
    environment: EnvironmentConfig;
}
```

### New Runtime Types (src/types.ts)

```typescript
export interface AgentTurnResult {
    raw_output: string;              // full CLI stdout/stderr for the turn
    assistant_message: string;       // normalized assistant-facing text for matching/grading
}

export interface TurnCommand extends CommandResult {
    command: string;
}

/** A single turn in a multi-turn conversation */
export interface ConversationTurn {
    turn_number: number;          // 1-indexed
    user_message: string;         // what was sent to the agent
    user_message_source: 'opener' | 'scripted' | 'scripted_pattern' | 'persona_llm';
    raw_agent_output: string;     // agent's full CLI output
    assistant_message: string;    // normalized assistant-facing text
    duration_ms: number;          // time for this turn
    commands: TurnCommand[];      // commands the agent ran during this turn
    turn_status: 'completed' | 'error' | 'timeout';
    step_grader_results?: GraderResult[];  // if step_graders ran after this turn
}

/** Extended log entry type for multi-turn */
export interface LogEntry {
    type: 'agent_start' | 'command' | 'agent_result' | 'grader'
        | 'reward' | 'user_reply' | 'step_grader';  // new types
    timestamp: string;
    instruction?: string;
    command?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    output?: string;              // raw CLI output for agent_result, reply text for user_reply
    assistant_message?: string;   // normalized assistant-facing text for agent_result
    value?: number;
    grader_result?: GraderResult;
    // New fields for multi-turn
    turn_number?: number;
    reply_source?: 'scripted' | 'scripted_pattern' | 'persona_llm';
    step_grader_key?: string;     // e.g. "turn_3_0"
}

/** Extended trial result — includes conversation data */
export interface TrialResult {
    trial_id: number;
    reward: number;
    grader_results: GraderResult[];
    duration_ms: number;
    n_commands: number;
    input_tokens: number;
    output_tokens: number;
    session_log: LogEntry[];
    persona_input_tokens?: number;
    persona_output_tokens?: number;
    // New: present only for multi-turn trials
    conversation?: {
        turns: ConversationTurn[];
        total_turns: number;
        completion_reason: 'max_turns' | 'signal' | 'done_phrase'
                         | 'timeout' | 'no_replies' | 'error';
        timeout_triggered_at_turn?: number;
    };
}

export type AbortableRunCommand = (
    cmd: string,
    opts?: { signal?: AbortSignal }
) => Promise<CommandResult>;

/** Extended agent interface — adds session continuation */
export abstract class BaseAgent {
    /** Accumulated transcript for agents without native session continuation */
    protected transcript: Array<{ role: 'user' | 'agent'; content: string }> = [];

    /** Single-turn execution (existing) */
    abstract run(
        instruction: string,
        workspacePath: string,
        runCommand: AbortableRunCommand
    ): Promise<AgentTurnResult>;

    /** Multi-turn: send a message continuing the conversation.
     *  Default implementation uses transcript accumulation — the full
     *  conversation history is re-sent each turn. Agents with native
     *  session continuation (e.g., Claude's -c flag) override this. */
    async continueSession(
        message: string,
        workspacePath: string,
        runCommand: AbortableRunCommand
    ): Promise<AgentTurnResult> {
        // Default: transcript accumulation fallback
        this.transcript.push({ role: 'user', content: message });
        const fullPrompt = this.transcript
            .map(t => `${t.role === 'user' ? 'User' : 'Agent'}: ${t.content}`)
            .join('\n\n');
        const result = await this.run(fullPrompt, workspacePath, runCommand);
        this.transcript.push({ role: 'agent', content: result.assistant_message });
        return result;
    }

    /** Reset session state between trials. MUST be called before each trial. */
    async resetSession(): Promise<void> {
        this.transcript = [];
    }
}

/**
 * IMPORTANT: Parallel trial safety
 *
 * Multi-turn agents are stateful (session IDs, transcript arrays).
 * Parallel trials on the same agent instance will cause state contamination.
 *
 * Rule: EvalRunner accepts an agent factory and creates a NEW agent instance
 * per trial for both single-turn and multi-turn tasks.
 */
```

---

## 7. Execution Flow

### Single-Turn Flow (unchanged)

```
runSingleTrial()
  → agent.run(instruction)
  → grade()
  → return TrialResult
```

### Multi-Turn Flow (new)

```
runConversationTrial(agent, conversation, ...)
  │
  ├─ agent.resetSession()
  │
  ├─ effectiveTimeoutSec = conversation.completion.timeout ?? opts.timeoutSec
  ├─ deadlineMs = now + effectiveTimeoutSec * 1000
  │
  ├─ Turn 1: OPENER
  │   ├─ remainingMs = deadlineMs - now
  │   ├─ agent.run(conversation.opener, workspace, abortableRunCommand(remainingMs))
  │   ├─ normalize assistant_message from raw_output
  │   ├─ log: agent_start(opener) + agent_result(raw_output, assistant_message)
  │   ├─ checkCompletion(assistant_message, workspace) → continue or done
  │   ├─ runStepGraders(turn=1) if defined
  │   └─ pickReply(assistant_message, replyPool, persona) → nextMessage
  │
  ├─ Turn 2..N: CONTINUATION
  │   ├─ log: user_reply(nextMessage, source)
  │   ├─ remainingMs = deadlineMs - now
  │   ├─ agent.continueSession(nextMessage, workspace, abortableRunCommand(remainingMs))
  │   ├─ normalize assistant_message from raw_output
  │   ├─ log: agent_result(raw_output, assistant_message)
  │   ├─ checkCompletion(assistant_message, workspace) → continue or done
  │   ├─ runStepGraders(turn=N) if defined
  │   └─ pickReply(assistant_message, replyPool, persona) → nextMessage
  │
  ├─ (loop until completion condition met)
  │
  ├─ End-of-conversation grading
  │   ├─ deterministic graders (check workspace state)
  │   └─ LLM rubric graders (full conversation transcript)
  │
  └─ return TrialResult with conversation data
```

### Integration with Existing EvalRunner

The orchestration layer must branch between single-turn and multi-turn across configuration, agent construction, runner dispatch, and task staging:

**Level 1: `commands/run.ts` → `EvalRunOptions`**

The `EvalRunOptions` interface gains an optional `conversation` field. When a task has `conversation:`, the instruction field is left undefined and the conversation config is passed instead:

```typescript
// In commands/run.ts, when building evalOpts:
const evalOpts: EvalRunOptions = resolved.conversation
    ? {
        instruction: undefined,
        conversation: resolved.conversation,
        graders: resolved.graders,
        timeoutSec: resolved.conversation.completion.timeout ?? resolved.timeout,
        graderModel: resolved.grader_model,
        environment: resolved.environment,
    }
    : {
        instruction: resolved.instruction!,
        graders: resolved.graders,
        timeoutSec: resolved.timeout,
        graderModel: resolved.grader_model,
        environment: resolved.environment,
    };
```

`commands/run.ts` also switches from passing a concrete agent instance to passing an agent factory:

```typescript
const agentFactory = () => createAgent(agentName);
await runner.runEval(agentFactory, taskPath, skillsPaths, evalOpts, trials, env, parallel);
```

**Level 2: `evalRunner.ts` → fresh agent per trial**

Inside `runSingleTrial()`, the method creates a fresh agent and then checks for conversation mode:

```typescript
const agent = agentFactory();

if (opts.conversation) {
    return this.runConversationTrial(agent, taskPath, skillsPaths, opts, index, total, env);
} else {
    // existing single-turn logic (unchanged)
}
```

The `runConversationTrial()` method lives in a new `src/conversationRunner.ts` module, imported by `EvalRunner`. It returns the same `TrialResult` type, augmented with the `conversation` field.

**Level 3: `resolveTask()` in `config.ts`**

The `resolveTask()` function must handle the new conversation field:

```typescript
function resolveConversation(conv: ConversationConfig, baseDir: string): ResolvedConversation {
    return {
        opener: resolveFileOrInline(conv.opener, baseDir),
        completion: conv.completion,
        replies: conv.replies?.map(r => ({
            content: resolveFileOrInline(r.content, baseDir),
            when: r.when,
        })),
        persona: conv.persona,
        step_graders: conv.step_graders?.map(sg => ({
            after_turn: sg.after_turn,
            graders: sg.graders.map(g => resolveGrader(g, baseDir)),
        })),
    };
}
```

**Level 4: `prepareTempTaskDir()` in `commands/run.ts`**

For multi-turn tasks, `prepareTempTaskDir()` stages local artifacts only:
- copies workspace files into the temp task directory
- writes end-of-conversation grader scripts/prompts
- writes step grader scripts/prompts into dedicated subdirectories

The opener is not written to a file; it is passed at runtime. Step grader assets MUST use a separate namespace to avoid collisions:

```text
tests/test.sh
tests/test_1.sh
tests/steps/turn_1_0.sh
tests/steps/turn_3_0.sh

prompts/quality.md
prompts/quality_1.md
prompts/steps/turn_1_0.md
```

### Detailed Sequence Diagram

```
┌─────────┐    ┌────────────────┐    ┌───────────┐    ┌──────────┐    ┌─────────────┐
│EvalRunner│    │ConversationRunner│   │ReplyPicker│    │  Agent   │    │LocalProvider│
└────┬─────┘    └───────┬────────┘    └─────┬─────┘    └────┬─────┘    └─────┬──────┘
     │                  │                   │               │               │
     │  runConvTrial()  │                   │               │               │
     │─────────────────►│                   │               │               │
     │                  │                   │               │     setup()   │
     │                  │───────────────────────────────────────────────────►│
     │                  │                   │               │    workspace  │
     │                  │◄──────────────────────────────────────────────────│
     │                  │                   │               │               │
     │                  │          run(opener, workspace)   │               │
     │                  │──────────────────────────────────►│               │
     │                  │      raw_output_1 + message_1     │               │
     │                  │◄─────────────────────────────────│               │
     │                  │                   │               │               │
     │                  │ checkCompletion() │               │               │
     │                  │──┐                │               │               │
     │                  │  │ not done       │               │               │
     │                  │◄─┘                │               │               │
     │                  │                   │               │               │
     │                  │ runStepGraders(1) │               │               │
     │                  │──┐                │               │               │
     │                  │  │ (if defined)   │               │               │
     │                  │◄─┘                │               │               │
     │                  │                   │               │               │
     │                  │ pickReply(message_1) │            │               │
     │                  │──────────────────►│               │               │
     │                  │    reply_text     │               │               │
     │                  │◄─────────────────│               │               │
     │                  │                   │               │               │
     │                  │    continueSession(reply_text)    │               │
     │                  │──────────────────────────────────►│               │
     │                  │      raw_output_2 + message_2     │               │
     │                  │◄─────────────────────────────────│               │
     │                  │                   │               │               │
     │                  │ checkCompletion() │               │               │
     │                  │──┐                │               │               │
     │                  │  │ DONE (signal)  │               │               │
     │                  │◄─┘                │               │               │
     │                  │                   │               │               │
     │   TrialResult    │                   │               │               │
     │◄─────────────────│                   │               │               │
     │                  │                   │               │               │
```

---

## 8. Reply Dispatch System

### Matching Surface

Reply dispatch uses `assistant_message`, not raw CLI output. `assistant_message` is the normalized, user-visible assistant text extracted from the turn's `raw_output`.

Rules:
- `replies[].when` matches against `assistant_message`
- `completion.done_phrase` matches against `assistant_message`
- persona prompts receive `assistant_message`
- raw CLI output remains in the logs for debugging and grading context

If extraction fails or produces an empty string, the system falls back to `raw_output.trim()` and logs that the turn used raw-output matching.

### Dispatch Algorithm

Each time the agent responds and the conversation hasn't ended, the system picks the next user reply:

```
pickReply(assistantMessage, replyPool, persona, transcript) → { content, source }

  1. PATTERN-MATCHED REPLIES
     Iterate through patternReplies in array order (position in eval.yaml).
     For each, test: new RegExp(reply.when, 'i').test(assistantMessage)
     On the FIRST match:
       → Remove from pool (don't reuse, don't continue scanning)
       → Return { content: reply.content, source: 'scripted_pattern' }
     If no pattern matches, fall through to step 2.

  2. ORDERED REPLIES
     If orderedQueue is non-empty:
       → Shift first item from queue
       → Return { content: reply.content, source: 'scripted' }

  3. PERSONA LLM
     If persona is defined:
       → Call LLM with persona prompt + transcript + assistantMessage
       → Return { content: llmResponse, source: 'persona_llm' }

  4. NO REPLY AVAILABLE
     → Return null (triggers conversation end with reason 'no_replies')
```

### Reply Pool Initialization

At the start of each trial, the reply pool is initialized:

```typescript
interface ReplyPool {
    patternReplies: Array<{ content: string; when: RegExp }>;  // replies with when:
    orderedQueue: string[];                                      // replies without when:
}
```

```
conversation.replies = [
  { content: "A" },                           → orderedQueue: ["A", "B"]
  { content: "B" },
  { content: "C", when: "goal" },             → patternReplies: [
  { content: "D", when: "target|audience" }       { content: "C", when: /goal/i },
]                                                  { content: "D", when: /target|audience/i }
                                                ]
```

### Dispatch Examples

**Example 1: Agent asks in expected order**
```
Agent: "Tell me what you're working on"
  → No pattern match → orderedQueue.shift() → "A" (scripted)
Agent: "What's your goal?"
  → Pattern match: "goal" matches → "C" (scripted_pattern)
Agent: "Who's the target?"
  → Pattern match: "target" matches → "D" (scripted_pattern)
Agent: "Anything else?"
  → No pattern match → orderedQueue.shift() → "B" (scripted)
```

**Example 2: Agent asks in unexpected order**
```
Agent: "Who's the target audience?"
  → Pattern match: "audience" matches → "D" (scripted_pattern)
Agent: "Tell me more"
  → No pattern match → orderedQueue.shift() → "A" (scripted)
Agent: "What's the goal?"
  → Pattern match: "goal" matches → "C" (scripted_pattern)
Agent: "Looks good?"
  → No pattern match → orderedQueue.shift() → "B" (scripted)
```

**Example 3: Mixed scripted + persona**
```
Agent: "What are you working on?"
  → No pattern match → orderedQueue.shift() → "A" (scripted)
Agent: "Can you tell me more about the technical constraints?"
  → No pattern match → orderedQueue empty → persona LLM generates response
Agent: "What's your goal?"
  → Pattern match: "goal" matches → "C" (scripted_pattern)
```

---

## 9. LLM Persona Simulation

### Prompt Construction

When the persona LLM needs to generate a reply, the system builds this prompt from the normalized conversation transcript:

```
You are simulating a user in a conversation with an AI assistant.

## Who You Are
{persona.description}

## What You Know
You have these facts available. Reveal them naturally when asked — don't
dump everything at once. If asked about something not in your facts,
say you don't know or haven't decided yet.

{persona.facts.map(f => `- ${f}`).join('\n')}

## Conversation So Far
{transcript — all previous turns formatted as:
  User: {message}
  Agent: {assistant_message}
}

## Agent's Latest Message
{assistantMessage}

## Instructions
Respond as the user would. Be concise and natural. If the agent asks a
multiple-choice question, pick the most appropriate option based on your
facts. If the agent asks for confirmation, confirm if the content matches
your facts. Do not break character. Do not explain that you are simulating.
Respond with plain text only. Do not invoke any tools or functions.

Your response:
```

### API Call

The persona LLM call uses the same infrastructure as the LLM rubric grader (same API key detection, same fallback chain: Gemini → Anthropic → OpenAI).

```typescript
async function generatePersonaReply(
    persona: ConversationPersona,
    transcript: ConversationTurn[],
    assistantMessage: string,
    env?: Record<string, string>
): Promise<string> {
    const prompt = buildPersonaPrompt(persona, transcript, assistantMessage);
    const model = persona.model;  // or auto-detect

    // Reuse LLM infrastructure from graders
    // Same fallback: Gemini → Anthropic → OpenAI
    const response = await callLLM(prompt, model, env);
    return response.trim();
}
```

### Token Estimation

Each persona LLM call adds to token counts. The `TrialResult` gains two new optional fields for multi-turn trials:

```typescript
interface TrialResult {
    // ... existing fields ...
    persona_input_tokens?: number;   // total tokens sent to persona LLM across all turns
    persona_output_tokens?: number;  // total tokens received from persona LLM
}
```

For the existing `input_tokens` and `output_tokens` fields, multi-turn calculation changes:
- `input_tokens` = sum of `estimateTokens(message)` for all user messages sent to the agent
- `output_tokens` = sum of `estimateTokens(turn.assistant_message)` for all assistant messages returned to the simulated user

This reflects total agent I/O, not per-turn. Persona tokens are separate because they represent a different cost center (grading LLM vs. agent LLM).

---

## 10. Agent Session Continuation

### The Problem

Agent CLIs are designed for single-shot execution. Multi-turn requires maintaining conversation state across invocations.

### Local Provider Requirement: Trial Persistence + Session Isolation

Skillgrade runs **locally only**. Multi-turn conversations issue multiple `runCommand()` calls within a single trial, so the local provider must satisfy two constraints:

1. **Persistence within a trial:** the workspace and agent session files must survive across turns.
2. **Isolation across trials:** one trial's `~/.claude`, `~/.config`, temp files, and resume state must not be visible to another trial.

Required `LocalProvider` behavior:
- `setup()` creates a unique trial root with `workspace/`, `home/`, `xdg/`, and `tmp/`
- every `runCommand()` uses `cwd = workspace`
- every `runCommand()` injects `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, and `TMPDIR` pointing into that trial root
- `cleanup()` removes the entire trial root

This is a required provider change. `cwd` isolation alone is not sufficient because most agent CLIs store continuation state under home/config directories, not under the task workspace.

### Abortable Local Command Execution

The local provider's `runCommand()` must support cancellation via `AbortSignal`. On abort:
- send `SIGTERM` to the spawned child process
- wait a short grace period
- send `SIGKILL` if the process is still alive
- return a `CommandResult` marked as timed out/killed so the runner can record the turn correctly

### Agent-Specific Continuation Mechanisms

#### Claude CLI

```bash
# Turn 1: initial message
claude -p "opener message" --dangerously-skip-permissions
# → Saves session to isolated HOME/.claude automatically

# Turn 2+: continue the session
claude -p "user reply" -c --dangerously-skip-permissions
# -c continues the most recent session in the isolated HOME/current workspace
```

The `-c` flag is the key. It tells Claude to load the previous session and append the new message as a continuation.

**Implementation:**

```typescript
export class ClaudeAgent extends BaseAgent {
    async run(instruction: string, workspace: string,
              runCommand: AbortableRunCommand): Promise<AgentTurnResult> {
        const b64 = Buffer.from(instruction).toString('base64');
        await runCommand(`mkdir -p .skillgrade && echo '${b64}' | base64 -d > .skillgrade/prompt.md`);

        const command = `claude -p --dangerously-skip-permissions "$(cat .skillgrade/prompt.md)"`;
        const result = await runCommand(command);
        const raw = result.stdout + '\n' + result.stderr;
        return {
            raw_output: raw,
            assistant_message: this.extractAssistantMessage(raw),
        };
    }

    async continueSession(message: string, workspace: string,
                           runCommand: AbortableRunCommand): Promise<AgentTurnResult> {
        const b64 = Buffer.from(message).toString('base64');
        await runCommand(`mkdir -p .skillgrade && echo '${b64}' | base64 -d > .skillgrade/prompt.md`);

        // -c continues the most recent session in the isolated HOME
        const command = `claude -p -c --dangerously-skip-permissions "$(cat .skillgrade/prompt.md)"`;
        const result = await runCommand(command);
        const raw = result.stdout + '\n' + result.stderr;
        return {
            raw_output: raw,
            assistant_message: this.extractAssistantMessage(raw),
        };
    }

    async resetSession(): Promise<void> {
        this.transcript = [];
    }
}
```

`extractAssistantMessage()` is agent-specific. If the CLI output is already plain assistant text, it may simply return `raw.trim()`.

#### Gemini CLI

```bash
# Turn 1
gemini -y --sandbox=none -p "opener"

# Turn 2+ (session continuation — needs verification)
gemini -y --sandbox=none -p "reply" --resume-last
```

**Note:** Gemini CLI's session continuation mechanism needs to be verified. If it doesn't support native continuation, the fallback is to pass the full conversation transcript in each invocation:

```bash
gemini -y --sandbox=none -p "$(cat .skillgrade/full-transcript.md)"
```

Where the transcript accumulates all previous turns.

#### Codex CLI

```bash
# Turn 1
codex --approval-mode full-auto "opener"

# Turn 2+ (needs verification)
codex --approval-mode full-auto --resume "reply"
```

**Note:** Same verification needed as Gemini.

### Fallback: Transcript Accumulation

For agents without native session continuation, the system accumulates the full conversation and re-sends it each turn:

```typescript
class TranscriptAccumulatingAgent extends BaseAgent {
    private transcript: string[] = [];

    async run(instruction: string, workspace: string,
              runCommand: AbortableRunCommand): Promise<AgentTurnResult> {
        this.transcript.push(`User: ${instruction}`);
        return this.executeWithFullTranscript(workspace, runCommand);
    }

    async continueSession(message: string, workspace: string,
                           runCommand: AbortableRunCommand): Promise<AgentTurnResult> {
        this.transcript.push(`User: ${message}`);
        return this.executeWithFullTranscript(workspace, runCommand);
    }

    private async executeWithFullTranscript(workspace: string,
        runCommand: AbortableRunCommand): Promise<AgentTurnResult> {
        const fullPrompt = this.transcript.join('\n\n');
        // Write to file and invoke agent with full transcript
        // ...
        const raw = /* raw CLI output */;
        const assistantMessage = /* extract visible assistant text */;
        this.transcript.push(`Agent: ${assistantMessage}`);
        return { raw_output: raw, assistant_message: assistantMessage };
    }

    async resetSession(): Promise<void> {
        this.transcript = [];
    }
}
```

---

## 11. Conversation Completion

### Completion Check Order

The conversation uses a hard deadline established before turn 1:

```text
effectiveTimeoutSec = config.timeout ?? task.timeout
deadlineMs = startTime + effectiveTimeoutSec * 1000
```

Before each turn:
- compute `remainingMs = deadlineMs - now`
- if `remainingMs <= 0`, stop immediately with `completion_reason: 'timeout'`
- pass `remainingMs` into the turn's `AbortSignal`

After each successful agent turn, the system checks completion conditions in this order:

```
checkCompletion(assistantMessage, workspace, turnNumber, config)

  1. FILE SIGNAL
     if config.signal:
       matches = glob(config.signal, workspace)
       if matches.length > 0 → return { done: true, reason: 'signal' }

  2. DONE PHRASE
     if config.done_phrase:
       if new RegExp(config.done_phrase, 'i').test(assistantMessage)
         → return { done: true, reason: 'done_phrase' }

  3. MAX TURNS
     if turnNumber >= config.max_turns → return { done: true, reason: 'max_turns' }

  4. NOT DONE
     return { done: false }
```

### Completion Reason Reporting

The completion reason is recorded in the trial result:

```json
{
  "conversation": {
    "total_turns": 5,
    "completion_reason": "signal",
    "turns": [...]
  }
}
```

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Timeout during agent execution | The turn's `AbortSignal` aborts `runCommand()`. The local provider kills the child process. Current turn is logged with `turn_status: 'timeout'`. Conversation ends. |
| Signal file created mid-turn | Detected only after the agent turn completes (not real-time). |
| Max turns = 1 | Effectively single-turn. Agent responds to opener, then grading. |
| No completion conditions met but no replies left | Conversation ends with reason `no_replies`. |
| Agent crashes mid-conversation | Turn logged with error. Conversation ends. Graders run on partial state. |
| done_phrase matches on turn 1 | Conversation ends immediately. Only opener turn is logged. |
| Step grader defined for the turn that triggers completion | Step grader runs before end-of-conversation graders. Completion detection happens first, then step graders for that turn, then end-of-conversation graders. |
| Assistant-message extraction returns empty text | System falls back to `raw_output.trim()` for matching and logs the fallback. |

---

## 12. Per-Step Grading

### When Step Graders Run

Step graders run after the specified agent turn completes and before the next reply is picked:

```
Agent responds (turn N)
  → checkCompletion()
  → runStepGraders(turn N)      ← HERE
  → pickReply() for turn N+1
```

### Step Grader Execution

Step graders use the same grading infrastructure as end-of-conversation graders:
- **Deterministic:** runs a command in the workspace (checks file state at that point)
- **LLM rubric:** evaluates the conversation transcript up to that turn

Step grader assets are materialized in separate namespaces so they cannot collide with end-of-conversation grader assets:
- deterministic: `tests/steps/turn_<after_turn>_<idx>.sh`
- llm rubric: `prompts/steps/turn_<after_turn>_<idx>.md`

```typescript
for (const sg of conversation.step_graders) {
    if (sg.after_turn === currentTurn) {
        for (const [graderIdx, graderDef] of sg.graders.entries()) {
            const grader = getGrader(graderDef.type);
            const result = await grader.grade(workspace, provider, graderConfig,
                                               taskPath, sessionLog, env);
            stepGraderResults.push(result);
            sessionLog.push({
                type: 'step_grader',
                timestamp: now(),
                turn_number: currentTurn,
                step_grader_key: `turn_${currentTurn}_${graderIdx}`,
                grader_result: result
            });
        }
    }
}
```

### Step Grader Results in Scoring

Step grader results are reported separately from end-of-conversation graders. They do NOT contribute to the trial's `reward` by default — they are informational.

**Rationale:** Step graders verify process compliance (did the agent ask the right question at step 2?). End-of-conversation graders verify outcomes (did the agent produce a correct brief?). Mixing them in the reward calculation would conflate process and outcome.

Step grader results appear in:
- `TrialResult.conversation.turns[N].step_grader_results`
- `TrialResult.session_log` entries with `type: 'step_grader'`

---

## 13. Session Logging

### Extended Log Format

Multi-turn conversations produce richer session logs with new entry types:

```typescript
// Existing types (unchanged)
{ type: 'agent_start',  instruction: "opener text",     turn_number: 1 }
{ type: 'command',       command: "ls",  stdout: "...",  turn_number: 1 }
{ type: 'agent_result',  output: "<raw cli output>",
  assistant_message: "agent response",                  turn_number: 1 }

// New types
{ type: 'user_reply',    output: "scripted reply",
  reply_source: 'scripted', turn_number: 2 }
{ type: 'agent_result',  output: "<raw cli output>",
  assistant_message: "agent response 2",                turn_number: 2 }
{ type: 'step_grader',   grader_result: {...},
  step_grader_key: "turn_2_0",                          turn_number: 2 }

{ type: 'user_reply',    output: "persona LLM reply",
  reply_source: 'persona_llm', turn_number: 3 }
{ type: 'agent_result',  output: "<raw cli output>",
  assistant_message: "agent response 3",                turn_number: 3 }

// End
{ type: 'reward',        value: 0.85 }
```

### LLM Rubric Transcript for Multi-Turn

The LLM rubric grader builds its transcript differently for multi-turn conversations. It must iterate through all conversation turns, using `assistant_message` for the dialogue and `command` log entries for tool context:

```
## Conversation Transcript

### Turn 1 (opener)
**User:** I want to start a new project...
**Agent:** Great! Tell me more about what you're working on...
Commands: ls .agents/skills/ → superlint, ck-new, ...

### Turn 2 (scripted reply)
**User:** It's for the Wix Stores platform...
**Agent:** Sounds like this is in the Stores domain — right?
Commands: node detect-phase.js .

### Turn 3 (persona_llm)
**User:** Yes, that's right.
**Agent:** What's your primary goal?
Commands: (none)

...

### Workspace State After Conversation
artifacts/project-brief-gift-card.md exists (1.2 KB)
```

---

## 14. CI / GitHub Actions

### Goal

The new tool must remain usable in **non-interactive CI**, with GitHub Actions as the primary automation target.

### CI Modes

#### Pull Request CI

Run on every pull request:
- TypeScript build
- Unit tests
- Deterministic/scripted conversation evals
- Fast smoke checks that do not require fragile live agent authentication when possible

#### Main Branch / Scheduled CI

Run on `main` and/or nightly:
- Live agent-backed smoke evals
- Selected persona-driven end-to-end evals
- Regression suites that are too expensive or too noisy for every PR

### CI Contract

The CLI should preserve a simple CI contract:
- `--ci` causes the process to exit non-zero on failure
- `--threshold=<number>` defines the required pass-rate threshold
- CI systems should treat process exit code as the source of truth

### Runner Model

“Local-only” includes:
- developer laptops
- self-hosted runners
- GitHub-hosted runners

The runtime must not depend on Docker. All evaluation logic should run directly on the runner host in an isolated per-trial directory.

### Secrets And Authentication

Agent-backed CI jobs require non-interactive authentication:
- API keys for grader/persona LLM calls
- any required credentials or bootstrap flow for the target agent CLI

If an agent CLI cannot be authenticated reliably on GitHub-hosted runners, use one of:
- a self-hosted runner
- a CI-only execution mode for that agent
- excluding that agent from PR CI and running it only in scheduled environments

### Risks

CI-specific risks:
- agent CLI installation or version drift on runners
- authentication bootstrap failures
- flaky live evals due to model variance
- API cost and rate limits
- parallel trial resource contention on shared runners

### Recommendation

Use a two-lane CI strategy:
- PR lane: build, tests, deterministic/scripted evals
- Scheduled lane: live agent-backed evals with stricter environment control

---

## 15. Migration Compatibility

### Scope

This project is a new repository derived from skillgrade, so the main compatibility target is **existing eval authoring concepts and existing eval.yaml content where reasonable**, not source-level compatibility with the upstream codebase.

### Migration Goals

- Existing single-turn evals using `instruction:` should continue to work with minimal or no changes
- Existing grader definitions should remain valid where possible
- Existing task authors should be able to migrate incrementally to `conversation:` without rewriting unrelated grader logic

### Expected Migrations

| Existing usage | Migration |
|----------------|-----------|
| `instruction:` single-turn task | No change required |
| task-level `timeout:` | Still supported; used as fallback when `conversation.completion.timeout` is not set |
| `provider: docker` or `docker:` config | Remove; the new tool is local-only |
| custom logic reading session logs | Update for new log entry types and normalized assistant messages |

### Required Runtime Changes

The existing single-turn assumptions must be relaxed:
- tasks may define `instruction` or `conversation`
- agent execution must return normalized per-turn results, not only raw output
- transcript grading must consume the entire conversation, not just a single final agent output

### Validation Rule

A task must define at least one of:
- `instruction`
- `conversation`

---

## 16. Error Handling

### Error Scenarios

| Error | Handling | Trial Impact |
|-------|----------|-------------|
| Agent crashes on turn N | Log error, end conversation with `completion_reason: 'error'`. Run end-of-conversation graders on partial state. | Score likely 0 — graders check final state which is incomplete |
| Persona LLM call fails | Log error. Try once more. If still fails, end conversation with `completion_reason: 'error'`. | Partial conversation graded |
| Pattern match produces multiple matches | First match wins (order defined by position in `replies:` array) | Deterministic |
| No reply available and no persona | End conversation with `completion_reason: 'no_replies'` | Graders run on whatever state exists |
| Agent continuation flag not supported | Fall back to transcript accumulation (re-send full history) | May produce different results than native continuation |
| Step grader fails/times out | Log error for that step grader. Continue conversation. Error recorded in step_grader_results. | Process continues — step grader failure doesn't halt conversation |
| File signal glob matches before opener completes | Not possible — signal checked only after each agent turn | N/A |
| Assistant-message extraction fails | Fall back to raw output for matching and persona input. Record the fallback in logs. | Conversation continues, but matching may be noisier |

### Timeout Handling

Conversation-level timeout is enforced by a hard deadline plus abortable local command execution:

```typescript
const conversationTimeoutSec = conversation.completion.timeout
    ?? opts.timeoutSec;
const deadlineMs = Date.now() + conversationTimeoutSec * 1000;

while (!done) {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return timeoutResult();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
        const turn = await agent.continueSession(message, workspace, (cmd, opts) =>
            runCommand(cmd, { ...opts, signal: controller.signal })
        );
        // ... completion check ...
    } finally {
        clearTimeout(timer);
    }
}
```

The existing promise-only `withTimeout` helper is not sufficient for multi-turn, because it rejects without killing the underlying child process.

---

## 17. Example: ck-new Evaluation

### Complete eval.yaml

```yaml
version: "1"

skill: /Users/nadavlac/.claude/skills/ck-new

defaults:
  agent: claude
  trials: 5
  timeout: 300
  threshold: 0.6

tasks:
  # ── Scripted: all answers pre-defined ─────────────────────────
  - name: scripted-gift-card
    conversation:
      opener: |
        I want to start a new project. I have an idea for a gift card feature.

      completion:
        max_turns: 12
        signal: "artifacts/project-brief-*.md"
        timeout: 300

      replies:
        - content: |
            It's for the Wix Stores platform. Online store owners have been
            requesting the ability to sell digital gift cards that customers
            can purchase and redeem at checkout.
        - content: "Yes, that's right"
          when: "right\\?|correct\\?|confirm"
        - content: "Solve user pain point"
          when: "goal|trying to achieve"
        - content: "Self-Creator"
          when: "target|audience|who"
        - content: "No, skip the gameplan"
          when: "gameplan|strategy doc"
        - content: "Looks good, no changes"
          when: "look right|approve|feedback|changes|edit"
        - content: "No, skip repos for now"
          when: "github|repo|reference"

    graders:
      - type: deterministic
        run: node graders/check-brief.js complete-info
        weight: 0.5
      - type: llm_rubric
        rubric: |
          Evaluate the multi-turn conversation for ck-new skill compliance.

          Workflow (0-0.4):
          - Did the agent ask questions one at a time (not multiple in one message)?
          - Did the agent follow check→direction→goal→target flow?
          - Did it offer structured choices for Goal and Target Group?

          Brief Quality (0-0.4):
          - Is the brief at artifacts/project-brief-*.md?
          - Does it have all required sections (Context, Direction, Goal, Target Group)?
          - Is content refined (not just echoing user replies)?

          Conversation Quality (0-0.2):
          - Was the conversation efficient (no unnecessary back-and-forth)?
          - Did the agent react naturally to user responses?
        weight: 0.5

  # ── Persona: LLM-simulated PM ────────────────────────────────
  - name: persona-gift-card
    conversation:
      opener: |
        I want to start a new project. I have an idea for a feature
        related to gift cards for online stores.

      completion:
        max_turns: 15
        signal: "artifacts/project-brief-*.md"
        timeout: 300

      persona:
        description: |
          You are a product manager at Wix who has worked on the Stores
          platform for 2 years. You communicate directly and concisely.
          When asked a multiple-choice question, pick the most appropriate
          option. When asked for confirmation, confirm if correct. You're
          collaborative but don't volunteer extra information unless asked.
        facts:
          - "The feature is for the Wix Stores platform"
          - "Target users are Self-Creators (store owners managing their own shops)"
          - "Goal: solve user pain point — store owners can't offer gift cards and lose revenue"
          - "Direction: custom gift card designs, set denominations, email delivery, checkout redemption"
          - "You don't know technical implementation details"
          - "No GitHub repos to link right now"
          - "No gameplan link available"
          - "The project name should be 'gift-card' or similar"
        model: gpt-4o

      step_graders:
        - after_turn: 1
          graders:
            - type: llm_rubric
              rubric: |
                Did the agent introduce itself and ask the user to describe
                what they're working on? (Score 1.0 if yes, 0.0 if it
                immediately started generating a brief without asking.)
              weight: 1.0

    graders:
      - type: deterministic
        run: node graders/check-brief.js complete-info
        weight: 0.5
      - type: llm_rubric
        rubric: |
          Evaluate the full persona-driven conversation.

          Skill Discovery (0-0.2):
          - Did the agent discover and use ck-new?

          Conversation Flow (0-0.4):
          - One question per turn?
          - Adapted to user's communication style?
          - Handled open-ended responses well?

          Brief Quality (0-0.4):
          - Complete brief with all sections?
          - Content matches the facts the persona provided?
          - Project name reasonable?
        weight: 0.5
```

---

## 18. Implementation Plan

### Phase 0: Fork Bootstrap + CI Scaffolding (est. scope: small)

**Files changed:**
- `package.json` — rename package/bin, remove stale upstream metadata
- `README.md` — describe the new project as local-only and conversation-first
- `ARCHITECTURE.md` — replace Docker-centric architecture with local isolated trial roots
- `.github/workflows/*.yml` — add GitHub Actions for build/test and eval CI
- `src/skillgrade.ts` — preserve `--ci` / `--threshold` contract while removing provider-related flags over time

**Goals:**
- create the new repository baseline
- keep build/test green
- preserve CI entrypoints early so later runtime work stays automation-friendly

### Phase 1: Core Types & Config (est. scope: small) — COMPLETE

**Status:** Implemented with deviations from original design.

**Files changed:**
- `src/core/config.types.ts` — add ConversationConfig, ConversationReply, ConversationPersona, ConversationCompletion, StepGrader types
- `src/core/config.ts` — update `validateConfig()` to handle instruction XOR conversation, reject deprecated `provider`/`docker` fields, add `resolveConversation()` for file reference resolution
- `src/types.ts` — add AgentTurnResult, ConversationTurn, extend LogEntry, extend TrialResult, extend BaseAgent with `continueSession()`, `resetSession()`, and abortable command execution
- `src/evalRunner.ts` — make `EvalRunOptions.instruction` optional and adapt single-turn execution/logging to `AgentTurnResult`
- `src/commands/init.ts` — remove Docker-related scaffolding from generated evals
- `src/skillgrade.ts` — remove Docker/provider CLI surface area

**Deviations from design:**
- Type naming uses `Config` suffix: `ConversationReplyConfig`, `ConversationPersonaConfig`, `ConversationCompletionConfig` (design said `ConversationReply`, `ConversationPersona`, `ConversationCompletion`)
- `AgentTurnResult` uses camelCase (`rawOutput`, `assistantMessage`) and adds `exitCode` (design said `raw_output`, `assistant_message`, no exitCode)
- `BaseAgent.run()` returns `Promise<string>` not `Promise<AgentTurnResult>` — adapter in `createAgentSession()` wraps it
- Agent interface uses session-object pattern (`createSession()` → `AgentSession` with `start()`/`reply()`) instead of the design's stateful-agent pattern (`continueSession()`/`resetSession()` on agent). Session-object pattern is better — state lives in closures, not on the agent instance.
- `StepGrader` types not yet added (deferred to Phase 5)
- Added types not in original design: `TrialRuntime`, `TrialPaths`, `AgentSession`, `AgentTurnInput`, `AgentCommandRunner`

### Phase 2: Local Runtime Isolation + Agent Session Continuation + CI-Safe Execution (est. scope: medium) — COMPLETE

**Status:** Implemented. Agent factory gap fixed in Phase 4.5.

**Files changed:**
- `src/providers/local.ts` — create isolated trial root (`workspace`, `home`, `xdg`, `tmp`) and implement abortable child-process execution
- `src/providers/docker.ts` — remove
- `src/commands/run.ts` — remove Docker provider selection and Dockerfile generation; stage local grader assets only
- `package.json` — remove Docker dependencies
- `src/agents/claude.ts` — implement `continueSession()` using `-c` flag
- `src/agents/gemini.ts` — implement `continueSession()` (verify CLI flags, fallback to transcript)
- `src/agents/codex.ts` — implement `continueSession()` (verify CLI flags, fallback to transcript)
- `src/agents/registry.ts` — expose an agent factory for per-trial agent creation
- verify the runtime works on GitHub Actions runners without Docker
- define which eval suites run on PRs vs scheduled workflows

**Deviations from design:**
- Agents use `createSession()` returning `AgentSession` instead of `continueSession()`/`resetSession()` methods (see Phase 1 deviations)
- Agent factory exists in `registry.ts` (`createAgent()`) — fixed in Phase 4.5: `runEval()` now accepts `agentFactory: () => BaseAgent` and each trial creates a fresh instance.

### Phase 3: Conversation Runner (est. scope: medium) — COMPLETE

**Status:** Implemented. Also includes `src/persona.ts` for persona reply generation.

**New files:**
- `src/conversationRunner.ts`
- `src/persona.ts`

Core logic:
- `runConversationTrial()` — orchestrates the multi-turn loop
- `ReplyPicker` — implements the dispatch algorithm (pattern → ordered → persona)
- `PersonaLLM` — generates simulated user replies (reuses grader LLM infrastructure)
- `CompletionChecker` — evaluates completion conditions after each turn using `assistant_message`
- Integration with existing `EvalRunner` — `runSingleTrial` creates a fresh agent instance and delegates when `conversation` is present

**Gaps to address in later phases:**
- No step grader execution in the conversation loop (Phase 5)
- No persona LLM retry on failure (design Section 16 says retry once; Phase 5)
- `withAbortTimeout` duplicated in both `conversationRunner.ts` and `evalRunner.ts` (Phase 5)
- No validation that conversation requires at least one of `replies` or `persona` (Phase 5)

### Phase 4: CLI-First Local LLM Support (est. scope: medium) — COMPLETE

**Status:** Implemented. See `docs/superpowers/plans/2026-03-24-cli-first-local-llm-implementation.md`.

Replaced the earlier MCP-S remote backend plan with a simpler CLI-first approach:
- `src/utils/cli-llm.ts` — Claude CLI subprocess wrapper (detection, invocation, envelope parsing)
- `src/utils/llm.ts` — CLI-first fallback in `callLLM()` with `jsonSchema` support
- `src/commands/init.ts` — CLI-first path for `pathgrade init`
- `src/providers/local.ts` — host-auth passthrough mode for CLI-authenticated agents

Goals achieved:
- local runs need zero provider API keys when Claude CLI is installed with an active OAuth session
- API-key fallback preserved for CI
- host-auth passthrough keeps real HOME for solver CLI auth while isolating workspace via `cwd`

### Phase 4.5: Agent Factory Fix (est. scope: small) — COMPLETE

**Status:** Implemented.

**Problem:** `commands/run.ts` created a single agent instance and passed it to `runEval()`. The design requires a factory so each trial gets a fresh agent, preventing state contamination when trials run in parallel.

**Files changed:**
- `src/evalRunner.ts` — changed `runEval()`, `runTrialsParallel()`, and `runSingleTrial()` signatures from `agent: BaseAgent` to `agentFactory: () => BaseAgent`; factory called inside `runSingleTrial()`
- `src/commands/run.ts` — passes `() => createAgent(agentName)` instead of `createAgent(agentName)`

### Phase 5: Step Grading + Cleanup (est. scope: medium) — COMPLETE

**Status:** Implemented.

**5a. Step grader types and config**

**Files changed:**
- `src/core/config.types.ts` — add `StepGraderConfig`, `ResolvedStepGrader` types; add `step_graders` field to `ConversationConfig`, `ResolvedConversation`, and `DefineEvalConversationInput`
- `src/core/config.ts` — validate `step_graders` (after_turn > 0, valid grader configs); resolve step grader file references in `resolveConversation()`; removed "step_graders are not supported yet" guard
- `src/types.ts` — add `'step_grader'` to `LogEntry.type` union; add `step_grader_results` to `ConversationTurn`; add `step_grader_key` to `LogEntry`

**5b. Step grader execution in conversation runner**

**Files changed:**
- `src/conversationRunner.ts` — `runStepGraders()` helper runs after `checkCompletion()` and before `pickReply()`; on the completion turn, step graders still run before returning; requires `taskPath` in `ConversationRunOptions`
- `src/commands/run.ts` — stage step grader assets into `tests/steps/` and `prompts/steps/` namespaces (e.g. `turn_1_0.sh`, `turn_3_0.md`)
- `src/evalRunner.ts` — passes `taskPath` to `runConversationTrial()`

**5c. LLM transcript integration**

**Files changed:**
- `src/graders/index.ts` — build per-turn structured transcripts grouped by turn number with `**User:**`/`**Agent:**` formatting and per-turn command summaries

**5d. Cleanup (alongside step graders)**

- Extracted `withAbortTimeout` from `conversationRunner.ts` and `evalRunner.ts` into `src/utils/timeout.ts`
- Added persona LLM retry-once logic in `conversationRunner.ts` `pickReply()` (design Section 16: retry once, then return null to end conversation)
- Config validation for `replies` or `persona` already existed (added in Phase 1)

**Deviations from design:**
- `LogEntry` does not include a separate `step_grader_result` field; it reuses the existing `grader_result` field for step grader results (avoids redundant fields)
- LLM transcript format uses markdown bold (`**User:**`/`**Agent:**`) instead of plain `User:`/`Assistant:` for clearer turn delineation
- Persona retry returns `null` (triggering `no_replies` completion) rather than setting `turn_status: 'error'`, keeping the error semantics simpler

### Phase 6: Reporting & Output (est. scope: small)

**Files changed:**
- `src/reporters/cli.ts` — display conversation turn count, completion reason
- `src/reporters/browser.ts` — render conversation transcript in web UI
- `src/evalRunner.ts` — include conversation data in saved JSON reports

### Phase 7: ck-new Example Eval (est. scope: small)

**New files:**
- `examples/ck-new/eval.yaml` — updated with `conversation:` config
- `examples/ck-new/graders/check-brief.js` — already created
- `examples/ck-new/fixtures/` — already created

### Phase 8: Design Doc Reconciliation (est. scope: small)

**Status:** Do after Phases 4.5-5 are stable.

Update design doc sections to match actual implementation:
- Section 6 (TypeScript Types) — update to session-object pattern, camelCase `AgentTurnResult`, add `TrialRuntime`/`TrialPaths`/`AgentSession` types
- Section 10 (Agent Session Continuation) — rewrite code examples to use `createSession()` → `AgentSession` pattern instead of `continueSession()`/`resetSession()`
- Section 7 (Execution Flow) — update pseudocode to reflect `session.start()`/`session.reply()` instead of `agent.run()`/`agent.continueSession()`

### Dependency Order

```
Phase 1 (types ✓) → Phase 2 (agents ✓) → Phase 3 (runner ✓) → Phase 4 (CLI-first LLM ✓)
  → Phase 4.5 (agent factory fix ✓) → Phase 5 (step grading + cleanup)
  → Phase 6 (reporting) → Phase 7 (example) → Phase 8 (doc reconciliation)
```

Phases 1-4.5 are complete. Phase 5 (step graders + cleanup) is the main remaining work. Phases 6-8 depend on Phase 5.

---

## 19. Known Limitations & Future Enhancements

### Known Limitations (v1)

| Limitation | Rationale | Workaround |
|-----------|-----------|------------|
| No `after_turn: "last"` in step_graders | Total turns unknown ahead of time. Specific turn numbers keep behavior deterministic. | Use end-of-conversation graders for final-state checks. |
| Local-first execution still requires host-installed agent CLIs and deterministic grader dependencies | Docker is removed, so environment provisioning is no longer containerized. Secure employee mode may remove provider API keys for persona and `llm_rubric`, but the main agent/runtime is still local. | Document prerequisites clearly and keep eval dependencies lightweight. |
| No hard CPU/memory isolation in local mode | Without Docker, resource isolation is weaker. | Run evals on trusted machines and keep tasks bounded by timeout. |
| No reply `delay_ms` | Real users don't respond instantly, but adding delays increases trial time without clear testing value. | Agent behavior shouldn't depend on reply timing. If it does, that's a bug in the agent. |
| Persona transcript not truncated | For long conversations (10-15 turns), the full transcript sent to the persona LLM can get large. | Keep `max_turns` reasonable (≤15). Typical conversations are 5-10 turns. Future enhancement: summarize early turns if transcript exceeds a token threshold. |
| `skillgrade init` doesn't detect conversational skills | The init command generates eval.yaml automatically, but won't produce `conversation:` blocks. | Author multi-turn configs manually. Future enhancement: detect `disable-model-invocation: true` in SKILL.md metadata as a signal. |
| No agent-initiated conversation end | The agent can't explicitly say "conversation over." Completion is detected externally via file signals, phrase matching, or turn limits. | Use `done_phrase` with a regex that matches the agent's natural closing (e.g., `"brief.*saved\|anything else"`) |
| Gemini/Codex session continuation unverified | These CLIs may not support native session continuation. | Transcript accumulation fallback works for all agents. Native continuation is an optimization, not a requirement. |
| Transcript accumulation changes agent behavior | Re-sending the full conversation each turn causes the agent to see all prior messages as a single prompt rather than a true multi-turn session. This may cause some agents to re-execute earlier commands. | Use native continuation where available (Claude's `-c`). For other agents, include an instruction prefix in the transcript: "Continue the conversation. Do not re-execute previous commands." |
| Assistant-message extraction may need per-agent tuning | Some CLIs interleave prose with diagnostics or tool summaries. | Start with agent-specific parsers and fall back to raw output with logging. |

### Future Enhancements (post-v1)

1. **`after_turn: "last"`** — run step graders on the final turn before end-of-conversation graders
2. **Persona transcript summarization** — summarize turns beyond a token threshold
3. **`skillgrade init` for conversational skills** — detect multi-turn skills and generate conversation-based configs
4. **Branching conversation trees** — explicit if/else paths based on agent responses
5. **Step graders contributing to reward** — optional flag to include step grader scores in the weighted reward calculation
6. **Reply `delay_ms`** — configurable delay before sending scripted replies
