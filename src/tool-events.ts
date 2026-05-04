export type ToolAction =
  | 'run_shell'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search_code'
  | 'list_files'
  | 'ask_user'
  | 'web_fetch'
  | 'use_skill'
  // `update_todos` is agent-internal planning, not an observable effect like
  // the other actions. Scorers that enumerate ToolAction to mean "the agent
  // did something external" should exclude it explicitly.
  | 'update_todos'
  | 'unknown';

export interface ToolEvent {
  action: ToolAction;
  provider: 'claude' | 'codex' | 'cursor';
  providerToolName: string;
  turnNumber?: number;
  arguments?: Record<string, unknown>;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  rawSnippet: string;
  skillName?: string;
}

export function summarizeToolEvents(events: ToolEvent[]): string {
  return events.map((event) => `${event.action}:${event.providerToolName}`).join(', ');
}

/**
 * Map from provider-specific tool names to normalized Pathgrade actions.
 * Conservative: only map names we're confident about.
 */
export const TOOL_NAME_MAP: Record<string, ToolAction> = {
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
  request_user_input: 'ask_user', // Codex
  AskQuestion: 'ask_user', // Cursor (pre-requisite for cursor driver)

  // Web
  web_fetch: 'web_fetch',
  fetch: 'web_fetch',
  WebFetch: 'web_fetch',

  // Claude Code tool names (PascalCase)
  Skill: 'use_skill',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  Bash: 'run_shell',
  Grep: 'search_code',
  Glob: 'list_files',
  Agent: 'unknown',
  NotebookEdit: 'edit_file',
  TodoWrite: 'update_todos',

  // Cursor stream-json tool_call discriminants
  readToolCall: 'read_file',
  editToolCall: 'edit_file',
  globToolCall: 'list_files',
  grepToolCall: 'search_code',
  shellToolCall: 'run_shell',
  webFetchToolCall: 'web_fetch',
  updateTodosToolCall: 'update_todos',
};

export function buildSummary(action: ToolAction, toolName: string, args?: Record<string, unknown>): string {
  if (!args) return `${action} via ${toolName}`;

  // ask_user: render strictly from question count + first header. Never reach
  // into `values`/`answer` — the bus redacts isSecret answers, but this is the
  // only seam where a future refactor could accidentally read answer data and
  // bypass redaction. Belt-and-braces.
  if (action === 'ask_user') {
    const questions = args.questions;
    if (Array.isArray(questions)) {
      const count = questions.length;
      const firstHeader = questions.find((q): q is { header: string } =>
        !!q && typeof q === 'object' && typeof (q as { header?: unknown }).header === 'string',
      )?.header;
      return firstHeader
        ? `asked ${count} question${count === 1 ? '' : 's'}: ${firstHeader}`
        : `asked ${count} question${count === 1 ? '' : 's'}`;
    }
    return `${action} via ${toolName}`;
  }

  const cmd = args.cmd ?? args.command;
  if (cmd && typeof cmd === 'string') return cmd.slice(0, 100);

  const filePath = args.path ?? args.file ?? args.file_path;
  if (filePath && typeof filePath === 'string') return `${action} ${filePath}`;

  const pattern = args.pattern ?? args.query;
  if (pattern && typeof pattern === 'string') return `${action} "${pattern}"`;

  return `${action} via ${toolName}`;
}

/**
 * Extract deduplicated skill names from a session log (LogEntry[]).
 * Filters for tool_event entries, then delegates to extractSkillsFromToolEvents.
 */
export function extractSkillsFromLog(log: ReadonlyArray<{ type: string; tool_event?: ToolEvent }>): string[] {
  const toolEvents = log
    .filter((e): e is { type: 'tool_event'; tool_event: ToolEvent } =>
      e.type === 'tool_event' && e.tool_event != null)
    .map((e) => e.tool_event);
  return extractSkillsFromToolEvents(toolEvents);
}

/**
 * Extract deduplicated skill names from tool events that have action 'use_skill'.
 */
export function extractSkillsFromToolEvents(events: ToolEvent[]): string[] {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.action === 'use_skill' && event.skillName) {
      seen.add(event.skillName);
    }
  }
  return [...seen];
}

/**
 * Post-processing pass: detect skill usage from tool events.
 * - Skill tool calls: action is already 'use_skill', extract skillName from args.skill
 * - Read on SKILL.md: override action to 'use_skill', extract skillName from path
 *
 * This is agent-agnostic — works for any provider that produces ToolEvent[].
 */
export function enrichSkillEvents(events: ToolEvent[]): ToolEvent[] {
  return events.map((event) => {
    // Skill tool call — already mapped to use_skill by TOOL_NAME_MAP
    if (event.action === 'use_skill' && !event.skillName) {
      const skill = event.arguments?.skill;
      if (typeof skill === 'string') {
        return { ...event, skillName: skill };
      }
    }

    // Read on SKILL.md — reclassify as use_skill
    if (event.action === 'read_file') {
      const filePath = event.arguments?.file_path ?? event.arguments?.path;
      if (typeof filePath === 'string') {
        const skillName = extractSkillNameFromPath(filePath);
        if (skillName) {
          return { ...event, action: 'use_skill' as ToolAction, skillName };
        }
      }
    }

    return event;
  });
}

/**
 * If a file path points to a SKILL.md file, return the parent directory name as the skill name.
 * Returns undefined for non-SKILL.md paths.
 */
export function extractSkillNameFromPath(filePath: string): string | undefined {
  if (!filePath.endsWith('/SKILL.md')) return undefined;
  const parts = filePath.split('/').filter(Boolean);
  // Need at least [skillName, 'SKILL.md']
  if (parts.length < 2) return undefined;
  return parts[parts.length - 2];
}

export function inferCodexExecAction(command: string): ToolAction {
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
