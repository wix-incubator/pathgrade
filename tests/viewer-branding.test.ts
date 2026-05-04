import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

describe('viewer branding', () => {
    it('uses pathgrade branding in source and built viewer HTML', () => {
        for (const relativePath of ['src/viewer.html', 'dist/viewer.html']) {
            const html = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

            expect(html).toContain('<title>Pathgrade</title>');
            expect(html).toContain('>path<');
            expect(html).not.toContain('>skill<');
            expect(html.toLowerCase()).not.toContain(['skill', 'grade'].join(''));
        }
    });

    it('renders session log user replies in source and built viewer HTML', () => {
        for (const relativePath of ['src/viewer.html', 'dist/viewer.html']) {
            const html = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

            expect(html).toContain("case 'user_reply':");
            expect(html).toContain("esc(e.instruction || '')");
        }
    });

    it('renders command log entries as collapsed details in source and built viewer HTML', () => {
        for (const relativePath of ['src/viewer.html', 'dist/viewer.html']) {
            const html = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

            expect(html).toContain('log-command-details');
            expect(html).toContain('log-command-summary');
            expect(html).toContain('log-command-text');
        }
    });
});
