export type ToolAction =
  | 'run_shell'
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'search_code'
  | 'list_files'
  | 'ask_user'
  | 'web_fetch'
  | 'unknown';

export interface ToolEvent {
  action: ToolAction;
  provider: 'claude' | 'codex' | 'gemini';
  providerToolName: string;
  turnNumber?: number;
  arguments?: Record<string, unknown>;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  rawSnippet: string;
}

export function summarizeToolEvents(events: ToolEvent[]): string {
  return events.map((event) => `${event.action}:${event.providerToolName}`).join(', ');
}
