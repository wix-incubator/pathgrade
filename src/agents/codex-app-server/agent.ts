import {
    AgentCommandRunner,
    AgentSession,
    AgentSessionOptions,
    AgentTurnResult,
    BaseAgent,
    EnvironmentHandle,
    getRuntimeEnv,
    getWorkspacePath,
} from '../../types.js';
import { mountMcpForCodexAppServer } from '../../providers/mcp-runtime-mounting.js';
import { assertMcpSecretReferencesReady } from '../../providers/mcp-config.js';
import {
    buildSummary,
    enrichSkillEvents,
    extractSkillNameFromPath,
    inferCodexExecAction,
    type ToolEvent,
} from '../../tool-events.js';
import {
    requireAskBusForLiveBatches,
} from '../../sdk/ask-bus/bus.js';
import { toAskUserToolEvent } from '../../sdk/ask-bus/projection.js';
import type { AskBus, AskQuestion } from '../../sdk/ask-bus/types.js';
import {
    decideMcpToolCall,
    redactMcpSecrets,
    type McpSafetyOptions,
    type McpToolPolicyDecision,
} from '../../sdk/mcp-safety.js';
import {
    createAppServerSessionHandle,
    spawnAppServerTransport,
    type AppServerSessionHandle,
    type AppServerTransport,
    type ServerRequestMessage,
    type TransportCloseInfo,
} from './transport.js';
import {
    normalizeUpstreamQuestion,
    toWireAnswerMap,
} from './wire-translators.js';
import type {
    ToolRequestUserInputParams,
} from './protocol/index.js';

const DEFAULT_MODEL = 'gpt-5.4';
const TURN_COMPLETED_METHOD = 'turn/completed';

type SandboxMode = 'workspace-write' | 'danger-full-access';

export interface PermissionGrantLogEntry {
    type: 'permissions_granted';
    turnNumber: number;
    requested: unknown;
    scope: 'turn';
    strictAutoReview: false;
}

export interface CodexAppServerAgentDeps {
    /**
     * Inject a transport factory for tests. Default: spawn `codex app-server`
     * via child_process with NDJSON stdio wrapped in an AppServerSessionHandle.
     *
     * Tests using PassThrough streams can construct a handle via
     * {@link createAppServerSessionHandle} with `child: null` — dispose() then
     * only closes the transport and does not attempt any kill sequence.
     */
    createTransport?: (ctx: {
        workspacePath: string;
        env: NodeJS.ProcessEnv;
    }) => Promise<AppServerSessionHandle>;
    /** Sandbox mode for `thread/start`. Default: 'workspace-write'. */
    sandboxMode?: SandboxMode;
    /** Observer for per-grant audit entries (§7 of design decisions). */
    onPermissionGrant?: (entry: PermissionGrantLogEntry) => void;
}

interface ActiveTurnState {
    turnNumber: number;
    askBatchIds: string[];
    nonAskToolEvents: ToolEvent[];
    /** Text parts collected from `agentMessage` items as the turn progresses. */
    assistantMessageParts: string[];
    turnFailed: boolean;
    failureMessage?: string;
    /** Short-circuits the TurnCompleted waiter when set by the dispatcher. */
    signalFailure?: (message: string) => void;
}

interface McpServerStartupStatusParams {
    name?: string;
    status?: string;
    error?: string | null;
}

interface CodexAgentMessageItem {
    type: 'agentMessage';
    id: string;
    text: string;
    phase?: string;
}

interface CodexCommandExecutionAction {
    type?: string;
    name?: string;
    path?: string;
    command?: string;
}

interface CodexCommandExecutionItem {
    type: 'commandExecution';
    id: string;
    command: string;
    status?: 'inProgress' | 'completed' | 'failed';
    cwd?: string;
    commandActions?: CodexCommandExecutionAction[];
}

interface CodexFileChangeItem {
    type: 'fileChange';
    id: string;
    changes: Array<{ path: string; kind?: unknown; diff?: string }>;
}

interface CodexMcpToolCallItem {
    type: 'mcpToolCall';
    id: string;
    server: string;
    tool: string;
    status?: string;
    arguments?: unknown;
    result?: unknown;
    error?: { message?: string } | null;
    durationMs?: number | null;
}

type CodexItem =
    | CodexAgentMessageItem
    | CodexCommandExecutionItem
    | CodexFileChangeItem
    | CodexMcpToolCallItem
    | { type: string; id?: string };

interface ItemCompletedParams {
    item: CodexItem;
    threadId?: string;
    turnId?: string;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return {};
}

function isMcpToolCallApprovalRequest(params: unknown): boolean {
    const meta = recordFromUnknown(recordFromUnknown(params)._meta);
    return meta.codex_approval_kind === 'mcp_tool_call';
}

function extractMcpToolApprovalRequest(params: unknown): {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
} | undefined {
    if (!isMcpToolCallApprovalRequest(params)) return undefined;
    const record = recordFromUnknown(params);
    const meta = recordFromUnknown(record._meta);
    const serverName = typeof record.serverName === 'string' ? record.serverName : undefined;
    const toolName =
        typeof meta.toolName === 'string' ? meta.toolName
            : typeof meta.tool_name === 'string' ? meta.tool_name
                : typeof meta.name === 'string' ? meta.name
                    : typeof record.message === 'string' ? parseToolNameFromApprovalMessage(record.message)
                        : undefined;
    if (!serverName || !toolName) return undefined;
    return {
        serverName,
        toolName,
        arguments: recordFromUnknown(meta.tool_params),
    };
}

function parseToolNameFromApprovalMessage(message: string): string | undefined {
    return message.match(/tool\s+"([^"]+)"/i)?.[1];
}

function extractCommandActionSkillName(action: CodexCommandExecutionAction): string | undefined {
    if (typeof action.path === 'string') {
        const direct = extractSkillNameFromPath(action.path);
        if (direct) return direct;
        const embedded = extractSkillNameFromText(action.path);
        if (embedded) return embedded;
    }
    return typeof action.command === 'string' ? extractSkillNameFromText(action.command) : undefined;
}

function extractSkillNameFromText(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.match(/(?:^|[/\s"'])\.(?:agents|claude)\/skills\/([^/\s"']+)\/SKILL\.md(?:$|[\s"'])/)?.[1];
}

function extractSkillPathFromText(value: string | undefined): string | undefined {
    if (!value) return undefined;
    return value.match(/(?:^|[\s"'])(?<path>(?:\/|\.{1,2}\/)?[^\s"']*(?:\.agents|\.claude)\/skills\/[^/\s"']+\/SKILL\.md)(?:$|[\s"'])/)?.groups?.path;
}

function projectItemIntoTurn(item: CodexItem, turn: ActiveTurnState): void {
    if (item.type === 'agentMessage') {
        const msg = item as CodexAgentMessageItem;
        if (msg.text) {
            turn.assistantMessageParts.push(msg.text);
        }
        return;
    }
    if (item.type === 'commandExecution') {
        const cmd = item as CodexCommandExecutionItem;
        const action = inferCodexExecAction(cmd.command);
        const skillPath = extractSkillPathFromText(cmd.command);
        const args: Record<string, unknown> = {
            command: cmd.command,
            ...(skillPath ? { path: skillPath } : {}),
        };
        turn.nonAskToolEvents.push({
            action,
            provider: 'codex',
            providerToolName: 'commandExecution',
            turnNumber: turn.turnNumber,
            arguments: args,
            summary: buildSummary(action, 'commandExecution', args),
            confidence: 'high',
            rawSnippet: JSON.stringify(cmd),
        });
        const recordedSkills = new Set<string>();
        for (const action of cmd.commandActions ?? []) {
            const skillName = extractCommandActionSkillName(action) ?? extractSkillNameFromText(cmd.command);
            if (!skillName || recordedSkills.has(skillName)) continue;
            recordedSkills.add(skillName);
            turn.nonAskToolEvents.push({
                action: 'use_skill',
                provider: 'codex',
                providerToolName: `commandExecution.commandActions.${action.type ?? 'unknown'}`,
                turnNumber: turn.turnNumber,
                arguments: { path: action.path, name: action.name },
                summary: `use_skill ${skillName}`,
                confidence: 'high',
                rawSnippet: JSON.stringify(action),
                skillName,
            });
        }
        return;
    }
    if (item.type === 'fileChange') {
        const fc = item as CodexFileChangeItem;
        for (const change of fc.changes ?? []) {
            turn.nonAskToolEvents.push({
                action: 'edit_file',
                provider: 'codex',
                providerToolName: 'fileChange',
                turnNumber: turn.turnNumber,
                arguments: { file_path: change.path },
                summary: `edit_file: ${change.path}`,
                confidence: 'high',
                rawSnippet: JSON.stringify(change),
            });
        }
        return;
    }
    if (item.type === 'mcpToolCall') {
        const call = item as CodexMcpToolCallItem;
        const args = recordFromUnknown(call.arguments);
        const providerToolName = `${call.server}.${call.tool}`;
        turn.nonAskToolEvents.push({
            action: 'mcp_tool_call',
            provider: 'codex',
            providerToolName,
            turnNumber: turn.turnNumber,
            arguments: {
                ...args,
                server: call.server,
                tool: call.tool,
                status: call.status ?? 'unknown',
            },
            summary: `MCP tool ${providerToolName} ${call.status ?? 'unknown'}`,
            confidence: 'high',
            rawSnippet: JSON.stringify(call),
        });
        return;
    }
}

function projectMcpStartupStatusIntoTurn(
    params: McpServerStartupStatusParams,
    turn: ActiveTurnState,
): void {
    const name = params.name ?? 'unknown';
    const status = params.status ?? 'unknown';
    const error = typeof params.error === 'string' ? params.error : undefined;

    turn.nonAskToolEvents.push({
        action: 'unknown',
        provider: 'codex',
        providerToolName: 'mcpServer/startupStatus/updated',
        turnNumber: turn.turnNumber,
        arguments: {
            name,
            status,
            ...(error ? { error } : {}),
        },
        summary: `MCP server ${name} startup ${status}`,
        confidence: 'high',
        rawSnippet: JSON.stringify(params),
    });

    if (status === 'failed') {
        const message = `MCP server ${name} failed to start${error ? `: ${error}` : ''}`;
        turn.turnFailed = true;
        turn.failureMessage = message;
        turn.signalFailure?.(message);
    }
}

function recordPolicyDeniedMcpToolCall(
    turn: ActiveTurnState | null,
    request: { serverName: string; toolName: string; arguments: Record<string, unknown> },
    decision: Extract<McpToolPolicyDecision, { action: 'deny' }>,
    rawParams: unknown,
): void {
    if (!turn) return;
    const args = redactMcpSecrets(request.arguments);
    const providerToolName = `${request.serverName}.${request.toolName}`;
    turn.nonAskToolEvents.push({
        action: 'mcp_tool_call',
        provider: 'codex',
        providerToolName,
        turnNumber: turn.turnNumber,
        arguments: {
            ...args,
            server: request.serverName,
            tool: request.toolName,
            status: 'policy_denied',
            policyResult: {
                action: 'deny',
                reason: decision.reason,
                message: decision.message,
            },
        },
        summary: `MCP tool ${providerToolName} policy_denied`,
        confidence: 'high',
        rawSnippet: JSON.stringify(redactMcpSecrets(rawParams)),
    });
}

function isLiveMcpSafetyMode(options: McpSafetyOptions | undefined): boolean {
    const runMode = options?.runMode ?? 'mock';
    return runMode === 'live-readonly' || runMode === 'live-sandbox' || runMode === 'live';
}

export class CodexAppServerAgent extends BaseAgent {
    constructor(private deps: CodexAppServerAgentDeps = {}) {
        super();
    }

    async createSession(
        runtime: EnvironmentHandle,
        _runCommand: AgentCommandRunner,
        options?: AgentSessionOptions,
    ): Promise<AgentSession> {
        const askBus = requireAskBusForLiveBatches(options, 'CodexAppServerAgent');
        const workspacePath = getWorkspacePath(runtime);
        const runtimeEnv = getRuntimeEnv(runtime) as NodeJS.ProcessEnv;
        const model = options?.model ?? DEFAULT_MODEL;
        const sandboxMode: SandboxMode = this.deps.sandboxMode ?? 'workspace-write';

        let handle: AppServerSessionHandle | null = null;
        let threadId: string | null = null;
        let turnCounter = 0;
        let closeInfo: TransportCloseInfo | null = null;
        let activeTurn: ActiveTurnState | null = null;
        let disposed = false;

        const ensureTransport = async (): Promise<AppServerTransport> => {
            if (disposed) throw new Error('CodexAppServerAgent session disposed');
            if (handle) return handle.transport;
            const factory = this.deps.createTransport
                ?? (async (ctx: { workspacePath: string; env: NodeJS.ProcessEnv }) =>
                    spawnAppServerTransport({ cwd: ctx.workspacePath, env: ctx.env }));
            handle = await factory({ workspacePath, env: runtimeEnv });
            const transport = handle.transport;
            transport.onServerRequest((req) => this.dispatchServerRequest(req, {
                transport,
                askBus,
                activeTurn: () => activeTurn,
                onPermissionGrant: this.deps.onPermissionGrant,
                mcpSafety: options?.mcpSafety,
            }));
            transport.onClose((info) => {
                closeInfo = info;
            });
            transport.onNotification((n) => {
                if (process.env.PATHGRADE_CODEX_DEBUG) {
                    console.error(`[codex app-server] notification method=${n.method} params=${JSON.stringify(n.params).slice(0, 300)}`);
                }
                if (n.method === 'mcpServer/startupStatus/updated') {
                    const turn = activeTurn;
                    if (turn) {
                        projectMcpStartupStatusIntoTurn(
                            (n.params ?? {}) as McpServerStartupStatusParams,
                            turn,
                        );
                    }
                    return;
                }
                if (n.method !== 'item/completed') return;
                const turn = activeTurn;
                if (!turn) return;
                const params = n.params as ItemCompletedParams | undefined;
                if (!params?.item) return;
                projectItemIntoTurn(params.item, turn);
            });
            await transport.sendRequest('initialize', {
                clientInfo: { name: 'pathgrade', version: '0.5.0', title: null },
                capabilities: { experimentalApi: true, optOutNotificationMethods: null },
            });
            // Upstream ClientNotification = { method: "initialized" }: send it
            // before any thread/start so the handshake matches the v0.124
            // contract and is forward-compatible with servers that enforce it.
            transport.sendNotification('initialized', null);
            return transport;
        };

        const runTurn = async (message: string): Promise<AgentTurnResult> => {
            const t = await ensureTransport();
            turnCounter += 1;
            const turn: ActiveTurnState = {
                turnNumber: turnCounter,
                askBatchIds: [],
                nonAskToolEvents: [],
                assistantMessageParts: [],
                turnFailed: false,
            };
            activeTurn = turn;

            try {
                if (threadId === null) {
                    if (options?.mcpConfigPath && isLiveMcpSafetyMode(options.mcpSafety)) {
                        await assertMcpSecretReferencesReady({
                            workspacePath,
                            mcpConfigPath: options.mcpConfigPath,
                            env: runtimeEnv,
                        });
                    }
                    const mcpConfig = options?.mcpConfigPath
                        ? await mountMcpForCodexAppServer({
                            workspacePath,
                            mcpConfigPath: options.mcpConfigPath,
                        })
                        : undefined;
                    const resp = await t.sendRequest<{ thread: { id: string } }>(
                        'thread/start',
                        buildThreadStartParams({ cwd: workspacePath, model, sandboxMode, mcpConfig }),
                    );
                    threadId = resp.thread.id;
                }

                // Wait for TurnCompleted OR subprocess crash OR dispatcher failure.
                const turnCompletion = new Promise<void>((resolve, reject) => {
                    let settled = false;
                    const off = t.onNotification((n) => {
                        if (settled) return;
                        if (n.method === TURN_COMPLETED_METHOD) {
                            settled = true;
                            off();
                            closeOff();
                            resolve();
                        }
                    });
                    const closeOff = t.onClose((info) => {
                        if (settled) return;
                        settled = true;
                        off();
                        closeOff();
                        reject(
                            Object.assign(new Error('app-server exited'), {
                                exitCode: info.exitCode ?? 1,
                                signal: info.signal,
                                pid: info.pid,
                            }),
                        );
                    });
                    turn.signalFailure = (msg: string) => {
                        if (settled) return;
                        settled = true;
                        off();
                        closeOff();
                        turn.turnFailed = true;
                        turn.failureMessage = msg;
                        resolve();
                    };
                    if (turn.turnFailed) {
                        turn.signalFailure(turn.failureMessage ?? 'turn failed');
                    }
                    // If already closed, settle immediately.
                    if (closeInfo) {
                        if (!settled) {
                            settled = true;
                            off();
                            closeOff();
                            reject(
                                Object.assign(new Error('app-server exited'), {
                                    exitCode: closeInfo.exitCode ?? 1,
                                }),
                            );
                        }
                    }
                });

                const startTurnResp = t
                    .sendRequest('turn/start', {
                        threadId,
                        input: [{ type: 'text', text: message, text_elements: [] }],
                    })
                    .catch((err: unknown) => {
                        // A JSON-RPC error on turn/start means the server will
                        // never send turn/completed — short-circuit the turn
                        // through the existing signalFailure path instead of
                        // waiting for an outer timeout.
                        const msg =
                            err instanceof Error
                                ? err.message
                                : typeof err === 'string'
                                    ? err
                                    : 'turn/start failed';
                        turn.signalFailure?.(msg);
                    });

                try {
                    await turnCompletion;
                } catch (err) {
                    const info = err as { exitCode?: number; signal?: string; pid?: number; message: string };
                    return assembleTurnResult({
                        askBus,
                        activeTurn: turn,
                        exitCode: info.exitCode ?? 1,
                        message: info.message ?? 'app-server exited',
                        pid: info.pid,
                        signal: info.signal,
                    });
                }

                void startTurnResp;

                if (turn.turnFailed) {
                    return assembleTurnResult({
                        askBus,
                        activeTurn: turn,
                        exitCode: 1,
                        message: turn.failureMessage ?? 'turn failed',
                    });
                }

                return assembleTurnResult({
                    askBus,
                    activeTurn: turn,
                    exitCode: 0,
                    message: turn.assistantMessageParts.join('\n\n'),
                });
            } finally {
                activeTurn = null;
            }
        };

        const dispose = async (): Promise<void> => {
            if (disposed) return;
            disposed = true;
            const turn = activeTurn;
            if (turn) {
                turn.signalFailure?.('session disposed');
            }
            activeTurn = null;
            if (handle) {
                try {
                    await handle.close();
                } catch (err) {
                    console.warn(
                        `CodexAppServerAgent: handle.close() threw during dispose: ${String(err)}`,
                    );
                }
            }
        };

        const guardDisposed = (): void => {
            if (disposed) {
                throw new Error('CodexAppServerAgent session disposed');
            }
        };

        return {
            start: async ({ message }) => {
                guardDisposed();
                return runTurn(message);
            },
            reply: async ({ message }) => {
                guardDisposed();
                return runTurn(message);
            },
            dispose,
        };
    }

    private dispatchServerRequest(
        req: ServerRequestMessage,
        ctx: {
            transport: AppServerTransport;
            askBus: AskBus;
            activeTurn: () => ActiveTurnState | null;
            onPermissionGrant?: (entry: PermissionGrantLogEntry) => void;
            mcpSafety?: McpSafetyOptions;
        },
    ): void {
        const { transport, askBus, activeTurn, onPermissionGrant, mcpSafety } = ctx;

        switch (req.method) {
            case 'item/tool/requestUserInput':
                void handleRequestUserInput(req, { transport, askBus, activeTurn });
                return;
            case 'item/permissions/requestApproval': {
                const params = (req.params ?? {}) as { permissions?: unknown };
                transport.sendResponse(req.id, {
                    permissions: params.permissions ?? {},
                    scope: 'turn',
                    strictAutoReview: false,
                });
                const turn = activeTurn();
                if (onPermissionGrant) {
                    onPermissionGrant({
                        type: 'permissions_granted',
                        turnNumber: turn?.turnNumber ?? 0,
                        requested: params.permissions ?? {},
                        scope: 'turn',
                        strictAutoReview: false,
                    });
                }
                return;
            }
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
            case 'applyPatchApproval':
            case 'execCommandApproval':
                transport.sendResponse(req.id, { decision: 'approved', scope: 'turn' });
                return;
            case 'item/tool/call':
                transport.sendResponse(req.id, { status: 'declined' });
                return;
            case 'mcpServer/elicitation/request':
                if (isMcpToolCallApprovalRequest(req.params)) {
                    const toolRequest = extractMcpToolApprovalRequest(req.params);
                    if (toolRequest) {
                        const decision = decideMcpToolCall(mcpSafety, toolRequest);
                        if (decision.action === 'deny') {
                            recordPolicyDeniedMcpToolCall(activeTurn(), toolRequest, decision, req.params);
                            transport.sendResponse(req.id, {
                                action: 'decline',
                                content: null,
                                _meta: {
                                    pathgrade_policy_denial: {
                                        reason: decision.reason,
                                        message: decision.message,
                                    },
                                },
                            });
                            return;
                        }
                    }
                    transport.sendResponse(req.id, { action: 'accept', content: {}, _meta: null });
                } else {
                    transport.sendResponse(req.id, { action: 'decline', content: null, _meta: null });
                }
                return;
            case 'account/chatgptAuthTokens/refresh': {
                const message =
                    'codex app-server requires OPENAI_API_KEY for pathgrade and honors OPENAI_BASE_URL when set; ChatGPT/cached auth unsupported under transport=app-server';
                transport.sendErrorResponse(req.id, -32001, message);
                const turn = activeTurn();
                if (turn) {
                    turn.turnFailed = true;
                    turn.failureMessage = message;
                    turn.signalFailure?.(message);
                }
                return;
            }
            default:
                transport.sendErrorResponse(
                    req.id,
                    -32601,
                    `pathgrade: unknown server-request method '${req.method}'`,
                );
                console.warn(
                    `CodexAppServerAgent: unknown server-request method '${req.method}' rejected`,
                );
                return;
        }
    }
}

async function handleRequestUserInput(
    req: ServerRequestMessage,
    ctx: {
        transport: AppServerTransport;
        askBus: AskBus;
        activeTurn: () => ActiveTurnState | null;
    },
): Promise<void> {
    const { transport, askBus, activeTurn } = ctx;
    const params = req.params as ToolRequestUserInputParams;
    const turn = activeTurn();
    const turnNumber = turn?.turnNumber ?? 0;

    const questions: AskQuestion[] = params.questions.map(normalizeUpstreamQuestion);

    const handle = askBus.emit({
        batchId: params.itemId,
        turnNumber,
        source: 'codex-app-server',
        lifecycle: 'live',
        sourceTool: 'request_user_input',
        toolUseId: params.itemId,
        questions,
    });
    if (turn) turn.askBatchIds.push(params.itemId);

    let resolution: Awaited<typeof handle.resolution>;
    try {
        resolution = await handle.resolution;
    } catch (err) {
        console.warn(
            `CodexAppServerAgent: ask_user batch ${params.itemId} failed to resolve: ${String(err)}`,
        );
        transport.sendResponse(req.id, { answers: toWireAnswerMap(null, params.questions) });
        return;
    }
    transport.sendResponse(req.id, {
        answers: toWireAnswerMap(resolution, params.questions),
    });
}

function buildThreadStartParams(opts: {
    cwd: string;
    model: string;
    sandboxMode: SandboxMode;
    mcpConfig?: Record<string, unknown>;
}): Record<string, unknown> {
    return {
        cwd: opts.cwd,
        approvalPolicy: 'never',
        sandbox: opts.sandboxMode,
        ephemeral: true,
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        model: opts.model,
        ...(opts.mcpConfig ? { config: opts.mcpConfig } : {}),
    };
}

function assembleTurnResult(args: {
    askBus: AskBus;
    activeTurn: ActiveTurnState;
    exitCode: number;
    message: string;
    pid?: number;
    signal?: string;
}): AgentTurnResult {
    const { askBus, activeTurn, exitCode, message, pid, signal } = args;
    const askBatchIds = new Set(activeTurn.askBatchIds);
    const askEvents = askBus
        .snapshot()
        .filter((s) => askBatchIds.has(s.batchId))
        .map((s) => toAskUserToolEvent(s) as unknown as ToolEvent);

    const toolEvents: ToolEvent[] = enrichSkillEvents([...askEvents, ...activeTurn.nonAskToolEvents]);
    const rawOutput = exitCode === 0
        ? message
        : [
            message,
            pid !== undefined ? `pid=${pid}` : '',
            signal ? `signal=${signal}` : '',
            `exitCode=${exitCode}`,
        ]
            .filter(Boolean)
            .join(' ');
    return {
        rawOutput,
        assistantMessage: exitCode === 0 ? message : '',
        visibleAssistantMessage: exitCode === 0 ? message : '',
        visibleAssistantMessageSource: 'assistant_message',
        exitCode,
        traceOutput: rawOutput,
        toolEvents,
        ...(exitCode !== 0
            ? {
                crashInfo: {
                    ...(pid !== undefined ? { pid } : {}),
                    ...(signal !== undefined ? { signal } : {}),
                    exitCode,
                },
            }
            : {}),
    };
}
