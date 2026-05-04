import * as http from 'http';
import fs from 'fs-extra';
import * as path from 'path';
import { loadReports } from './loader.js';

export function runBrowserPreview(resultsDir: string, port: number = 3847): Promise<http.Server> {
    const resolved = path.resolve(resultsDir);
    const htmlPath = path.join(import.meta.dirname, '..', 'viewer.html');

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${port}`);

        if (url.pathname === '/api/reports') {
            const reports = await loadReports(resolved, { skipTraces: true });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(reports));
        } else if (url.pathname === '/api/report') {
            const file = url.searchParams.get('file');
            if (!file) { res.writeHead(400); res.end('Missing file param'); return; }
            const filePath = path.resolve(resolved, file);
            if (!filePath.startsWith(resolved + path.sep) && filePath !== resolved) {
                res.writeHead(403); res.end('Forbidden'); return;
            }
            if (req.method === 'DELETE') {
                if (await fs.pathExists(filePath)) {
                    await fs.remove(filePath);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ deleted: file }));
                } else {
                    res.writeHead(404); res.end('Not found');
                }
            } else {
                if (await fs.pathExists(filePath)) {
                    const raw = await fs.readJSON(filePath);
                    const groupIdx = parseInt(url.searchParams.get('group') || '0', 10);
                    let report = raw;
                    if (raw.version && Array.isArray(raw.groups)) {
                        report = { timestamp: raw.timestamp, ...raw.groups[groupIdx] };
                    }
                    // Merge trace data (session_log, conversation) back into trials
                    if (report.trace_file) {
                        const tracePath = path.resolve(resolved, report.trace_file);
                        if (await fs.pathExists(tracePath)) {
                            const traceTrials = await fs.readJSON(tracePath);
                            if (Array.isArray(traceTrials) && Array.isArray(report.trials)) {
                                report.trials = report.trials.map((t: any, i: number) => ({
                                    ...t,
                                    ...traceTrials[i],
                                }));
                            }
                        }
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(report));
                } else {
                    res.writeHead(404); res.end('Not found');
                }
            }
        } else {
            const html = await fs.readFile(htmlPath, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        }
    });

    return new Promise((resolve) => {
        server.listen(port, () => {
            const addr = server.address();
            const actualPort = typeof addr === 'object' && addr ? addr.port : port;
            console.log(`\npathgrade preview`);
            console.log(`\n  url       http://localhost:${actualPort}`);
            console.log(`  results   ${resolved}\n`);
            resolve(server);
        });
    });
}
