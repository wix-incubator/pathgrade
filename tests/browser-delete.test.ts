import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { runBrowserPreview } from '../src/reporters/browser.js';

function fetch(url: string, options: { method?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(parsed, { method: options.method || 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('browser preview DELETE /api/report', () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pathgrade-test-'));
    server = await runBrowserPreview(tmpDir, 0);
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.remove(tmpDir);
  });

  it('deletes the file and returns 200', async () => {
    const reportFile = 'pathgrade-test-2025-01-01.json';
    await fs.writeJSON(path.join(tmpDir, reportFile), { name: 'test', passRate: 1 });

    const res = await fetch(`${baseUrl}/api/report?file=${reportFile}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    expect(await fs.pathExists(path.join(tmpDir, reportFile))).toBe(false);
  });

  it('returns 400 when file param is missing', async () => {
    const res = await fetch(`${baseUrl}/api/report`, { method: 'DELETE' });

    expect(res.status).toBe(400);
  });

  it('returns 403 for path traversal attempt', async () => {
    const res = await fetch(`${baseUrl}/api/report?file=../../../etc/passwd`, { method: 'DELETE' });

    expect(res.status).toBe(403);
  });

  it('returns 404 for nonexistent file', async () => {
    const res = await fetch(`${baseUrl}/api/report?file=nope.json`, { method: 'DELETE' });

    expect(res.status).toBe(404);
  });
});
