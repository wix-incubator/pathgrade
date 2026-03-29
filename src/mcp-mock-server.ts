import * as fs from 'fs';
import * as readline from 'readline';

interface FixtureTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    when?: string;
    response: unknown;
}

interface Fixture {
    name: string;
    tools: FixtureTool[];
}

function loadFixture(fixturePath: string): Fixture {
    const content = fs.readFileSync(fixturePath, 'utf-8');
    return JSON.parse(content);
}

function buildToolSchemas(fixture: Fixture): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    const seen = new Set<string>();
    const schemas: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [];
    for (const tool of fixture.tools) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        schemas.push({
            name: tool.name,
            description: tool.description || `Mock tool: ${tool.name}`,
            inputSchema: tool.inputSchema || { type: 'object' },
        });
    }
    return schemas;
}

function matchTool(fixture: Fixture, toolName: string, args: unknown): { response: unknown } | null {
    const inputStr = JSON.stringify(args);
    let fallback: FixtureTool | undefined;

    for (const entry of fixture.tools) {
        if (entry.name !== toolName) continue;
        if (entry.when) {
            if (new RegExp(entry.when, 'i').test(inputStr)) {
                return { response: entry.response };
            }
        } else if (!fallback) {
            fallback = entry;
        }
    }

    if (fallback) return { response: fallback.response };
    return null;
}

function formatResponse(response: unknown): string {
    return typeof response === 'string' ? response : JSON.stringify(response);
}

function sendResponse(id: number | string, result: unknown): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    process.stdout.write(msg + '\n');
}

function sendError(id: number | string, code: number, message: string): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    process.stdout.write(msg + '\n');
}

function main() {
    const fixturePath = process.argv[2];
    if (!fixturePath) {
        process.stderr.write('Usage: mcp-mock-server <fixture.json>\n');
        process.exit(1);
    }

    let fixture: Fixture;
    try {
        fixture = loadFixture(fixturePath);
    } catch (e) {
        process.stderr.write(`Failed to load fixture: ${(e as Error).message}\n`);
        process.exit(1);
    }

    const toolSchemas = buildToolSchemas(fixture);

    const rl = readline.createInterface({ input: process.stdin });

    rl.on('line', (line) => {
        if (!line.trim()) return;

        let msg: { jsonrpc?: string; id?: number | string; method?: string; params?: any };
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }

        // Notifications (no id) — acknowledge silently
        if (msg.id === undefined) return;

        switch (msg.method) {
            case 'initialize':
                sendResponse(msg.id, {
                    protocolVersion: '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: fixture.name, version: '1.0.0' },
                });
                break;

            case 'tools/list':
                sendResponse(msg.id, { tools: toolSchemas });
                break;

            case 'tools/call': {
                const toolName = msg.params?.name;
                const toolArgs = msg.params?.arguments ?? {};
                const match = matchTool(fixture, toolName, toolArgs);
                if (match) {
                    sendResponse(msg.id, {
                        content: [{ type: 'text', text: formatResponse(match.response) }],
                    });
                } else {
                    sendError(msg.id, -32602, `Unknown tool: ${toolName}`);
                }
                break;
            }

            case 'ping':
                sendResponse(msg.id, {});
                break;

            default:
                sendError(msg.id, -32601, `Method not found: ${msg.method}`);
                break;
        }
    });

    rl.on('close', () => process.exit(0));
}

main();
