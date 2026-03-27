import { AgentName } from './core/config.types';
import { ToolAction, ToolEvent } from './tool-events';

/**
 * Extract normalized tool events from raw agent trace output.
 * Best-effort: returns [] when the trace is ambiguous or the agent is unsupported.
 *
 * Trace format (Codex & Gemini): `tool: <tool_name> <json_payload>`
 * Validated against Codex CLI and Gemini CLI stdout output.
 */
export function extractToolEvents(agentName: AgentName, traceOutput: string, turnNumber?: number): ToolEvent[] {
  switch (agentName) {
    case 'codex':
      return extractCodexToolEvents(traceOutput, turnNumber);
    case 'gemini':
      return extractGenericToolLines(traceOutput, 'gemini', turnNumber);
    case 'claude':
      return extractClaudeStreamJsonEvents(traceOutput, turnNumber);
    default:
      return [];
  }
}

/**
 * Map from provider-specific tool names to normalized Pathgrade actions.
 * Conservative: only map names we're confident about.
 */
const TOOL_NAME_MAP: Record<string, ToolAction> = {
  // Shell execution
  exec_command: 'run_shell',
  shell: 'run_shell',
  bash: 'run_shell',
  run_command: 'run_shell',

  // File reading
  read_file: 'read_file',
  localGetFileContent: 'read_file',
  cat: 'read_file',

  // File writing
  write_file: 'write_file',
  create_file: 'write_file',

  // File editing
  edit_file: 'edit_file',
  patch_file: 'edit_file',

  // Code search
  localSearchCode: 'search_code',
  search_code: 'search_code',
  grep: 'search_code',
  rg: 'search_code',

  // File listing
  list_files: 'list_files',
  localViewStructure: 'list_files',
  ls: 'list_files',

  // User interaction
  ask_user: 'ask_user',
  AskUserQuestion: 'ask_user',

  // Web
  web_fetch: 'web_fetch',
  fetch: 'web_fetch',
  WebFetch: 'web_fetch',

  // Claude Code tool names (PascalCase)
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Bash: 'run_shell',
  Grep: 'search_code',
  Glob: 'list_files',
  Agent: 'unknown',
  NotebookEdit: 'edit_file',
};

/**
 * Parse `tool: <name> <json>` lines from trace output.
 * Both Codex and Gemini use this format.
 */
const TOOL_LINE_REGEX = /^tool:\s+(\S+)\s+(\{.*\})\s*$/;
const CODEX_EXEC_LINE_REGEX = /^(?<command>.+?) in .+? (?:succeeded|failed|exited)\b.*$/;
const CODEX_FILE_PATH_REGEX = /^[A-Z?]+\s+(?<path>\/.+)$/;

function extractGenericToolLines(
  traceOutput: string,
  provider: 'codex' | 'gemini',
  turnNumber?: number,
): ToolEvent[] {
  const events: ToolEvent[] = [];

  for (const line of traceOutput.split('\n')) {
    const match = line.match(TOOL_LINE_REGEX);
    if (!match) continue;

    const providerToolName = match[1];
    const jsonStr = match[2];

    let args: Record<string, unknown> | undefined;
    try {
      args = JSON.parse(jsonStr);
    } catch {
      // Unparseable JSON — skip this line rather than guessing
      continue;
    }

    const action = TOOL_NAME_MAP[providerToolName] ?? 'unknown';
    const summary = buildSummary(action, providerToolName, args);
    const rawSnippet = line.length > 200 ? line.slice(0, 200) : line;

    events.push({
      action,
      provider,
      providerToolName,
      turnNumber,
      arguments: args,
      summary,
      confidence: 'high',
      rawSnippet,
    });
  }

  return events;
}

function extractCodexToolEvents(traceOutput: string, turnNumber?: number): ToolEvent[] {
  const events = extractGenericToolLines(traceOutput, 'codex', turnNumber);
  const seen = new Set(events.map((event) => `${event.providerToolName}:${event.action}:${event.summary}`));
  const lines = traceOutput.split('\n');

  const pushEvent = (
    action: ToolAction,
    providerToolName: string,
    summary: string,
    args?: Record<string, unknown>,
    rawSnippet?: string,
  ) => {
    const key = `${providerToolName}:${action}:${summary}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({
      action,
      provider: 'codex',
      providerToolName,
      turnNumber,
      arguments: args,
      summary,
      confidence: action === 'unknown' ? 'low' : 'medium',
      rawSnippet: (rawSnippet || summary).slice(0, 200),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line === 'exec') {
      const commandLine = lines[i + 1]?.trim();
      if (!commandLine) continue;
      const match = commandLine.match(CODEX_EXEC_LINE_REGEX);
      if (!match?.groups?.command) continue;
      const command = match.groups.command;
      pushEvent(inferCodexExecAction(command), 'exec', command, { command }, `${line}\n${commandLine}`);
      i += 1;
      continue;
    }

    if (line === 'file update') {
      const pathLine = lines[i + 1]?.trim();
      const filePath = pathLine?.match(CODEX_FILE_PATH_REGEX)?.groups?.path;
      pushEvent(
        'edit_file',
        'file update',
        filePath ? `edit_file ${filePath}` : 'edit_file via file update',
        filePath ? { path: filePath } : undefined,
        `${line}\n${pathLine || ''}`,
      );
      continue;
    }

    if (line.startsWith('apply_patch(')) {
      pushEvent('edit_file', 'apply_patch', 'edit_file via apply_patch', undefined, line);
    }
  }

  return events;
}

/**
 * Parse Claude's --output-format stream-json --verbose NDJSON output.
 * Each line is a JSON object. Tool calls appear in `assistant` messages
 * as content blocks with `type: "tool_use"`.
 */
function extractClaudeStreamJsonEvents(
  traceOutput: string,
  turnNumber?: number,
): ToolEvent[] {
  const events: ToolEvent[] = [];

  for (const line of traceOutput.split('\n')) {
    if (!line.trim()) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== 'assistant') continue;

    const message = parsed.message as { content?: Array<Record<string, unknown>> } | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type !== 'tool_use') continue;

      const providerToolName = String(block.name || 'unknown');
      const args = (block.input as Record<string, unknown>) || undefined;
      const action = TOOL_NAME_MAP[providerToolName] ?? 'unknown';
      const summary = buildSummary(action, providerToolName, args);
      const rawSnippet = JSON.stringify(block).slice(0, 200);

      events.push({
        action,
        provider: 'claude',
        providerToolName,
        turnNumber,
        arguments: args,
        summary,
        confidence: 'high',
        rawSnippet,
      });
    }
  }

  return events;
}

function buildSummary(action: ToolAction, toolName: string, args?: Record<string, unknown>): string {
  if (!args) return `${action} via ${toolName}`;

  const cmd = args.cmd ?? args.command;
  if (cmd && typeof cmd === 'string') return cmd.slice(0, 100);

  const filePath = args.path ?? args.file ?? args.file_path;
  if (filePath && typeof filePath === 'string') return `${action} ${filePath}`;

  const pattern = args.pattern ?? args.query;
  if (pattern && typeof pattern === 'string') return `${action} "${pattern}"`;

  return `${action} via ${toolName}`;
}

function inferCodexExecAction(command: string): ToolAction {
  const normalized = command.trim();
  if (
    /\b(cat|sed|head|tail|less|more)\b/.test(normalized)
  ) {
    return 'read_file';
  }
  if (/\b(rg|grep)\b/.test(normalized)) {
    return 'search_code';
  }
  if (/\b(ls|find)\b/.test(normalized)) {
    return 'list_files';
  }
  return 'run_shell';
}
