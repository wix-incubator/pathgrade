import { AgentCommandRunner, AgentSessionOptions, AgentTurnResult } from '../types.js';
import { ToolAction, ToolEvent, TOOL_NAME_MAP, buildSummary, inferCodexExecAction, enrichSkillEvents } from '../tool-events.js';
import { TranscriptAgent } from './transcript-agent.js';

export class CodexAgent extends TranscriptAgent {
    protected async runTurn(
        instruction: string,
        runCommand: AgentCommandRunner,
        options?: AgentSessionOptions,
    ): Promise<AgentTurnResult> {
        const promptPath = await this.writePromptFile(instruction, runCommand);
        const command = buildCodexExecCommand(promptPath, options?.model);
        const result = await runCommand(command);
        const rawOutput = result.stdout + '\n' + result.stderr;
        const assistantMessage = result.stdout.trim() || rawOutput.trim();

        if (result.exitCode !== 0) {
            console.error('CodexAgent: Codex CLI failed to execute correctly.');
        }

        const toolEvents = extractCodexToolEvents(rawOutput);

        return {
            rawOutput,
            assistantMessage,
            visibleAssistantMessage: assistantMessage,
            visibleAssistantMessageSource: 'assistant_message',
            exitCode: result.exitCode,
            traceOutput: rawOutput,
            blockedPrompts: [],
            toolEvents,
        };
    }
}

const DEFAULT_CODEX_MODEL = 'gpt-5.3-codex';
const CODEX_PROXY_PROVIDER_ID = 'pathgrade_openai_proxy';

function buildCodexExecCommand(promptPath: string, model: string = DEFAULT_CODEX_MODEL): string {
    const quotedPromptPath = JSON.stringify(promptPath);
    const quotedModel = JSON.stringify(model);
    const execArgs = `--full-auto --skip-git-repo-check -m ${quotedModel} - < ${quotedPromptPath}`;
    return [
        'if [ -n "${OPENAI_BASE_URL:-}" ]; then',
        `codex exec ${buildCodexProxyConfigArgs()} ${execArgs};`,
        'else',
        `codex exec ${execArgs};`,
        'fi',
    ].join(' ');
}

function buildCodexProxyConfigArgs(): string {
    return [
        `-c 'model_provider="${CODEX_PROXY_PROVIDER_ID}"'`,
        `-c 'model_providers.${CODEX_PROXY_PROVIDER_ID}.name="PathGrade OpenAI Proxy"'`,
        `-c "model_providers.${CODEX_PROXY_PROVIDER_ID}.base_url=\\"$OPENAI_BASE_URL\\""`,
        `-c 'model_providers.${CODEX_PROXY_PROVIDER_ID}.env_key="OPENAI_API_KEY"'`,
        `-c 'model_providers.${CODEX_PROXY_PROVIDER_ID}.wire_api="responses"'`,
        `-c 'model_providers.${CODEX_PROXY_PROVIDER_ID}.supports_websockets=false'`,
    ].join(' ');
}

const TOOL_LINE_REGEX = /^tool:\s+(\S+)\s+(\{.*\})\s*$/;
const CODEX_EXEC_LINE_REGEX = /^(?<command>.+?) in .+? (?:succeeded|failed|exited)\b.*$/;
const CODEX_EXEC_COMMAND_ONLY_REGEX = /^(?<command>.+?) in .+$/;
const CODEX_EXEC_STATUS_LINE_REGEX = /^(?:succeeded|failed|exited)\b.*$/;
const CODEX_FILE_PATH_REGEX = /^[A-Z?]+\s+(?<path>\/.+)$/;
const CODEX_ABSOLUTE_PATH_REGEX = /^(?<path>\/.+)$/;

function extractGenericToolLines(
  traceOutput: string,
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
      continue;
    }

    const action = TOOL_NAME_MAP[providerToolName] ?? 'unknown';
    const summary = buildSummary(action, providerToolName, args);
    const rawSnippet = line.length > 200 ? line.slice(0, 200) : line;

    events.push({
      action,
      provider: 'codex',
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

export function extractCodexToolEvents(traceOutput: string, turnNumber?: number): ToolEvent[] {
  const events = extractGenericToolLines(traceOutput, turnNumber);
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
      const command = extractCommand(commandLine);
      if (!command) continue;
      const statusLine = lines[i + 2]?.trim();
      const rawSnippetLines = [line, commandLine];
      if (statusLine && CODEX_EXEC_STATUS_LINE_REGEX.test(statusLine)) {
        rawSnippetLines.push(statusLine);
        i += 2;
      } else {
        i += 1;
      }
      pushEvent(inferCodexExecAction(command), 'exec', command, { command }, rawSnippetLines.join('\n'));
      continue;
    }

    if (line === 'file update') {
      const filePath = extractUpdatedPath(lines, i + 1);
      pushEvent(
        'edit_file',
        'file update',
        filePath ? `edit_file ${filePath}` : 'edit_file via file update',
        filePath ? { path: filePath } : undefined,
        `${line}\n${lines[i + 1]?.trim() || ''}`,
      );
      i += 1;
      continue;
    }

    if (line === 'apply patch' || line.startsWith('apply_patch(')) {
      const filePath = extractUpdatedPath(lines, i + 1);
      pushEvent(
        'edit_file',
        line === 'apply patch' ? 'apply patch' : 'apply_patch',
        filePath ? `edit_file ${filePath}` : 'edit_file via apply_patch',
        filePath ? { path: filePath } : undefined,
        `${line}\n${lines[i + 1]?.trim() || ''}`,
      );
      continue;
    }

  }

  return enrichSkillEvents(events);
}

function extractCommand(commandLine: string): string | undefined {
  const command = commandLine.match(CODEX_EXEC_LINE_REGEX)?.groups?.command
    ?? commandLine.match(CODEX_EXEC_COMMAND_ONLY_REGEX)?.groups?.command;
  if (!command) {
    return undefined;
  }

  const shellWrapped = command.match(/^\/bin\/\w+\s+-lc\s+(['"])(?<inner>[\s\S]+)\1$/);
  return shellWrapped?.groups?.inner ?? command;
}

function extractUpdatedPath(lines: string[], startIndex: number): string | undefined {
  for (let i = startIndex; i < Math.min(lines.length, startIndex + 5); i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const filePath = line.match(CODEX_FILE_PATH_REGEX)?.groups?.path
      ?? line.match(CODEX_ABSOLUTE_PATH_REGEX)?.groups?.path;
    if (filePath) {
      return filePath;
    }
  }
  return undefined;
}
