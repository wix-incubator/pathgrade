// pathgrade — public API for writing evaluations

export { createAgent } from './agent.js';
export {
    resolveAgentName,
    resolveCodexTransport,
    InvalidTransportEnvError,
} from './agent-resolution.js';
export { AgentCrashError } from './agent-crash.js';
export { check, score, judge, toolUsage } from './scorers.js';
export { evaluate, EvalScorerError } from './evaluate.js';
export {
    RUN_SNAPSHOT_VERSION,
    buildRunSnapshot,
    loadRunSnapshot,
    SnapshotParseError,
    SnapshotVersionError,
    WorkspaceMissingError,
} from './snapshots.js';
export { createPersona } from './persona.js';
export { createConversationWindow } from './conversation-window.js';
export { runJudgePipeline } from './judge-pipeline.js';
export { runScorer } from './run-scorer.js';
export { previewReactions } from './reaction-preview.js';
export { setRuntime, resetRuntime } from './eval-runtime.js';
export { DEFAULT_COPY_IGNORE } from '../providers/copy-filter.js';
export { createAskBus, requireAskBusForLiveBatches, AskBusTimeoutError } from './ask-bus/bus.js';
export { toAskUserToolEvent } from './ask-bus/projection.js';
export type {
    AskUserToolEvent,
    AskUserToolEventArguments,
    AskUserToolEventQuestionArgument,
} from './ask-bus/projection.js';
export { buildAskBatchLogEntries } from './agent-result-log.js';
export { getAgentCapabilities } from './types.js';
export type { AgentTransport, AgentCapabilities, AgentName } from './types.js';
export type {
    AskBus,
    AskBatch,
    AskQuestion,
    AskOption,
    AskAnswer,
    AskResolution,
    AskBatchSnapshot,
    AskAnswerSnapshot,
    AskResolutionSnapshot,
    AskHandle,
    AskHandler,
    AskSource,
    AskLifecycle,
    AskAnswerSource,
    Unsubscribe as AskBusUnsubscribe,
} from './ask-bus/types.js';

// Re-export types consumers need
export type {
    Agent,
    AgentOptions,
    Message,
    Scorer,
    CheckScorer,
    ScoreScorer,
    JudgeScorer,
    ToolUsageScorer,
    ScorerContext,
    EvalResult,
    ScorerResultEntry,
    ScorerStatus,
    ChatSession,
    ConversationResult,
    ConverseOptions,
    Reaction,
    TextReaction,
    AskUserReaction,
    AskUserQuestion,
    AskUserOption,
    ReactionPreviewEntry,
    TextReactionPreviewEntry,
    AskUserReactionPreviewEntry,
    ReactionPreviewResult,
    ReactionPreviewTurn,
    Persona,
    PersonaConfig,
    ConversationWindowConfig,
    PathgradePluginOptions,
    PathgradeMeta,
    TurnTiming,
    TokenUsage,
    EvaluateOptions,
    ReactionPreviewStatus,
} from './types.js';

export type { ConversationWindow, ConversationWindowOptions } from './conversation-window.js';
export type { JudgePipelineOptions } from './judge-pipeline.js';
export type { RunScorerOptions } from './run-scorer.js';
export type { OnScorerErrorMode } from './evaluate.js';
export type { RunSnapshot } from './snapshots.js';

export type { LLMPort, EvalRuntime } from './eval-runtime.js';
export { createLLMClient, ProviderNotSupportedError } from '../utils/llm.js';
export type { CreateLLMClientOptions, LLMProviderAdapter, TokenUsage as LLMTokenUsage } from '../utils/llm.js';
export { createMockLLM } from '../utils/llm-mocks.js';
export type { CreateMockLLMOptions, MockResponse, MockLLM } from '../utils/llm-mocks.js';
