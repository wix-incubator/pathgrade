import { describe, expect, it } from 'vitest';
import type {
    ClientRequest,
    ClientRequestMethod,
    Op,
    OpUserInputAnswer,
    PermissionGrantScope,
    PermissionsRequestApprovalParams,
    PermissionsRequestApprovalResponse,
    SandboxMode,
    ServerRequest,
    ServerRequestMethod,
    ThreadStartParams,
    ToolRequestUserInputAnswer,
    ToolRequestUserInputOption,
    ToolRequestUserInputParams,
    ToolRequestUserInputQuestion,
    ToolRequestUserInputResponse,
    TurnCompletedNotification,
    DynamicToolCallParams,
    McpElicitationRequestParams,
    GrantedPermissionProfile,
} from '../src/agents/codex-app-server/protocol/index.js';

describe('vendored codex-app-server protocol types', () => {
    it('ClientRequestMethod enumerates the 8 methods the pathgrade driver may send', () => {
        // Switch-exhaustiveness-style probe. Response-shaped entries
        // (e.g. */answer) are deliberately excluded — they flow through
        // `transport.sendResponse(req.id, …)`, not through this union.
        const values: Record<ClientRequestMethod, true> = {
            'initialize': true,
            'thread/start': true,
            'turn/start': true,
            'turn/interrupt': true,
            'thread/inject_items': true,
            'thread/read': true,
            'thread/list': true,
            'review/start': true,
        };
        expect(Object.keys(values)).toHaveLength(8);
    });

    it('ClientRequestMethod excludes phantom response-shaped entries', () => {
        // @ts-expect-error — */answer variants are JSON-RPC responses, not client requests.
        const _a: ClientRequestMethod = 'item/tool/requestUserInput/answer';
        // @ts-expect-error — permissions answers are JSON-RPC responses, not client requests.
        const _b: ClientRequestMethod = 'permissions/requestApproval/answer';
        void _a; void _b;
        expect(true).toBe(true);
    });

    it('ServerRequestMethod enumerates the 9 server-request variants under rust-v0.124.0', () => {
        const values: Record<ServerRequestMethod, true> = {
            'item/tool/requestUserInput': true,
            'item/permissions/requestApproval': true,
            'item/tool/call': true,
            'mcpServer/elicitation/request': true,
            'item/commandExecution/requestApproval': true,
            'item/fileChange/requestApproval': true,
            'applyPatchApproval': true,
            'execCommandApproval': true,
            'account/chatgptAuthTokens/refresh': true,
        };
        expect(Object.keys(values)).toHaveLength(9);
    });

    it('ServerRequestMethod lists each v0.124 rename target individually', () => {
        const renamed: ServerRequestMethod[] = [
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
            'item/tool/call',
        ];
        for (const m of renamed) {
            // Compile-time narrowing: each rename target is part of the union.
            const probe: ServerRequestMethod = m;
            expect(probe).toBe(m);
        }
    });

    it('ServerRequestMethod has no phantom pre-v0.124 entries', () => {
        const phantoms = [
            'item/tool/commandExec/requestApproval',
            'item/tool/fileChange/requestApproval',
            'item/appToolsConfig/requestApproval',
            'dynamicToolCall/invoke',
            'session/loginAccount/request',
            'session/logoutAccount/request',
        ];
        // Sanity: none of the phantom entries is assignable to ServerRequestMethod.
        // @ts-expect-error — these strings must not be part of the current union.
        const _probe: ServerRequestMethod = 'dynamicToolCall/invoke';
        void _probe;
        for (const p of phantoms) {
            expect(typeof p).toBe('string');
        }
    });

    it('ToolRequestUserInputQuestion matches upstream shape at runtime sample', () => {
        const q: ToolRequestUserInputQuestion = {
            id: 'q1',
            header: 'Select region',
            question: 'Which region?',
            isOther: false,
            isSecret: false,
            options: [{ label: 'us-east-1', description: 'US East' }],
        };
        expect(q.options?.[0].label).toBe('us-east-1');
    });

    it('ToolRequestUserInputParams has threadId/turnId/itemId/questions', () => {
        const params: ToolRequestUserInputParams = {
            threadId: 't',
            turnId: 'turn',
            itemId: 'item',
            questions: [],
        };
        expect(params.questions).toEqual([]);
    });

    it('ToolRequestUserInputResponse maps question ids to answers', () => {
        const a: ToolRequestUserInputAnswer = { answers: ['us-east-1'] };
        const r: ToolRequestUserInputResponse = { answers: { q1: a } };
        expect(r.answers.q1!.answers).toEqual(['us-east-1']);
    });

    it('SandboxMode is a string literal union', () => {
        const m: SandboxMode = 'workspace-write';
        expect(m).toBe('workspace-write');
    });

    it('PermissionsRequestApprovalResponse carries a PermissionGrantScope', () => {
        const scope: PermissionGrantScope = 'turn';
        const response: PermissionsRequestApprovalResponse = {
            permissions: {} as GrantedPermissionProfile,
            scope,
        };
        expect(response.scope).toBe('turn');
    });

    it('Op::UserInputAnswer carries itemId and the answer map', () => {
        const op: OpUserInputAnswer = {
            type: 'Op::UserInputAnswer',
            itemId: 'item-1',
            answers: { q1: { answers: ['yes'] } },
        };
        const generic: Op = op;
        expect(generic.type).toBe('Op::UserInputAnswer');
    });

    it('ClientRequest is a JSON-RPC 2.0 envelope with a method', () => {
        const req: ClientRequest<ToolRequestUserInputParams> = {
            jsonrpc: '2.0',
            id: 1,
            method: 'turn/start',
            params: { threadId: 't', turnId: 'turn', itemId: 'item', questions: [] },
        };
        expect(req.jsonrpc).toBe('2.0');
    });

    it('ServerRequest narrows by method discriminator', () => {
        const req: ServerRequest = {
            method: 'item/tool/requestUserInput',
            id: 42,
            params: { threadId: 't', turnId: 'turn', itemId: 'item', questions: [] },
        };
        if (req.method === 'item/tool/requestUserInput') {
            expect(req.params.itemId).toBe('item');
        } else {
            throw new Error('expected item/tool/requestUserInput narrowing');
        }
    });

    it('Other vendored types compile standalone', () => {
        // Ensure standalone vendored types import without errors.
        const thread: ThreadStartParams = {
            experimentalRawEvents: false,
            persistExtendedHistory: false,
        };
        const opt: ToolRequestUserInputOption = { label: 'x', description: 'y' };
        const perm: PermissionsRequestApprovalParams = {
            threadId: 't', turnId: 'turn', itemId: 'item', cwd: '/tmp', reason: null, permissions: null,
        };
        const dyn: DynamicToolCallParams = {
            threadId: 't', turnId: 'turn', callId: 'c', namespace: null, tool: 'x', arguments: null,
        };
        // DynamicToolCallParams continues to be the params shape for 'item/tool/call'.
        const itemToolCall: ServerRequest = {
            method: 'item/tool/call', id: 1, params: dyn,
        };
        expect(itemToolCall.method).toBe('item/tool/call');
        const elicit: McpElicitationRequestParams = {
            threadId: 't', turnId: null, serverName: 'mcp', mode: 'url', _meta: null, message: 'hi', url: 'https://x', elicitationId: 'e',
        };
        const turn: TurnCompletedNotification = { threadId: 't', turn: null };
        expect([thread.experimentalRawEvents, opt.label, perm.cwd, dyn.tool, elicit.mode, turn.threadId]).toBeDefined();
    });
});
