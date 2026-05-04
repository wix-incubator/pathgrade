// Pathgrade-local composition; not a single upstream file.
// Enumerates the 9 server-request variants the driver observes over the wire
// under rust-v0.124.0. Upstream ships the discriminated union at
// `codex-rs/app-server-protocol/schema/typescript/ServerRequest.ts`
// (top-level, NOT `typescript/v2/`); the per-variant params files this module
// imports live under the `v2/` subdirectory.

import type { ToolRequestUserInputParams } from './ToolRequestUserInputParams.js';
import type { PermissionsRequestApprovalParams } from './PermissionsRequestApprovalParams.js';
import type { DynamicToolCallParams } from './DynamicToolCallParams.js';
import type { McpElicitationRequestParams } from './McpElicitationRequestParams.js';

export type ServerRequestMethod =
    | 'item/tool/requestUserInput'
    | 'item/permissions/requestApproval'
    | 'item/tool/call'
    | 'mcpServer/elicitation/request'
    | 'item/commandExecution/requestApproval'
    | 'item/fileChange/requestApproval'
    | 'applyPatchApproval'
    | 'execCommandApproval'
    | 'account/chatgptAuthTokens/refresh';

export type ServerRequest =
    | { method: 'item/tool/requestUserInput'; id: number | string; params: ToolRequestUserInputParams }
    | { method: 'item/permissions/requestApproval'; id: number | string; params: PermissionsRequestApprovalParams }
    | { method: 'item/tool/call'; id: number | string; params: DynamicToolCallParams }
    | { method: 'mcpServer/elicitation/request'; id: number | string; params: McpElicitationRequestParams }
    | { method: 'item/commandExecution/requestApproval'; id: number | string; params: unknown }
    | { method: 'item/fileChange/requestApproval'; id: number | string; params: unknown }
    | { method: 'applyPatchApproval'; id: number | string; params: unknown }
    | { method: 'execCommandApproval'; id: number | string; params: unknown }
    | { method: 'account/chatgptAuthTokens/refresh'; id: number | string; params: unknown };
