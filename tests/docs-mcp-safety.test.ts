import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import path from 'path';

const docsDir = path.join(__dirname, '..', 'docs');

describe('MCP safety documentation', () => {
    it('documents cross-runtime MCP safety and Claude runtime-compatible config rules', async () => {
        const guide = await fs.readFile(path.join(docsDir, 'USER_GUIDE.md'), 'utf8');

        expect(guide).toContain('cross-runtime contract');
        expect(guide).toContain('MCP runtime mounting');
        expect(guide).toContain('MCP safety policy');
        expect(guide).toContain('runtime-compatible MCP config');
        expect(guide).toContain('Claude rejects Codex-only');
        expect(guide).toContain('missing `liveOptIn`');
        expect(guide).toContain('pre-trial configuration error');
        expect(guide).toContain('runtimes with MCP runtime mounting but no MCP safety enforcement');
        expect(guide).toContain('fails fast for live `mcpSafety` modes');
    });

    it('documents denied MCP evidence in the public guide', async () => {
        const guide = await fs.readFile(path.join(docsDir, 'USER_GUIDE.md'), 'utf8');

        expect(guide).toContain('mcp_tool_call');
        expect(guide).toContain('status: "policy_denied"');
        expect(guide).toContain('Denied calls are declined before approval');
        expect(guide).toContain('secret-looking MCP arguments are redacted');
    });
});
