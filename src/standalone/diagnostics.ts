export interface StandaloneVitestFailure {
    kind: 'packaging' | 'project-dependency';
    message: string;
}

export function classifyStandaloneVitestFailure(
    stderr: string,
): StandaloneVitestFailure | undefined {
    const unresolved = parseUnresolvedImport(stderr);
    if (!unresolved) return undefined;

    const { specifier, importer } = unresolved;
    if (isBundledSpecifier(specifier) || isInstalledToolImporter(importer)) {
        return {
            kind: 'packaging',
            message:
                `pathgrade standalone: bundled dependency "${specifier}" could not be resolved; ` +
                'this is a Pathgrade packaging defect',
        };
    }
    if (!isBareSpecifier(specifier)) return undefined;

    return {
        kind: 'project-dependency',
        message:
            `pathgrade standalone: project dependency "${specifier}" is unavailable in ${importer}; ` +
            'install the application dependencies or remove that import',
    };
}

function parseUnresolvedImport(
    stderr: string,
): { specifier: string; importer: string } | undefined {
    const vite = stderr.match(
        /Failed to resolve import\s+["']([^"']+)["']\s+from\s+["']([^"']+)["']/,
    );
    if (vite) return { specifier: vite[1], importer: vite[2] };

    const node = stderr.match(
        /Cannot find package\s+["']([^"']+)["']\s+imported from\s+([^\s\n]+)/,
    );
    if (!node) return undefined;
    return {
        specifier: node[1],
        importer: node[2].replace(/^["']|["']$/g, ''),
    };
}

function isBundledSpecifier(specifier: string): boolean {
    return specifier === 'vitest'
        || specifier.startsWith('vitest/')
        || specifier === '@wix/pathgrade'
        || specifier.startsWith('@wix/pathgrade/');
}

function isInstalledToolImporter(importer: string): boolean {
    const normalized = importer.replaceAll('\\', '/');
    return [
        '/node_modules/@wix/pathgrade/',
        '/node_modules/vitest/',
        '/node_modules/@anthropic-ai/claude-agent-sdk/',
        '/node_modules/@openai/codex/',
    ].some(segment => normalized.includes(segment));
}

function isBareSpecifier(specifier: string): boolean {
    return !specifier.startsWith('.')
        && !specifier.startsWith('/')
        && !specifier.startsWith('file:');
}
