import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOps';
import { DiffContext, CodeSearchResult, CodeSearchMatch } from './types';

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/;

// Language keywords + extremely common identifiers that produce noisy results.
const SKIP_WORDS = new Set([
    // keywords (multi-language)
    'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue',
    'switch', 'case', 'default', 'new', 'this', 'super', 'throw', 'try',
    'catch', 'finally', 'function', 'class', 'const', 'let', 'var', 'true',
    'false', 'null', 'undefined', 'void', 'typeof', 'instanceof', 'in', 'of',
    'async', 'await', 'yield', 'import', 'export', 'from', 'as', 'public',
    'private', 'protected', 'static', 'readonly', 'interface', 'type', 'enum',
    'extends', 'implements', 'namespace', 'module', 'declare', 'abstract',
    'int', 'string', 'bool', 'boolean', 'number', 'float', 'double', 'char',
    'def', 'pass', 'lambda', 'self', 'None', 'True', 'False',
    // hyper-common identifiers
    'data', 'value', 'values', 'item', 'items', 'name', 'names', 'id', 'ids',
    'key', 'keys', 'result', 'results', 'error', 'err', 'msg', 'message',
    'args', 'arg', 'opts', 'options', 'cb', 'callback', 'index', 'idx', 'tmp',
    'temp', 'foo', 'bar', 'baz', 'log', 'logger', 'console',
]);

const NEGATIVE_PATH_HINTS = [
    /\/node_modules\//i,
    /\/dist\//i,
    /\/out\//i,
    /\/build\//i,
    /\/vendor\//i,
    /\/generated\//i,
    /\.min\.[a-z]+$/i,
    /\.bundle\.[a-z]+$/i,
];

const TEST_PATH_HINTS = [
    /\/__tests__\//i,
    /\/test(s)?\//i,
    /\.spec\.[a-z]+$/i,
    /\.test\.[a-z]+$/i,
];

interface ScoredResult {
    result: CodeSearchResult;
    score: number;
    isDef: boolean;
    bestLine: number | undefined;
    bestColumn: number | undefined;
    bestSnippet: string | undefined;
    extraLines: number[];
}

export class HoverExplainerProvider implements vscode.HoverProvider {
    private explanationCache = new Map<string, string>();
    private usagesCache = new Map<string, ScoredResult[]>();
    private diffContexts = new Map<string, DiffContext>();

    constructor(private client: AzureDevOpsClient) {}

    registerDiffContext(uri: string, ctx: DiffContext): void {
        this.diffContexts.set(uri, ctx);
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        if (document.uri.scheme !== 'ninja-reviewer') {
            return undefined;
        }

        const line = document.lineAt(position.line);
        if (line.isEmptyOrWhitespace) {
            return undefined;
        }

        const diffCtx = this.diffContexts.get(document.uri.toString());

        const wordRange = document.getWordRangeAtPosition(position, IDENTIFIER_RE);
        const word = wordRange ? document.getText(wordRange) : undefined;
        const isMemberAccess = wordRange ? this.isMemberAccess(line.text, wordRange.start.character) : false;
        const fileExt = this.getExt(document.uri.path);

        const [explanation, usages] = await Promise.all([
            this.getCachedExplanation(document, position, line.text, diffCtx, token),
            this.getCachedUsages(word, isMemberAccess, fileExt, diffCtx, token),
        ]);

        if (token.isCancellationRequested) {
            return undefined;
        }

        if (!explanation && (!usages || usages.length === 0)) {
            return undefined;
        }

        return this.createHover(explanation, word, usages, diffCtx);
    }

    private isMemberAccess(lineText: string, col: number): boolean {
        // Skip whitespace immediately before the identifier and check for '.'.
        let i = col - 1;
        while (i >= 0 && /\s/.test(lineText[i])) { i--; }
        return i >= 0 && (lineText[i] === '.' || lineText[i] === '?');
    }

    private getExt(path: string): string | undefined {
        const m = /\.([A-Za-z0-9]+)$/.exec(path);
        return m ? m[1].toLowerCase() : undefined;
    }

    private async getCachedExplanation(
        document: vscode.TextDocument,
        position: vscode.Position,
        lineText: string,
        diffCtx: DiffContext | undefined,
        token: vscode.CancellationToken
    ): Promise<string | undefined> {
        const key = `${document.uri.toString()}:${position.line}`;
        if (this.explanationCache.has(key)) {
            return this.explanationCache.get(key);
        }

        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 5);
        const contextLines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            const prefix = i === position.line ? '>>> ' : '    ';
            contextLines.push(`${prefix}${document.lineAt(i).text}`);
        }

        const prInfo = diffCtx
            ? `This is from PR #${diffCtx.prId}: "${diffCtx.prTitle}" (${diffCtx.changeType} file: ${diffCtx.filePath})`
            : 'This is a code change from a pull request.';

        try {
            const result = await this.requestExplanation(
                lineText,
                contextLines.join('\n'),
                prInfo,
                document.languageId,
                token
            );
            if (result) {
                this.explanationCache.set(key, result);
            }
            return result;
        } catch (err: any) {
            if (token.isCancellationRequested) {
                return undefined;
            }
            return `*Could not generate explanation: ${err.message}*`;
        }
    }

    private async requestExplanation(
        lineText: string,
        surroundingCode: string,
        prContext: string,
        languageId: string,
        token: vscode.CancellationToken
    ): Promise<string | undefined> {
        let models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
        }
        if (models.length === 0) {
            models = await vscode.lm.selectChatModels();
        }
        if (models.length === 0) {
            return '*No language model available. Make sure GitHub Copilot is installed and signed in.*';
        }

        const prompt = `You are a senior code reviewer helping someone understand a pull request.

${prContext}

Here is the code context (the line marked with >>> is the one being reviewed):

\`\`\`${languageId}
${surroundingCode}
\`\`\`

The specific line is:
\`\`\`
${lineText.trim()}
\`\`\`

Provide a brief, clear explanation of:
1. **What**: What this line does
2. **Why**: Why this change might have been made (in the context of the surrounding code)
3. **Impact**: Any potential impact or side effects

Keep your response concise (3-5 sentences total). Use markdown formatting.`;

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const response = await models[0].sendRequest(messages, {}, token);

        let result = '';
        for await (const chunk of response.text) {
            result += chunk;
        }
        return result;
    }

    private async getCachedUsages(
        word: string | undefined,
        isMemberAccess: boolean,
        fileExt: string | undefined,
        diffCtx: DiffContext | undefined,
        token: vscode.CancellationToken
    ): Promise<ScoredResult[] | undefined> {
        if (!word || word.length < 3 || SKIP_WORDS.has(word)) {
            return undefined;
        }
        if (!diffCtx) {
            return undefined;
        }

        const branch = diffCtx.sourceBranch;
        const cacheKey = `${diffCtx.repoId}:${branch}:${fileExt ?? ''}:${isMemberAccess ? 'm' : 'i'}:${word}`;
        if (this.usagesCache.has(cacheKey)) {
            return this.usagesCache.get(cacheKey);
        }

        // Build search text:
        //  - exact-token via quotes
        //  - bias by extension (inline ext: filter)
        const quoted = `"${word}"`;
        const extPart = fileExt ? ` ext:${fileExt}` : '';
        const refQueryText = `${quoted}${extPart}`;

        try {
            // Two queries in parallel, both restricted to the PR's repo:
            //  - "def" query: structured CodeElement filter so the indexer
            //    returns only declarations.
            //  - "ref" query: plain text — returns all occurrences (defs + calls).
            const [defResults, refResults] = await Promise.all([
                this.client.searchCode(refQueryText, {
                    repositoryName: diffCtx.repoName,
                    codeElements: ['def', 'class', 'method', 'function', 'interface', 'enum', 'type'],
                    top: 25,
                }),
                this.client.searchCode(refQueryText, {
                    repositoryName: diffCtx.repoName,
                    top: 75,
                }),
            ]);

            if (token.isCancellationRequested) {
                return undefined;
            }

            // Score def and ref results separately so a file appearing in both
            // shows up under BOTH sections (definition + call sites).
            const fileDir = diffCtx.filePath.substring(0, diffCtx.filePath.lastIndexOf('/'));
            const scored: ScoredResult[] = [];
            const seen = new Set<string>();

            for (const r of defResults) {
                const k = `def:${r.repository.id}:${r.path}`;
                if (seen.has(k)) { continue; }
                seen.add(k);
                scored.push(this.score(r, word, diffCtx, fileDir, fileExt, true));
            }
            for (const r of refResults) {
                const k = `ref:${r.repository.id}:${r.path}`;
                if (seen.has(k)) { continue; }
                seen.add(k);
                scored.push(this.score(r, word, diffCtx, fileDir, fileExt, false));
            }

            scored.sort((a, b) => b.score - a.score);
            const trimmed = scored.slice(0, 30);
            this.usagesCache.set(cacheKey, trimmed);
            return trimmed;
        } catch {
            return undefined;
        }
    }

    private score(
        r: CodeSearchResult,
        word: string,
        diffCtx: DiffContext,
        fileDir: string,
        fileExt: string | undefined,
        isDef: boolean
    ): ScoredResult {
        let score = 0;

        if (r.repository.id === diffCtx.repoId) { score += 50; }
        if (fileDir && r.path.startsWith(fileDir)) { score += 15; }
        if (fileExt && r.path.toLowerCase().endsWith('.' + fileExt)) { score += 10; }
        if (isDef) { score += 30; }

        if (r.path === diffCtx.filePath) { score += 5; } // self-reference; mild bonus

        for (const re of TEST_PATH_HINTS) {
            if (re.test(r.path)) { score -= 15; break; }
        }
        for (const re of NEGATIVE_PATH_HINTS) {
            if (re.test(r.path)) { score -= 25; break; }
        }

        // Pick best match: prefer matches whose snippet contains the exact token as a whole word.
        const matches: CodeSearchMatch[] = r.matches?.content ?? [];
        const wordRe = new RegExp(`\\b${escapeRegex(word)}\\b`);
        let best: CodeSearchMatch | undefined;
        let bestSnippet: string | undefined;
        const lines = new Set<number>();

        for (const m of matches) {
            if (typeof m.line === 'number' && m.line > 0) {
                lines.add(m.line);
            }
            const snippet = (m.codeSnippet || '').trim();
            if (!best && snippet && wordRe.test(snippet)) {
                best = m;
                bestSnippet = snippet;
            }
        }
        if (!best && matches.length > 0) {
            best = matches[0];
            bestSnippet = (best.codeSnippet || '').trim() || undefined;
        }
        score += Math.min(matches.length, 5); // small boost for multiple hits

        const sortedLines = Array.from(lines).sort((a, b) => a - b);
        const bestLine = best?.line ?? sortedLines[0];
        const bestColumn = best?.column;
        const extraLines = sortedLines.filter(l => l !== bestLine).slice(0, 4);

        return { result: r, score, isDef, bestLine, bestColumn, bestSnippet, extraLines };
    }

    private createHover(
        explanation: string | undefined,
        word: string | undefined,
        usages: ScoredResult[] | undefined,
        diffCtx: DiffContext | undefined
    ): vscode.Hover {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;
        md.appendMarkdown(`### 🥷 Ninja Reviewer\n\n`);

        if (explanation) {
            md.appendMarkdown(explanation);
            md.appendMarkdown('\n\n');
        }

        if (word && usages && usages.length > 0) {
            // Split by whether the result came from the def: query, not by score.
            const defs = usages.filter(u => u.isDef);
            const refs = usages.filter(u => !u.isDef);

            md.appendMarkdown(`---\n\n`);

            if (defs.length > 0) {
                md.appendMarkdown(`**🎯 Definition of \`${word}\`**\n\n`);
                for (const u of defs.slice(0, 3)) {
                    this.renderItem(md, u, diffCtx);
                }
                md.appendMarkdown('\n');
            }

            if (refs.length > 0) {
                md.appendMarkdown(`**Usages of \`${word}\`** (${refs.length})\n\n`);
                const maxItems = 12;
                for (const u of refs.slice(0, maxItems)) {
                    this.renderItem(md, u, diffCtx);
                }
                if (refs.length > maxItems) {
                    md.appendMarkdown(`\n_…and ${refs.length - maxItems} more_\n`);
                }
            }
        }

        return new vscode.Hover(md);
    }

    private renderItem(md: vscode.MarkdownString, u: ScoredResult, diffCtx: DiffContext | undefined): void {
        const r = u.result;
        const branch = r.versions?.[0]?.branchName ?? diffCtx?.sourceBranch;
        const sameRepo = diffCtx && r.repository.id === diffCtx.repoId;
        const repoLabel = sameRepo ? '' : ` _(${r.repository.name})_`;

        const primaryLink = this.buildOpenLink(r.repository.id, r.path, branch, u.bestLine, u.bestColumn);
        const lineSuffix = u.bestLine ? `:${u.bestLine}` : '';
        const more = u.extraLines.length > 0
            ? '  ' + u.extraLines.map(ln =>
                `[L${ln}](${this.buildOpenLink(r.repository.id, r.path, branch, ln, undefined)})`
            ).join(', ')
            : '';

        md.appendMarkdown(`- [${escapeMd(r.path)}${lineSuffix}](${primaryLink})${repoLabel}${more}\n`);

        if (u.bestSnippet) {
            const snippet = truncate(stripHtml(u.bestSnippet), 140);
            md.appendMarkdown(`    \`${snippet.replace(/`/g, '\\`')}\`\n`);
        }
    }

    private buildOpenLink(
        repoId: string,
        path: string,
        branch: string | undefined,
        line: number | undefined,
        column: number | undefined
    ): string {
        const args = encodeURIComponent(JSON.stringify({ repoId, path, branch, line, column }));
        return `command:ninjaReviewer.openFileFromAdo?${args}`;
    }

    clearCache(): void {
        this.explanationCache.clear();
        this.usagesCache.clear();
    }
}

function escapeMd(text: string): string {
    return text.replace(/([\\`*_{}\[\]()#+\-.!|])/g, '\\$1');
}

function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHtml(s: string): string {
    return s.replace(/<[^>]+>/g, '');
}

function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
