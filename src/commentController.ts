import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOps';
import { DiffContext, CommentThread as ADOThread } from './types';

export class PRCommentController {
    private controller: vscode.CommentController;
    private threads = new Map<string, vscode.CommentThread[]>();
    private diffContexts = new Map<string, DiffContext>();
    private openDiffs = new Map<string, { baseUri: vscode.Uri; headUri: vscode.Uri; ctx: DiffContext }>();

    constructor(private client: AzureDevOpsClient) {
        this.controller = vscode.comments.createCommentController(
            'ninjaReviewer.comments',
            'Ninja Reviewer'
        );
        this.controller.commentingRangeProvider = {
            provideCommentingRanges: (document: vscode.TextDocument) => {
                // Allow new-comment gutter clicks on our diff scheme; comments
                // can also be displayed (read-only) on git: URIs from the
                // built-in Git extension when reviewing a Clone & Review window.
                if (document.uri.scheme !== 'ninja-reviewer' && document.uri.scheme !== 'git') {
                    return [];
                }
                return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
            }
        };
    }

    registerDiffContext(uri: string, ctx: DiffContext): void {
        this.diffContexts.set(uri, ctx);
    }

    async loadComments(baseUri: vscode.Uri, headUri: vscode.Uri, ctx: DiffContext): Promise<void> {
        // Track this diff for auto-refresh
        const key = `${ctx.repoId}:${ctx.prId}:${ctx.filePath}`;
        this.openDiffs.set(key, { baseUri, headUri, ctx });

        this.clearThreads(headUri.toString());
        this.clearThreads(baseUri.toString());

        let adoThreads: ADOThread[];
        try {
            adoThreads = await this.client.getThreads(ctx.repoId, ctx.prId);
        } catch (err) {
            console.error('[Ninja Reviewer] Failed to fetch threads:', err);
            return;
        }

        console.log(`[Ninja Reviewer] Fetched ${adoThreads.length} threads for PR #${ctx.prId}`);

        const fileThreads = adoThreads.filter(t => {
            if (t.isDeleted) { return false; }
            if (!t.threadContext) { return false; }
            // Normalize paths for comparison (ADO may use different casing or leading slashes)
            const threadPath = t.threadContext.filePath?.replace(/\\/g, '/');
            const targetPath = ctx.filePath.replace(/\\/g, '/');
            if (threadPath !== targetPath) { return false; }
            if (!t.comments.some(c => !c.isDeleted)) { return false; }
            return true;
        });

        console.log(`[Ninja Reviewer] ${fileThreads.length} threads match file ${ctx.filePath}`);

        for (const adoThread of fileThreads) {
            const line = adoThread.threadContext?.rightFileStart?.line
                ?? adoThread.threadContext?.leftFileStart?.line;

            if (!line) { continue; }

            const uri = adoThread.threadContext?.rightFileStart ? headUri : baseUri;
            const vsLine = Math.max(0, line - 1); // ADO is 1-based, VS Code is 0-based

            const comments: vscode.Comment[] = adoThread.comments
                .filter(c => !c.isDeleted)
                .map(c => ({
                    body: new vscode.MarkdownString(c.content),
                    author: { name: c.author.displayName },
                    mode: vscode.CommentMode.Preview,
                    timestamp: new Date(c.publishedDate),
                }));

            if (comments.length === 0) { continue; }

            const thread = this.controller.createCommentThread(
                uri,
                new vscode.Range(vsLine, 0, vsLine, 0),
                comments
            );
            thread.label = getThreadStatusLabel(adoThread.status);
            thread.canReply = true;
            (thread as any).adoThreadId = adoThread.id;
            (thread as any).diffContext = ctx;

            const existing = this.threads.get(uri.toString()) ?? [];
            existing.push(thread);
            this.threads.set(uri.toString(), existing);
        }
    }

    async handleReply(reply: vscode.CommentReply): Promise<void> {
        const thread = reply.thread;
        const ctx: DiffContext | undefined =
            (thread as any).diffContext ?? this.diffContexts.get(thread.uri.toString());
        const adoThreadId: number | undefined = (thread as any).adoThreadId;

        if (!ctx) {
            vscode.window.showErrorMessage('Cannot determine PR context for this comment.');
            return;
        }

        // Attach context so subsequent replies on this thread work
        (thread as any).diffContext = ctx;

        try {
            if (adoThreadId) {
                // Reply to existing thread
                await this.client.replyToThread(ctx.repoId, ctx.prId, adoThreadId, reply.text);
            } else {
                // New thread
                const line = thread.range.start.line + 1; // VS Code 0-based → ADO 1-based
                const newThread = await this.client.createThread(
                    ctx.repoId, ctx.prId, ctx.filePath, line, reply.text
                );
                (thread as any).adoThreadId = newThread.id;
            }

            // Add the comment to the thread locally
            const newComment: vscode.Comment = {
                body: new vscode.MarkdownString(reply.text),
                author: { name: 'You' },
                mode: vscode.CommentMode.Preview,
                timestamp: new Date(),
            };
            thread.comments = [...thread.comments, newComment];
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to post comment: ${err.message}`);
        }
    }

    async refreshAllComments(): Promise<void> {
        for (const { baseUri, headUri, ctx } of this.openDiffs.values()) {
            await this.loadComments(baseUri, headUri, ctx);
        }
    }

    /**
     * Expand the comment thread anchored at (or nearest to) the given line on
     * the given side, for the supplied diff context. Returns true if a thread
     * was found and expanded.
     */
    revealThread(ctx: DiffContext, line: number, side: 'left' | 'right' = 'right'): boolean {
        const key = `${ctx.repoId}:${ctx.prId}:${ctx.filePath}`;
        const open = this.openDiffs.get(key);
        if (!open) { return false; }

        const targetUri = side === 'left' ? open.baseUri : open.headUri;
        const candidates = this.threads.get(targetUri.toString()) ?? [];
        if (candidates.length === 0) { return false; }

        const targetLine = Math.max(0, line - 1); // ADO 1-based -> VS Code 0-based
        // Pick the thread whose start line is closest to the requested line.
        let best: vscode.CommentThread | undefined;
        let bestDelta = Number.POSITIVE_INFINITY;
        for (const t of candidates) {
            const delta = Math.abs(t.range.start.line - targetLine);
            if (delta < bestDelta) {
                bestDelta = delta;
                best = t;
            }
        }
        if (!best) { return false; }

        best.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        return true;
    }

    private clearThreads(uriString: string): void {
        const existing = this.threads.get(uriString);
        if (existing) {
            existing.forEach(t => t.dispose());
            this.threads.delete(uriString);
        }
    }

    dispose(): void {
        for (const threads of this.threads.values()) {
            threads.forEach(t => t.dispose());
        }
        this.threads.clear();
        this.openDiffs.clear();
        this.controller.dispose();
    }
}

function getThreadStatusLabel(status: number): string {
    switch (status) {
        case 1: return '💬 Active';
        case 2: return '✅ Fixed';
        case 3: return '✅ Won\'t Fix';
        case 4: return '✅ Closed';
        case 5: return '📌 By Design';
        case 6: return '⏳ Pending';
        default: return '💬 Comment';
    }
}
