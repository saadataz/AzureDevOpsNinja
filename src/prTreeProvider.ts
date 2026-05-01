import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOps';
import { PullRequest, ChangeEntry, Iteration, Repository, CommentThread } from './types';

type TreeItemType = 'repo' | 'pr' | 'file' | 'message' | 'section' | 'comment';

type SectionKind = 'files' | 'comments';

export class PRTreeProvider implements vscode.TreeDataProvider<PRTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PRTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private changesCache = new Map<number, { changes: ChangeEntry[]; iteration: Iteration }>();
    private threadsCache = new Map<number, CommentThread[]>();
    private selectedRepoIds: string[] = [];
    private allRepos: Repository[] = [];
    private focusedPR: PullRequest | undefined;
    /** When set, the tree shows pre-built items (used for local-worktree PR reviews). */
    private localChanges: {
        title: string;
        subtitle?: string;
        items: PRTreeItem[];
        /** When set, a Comments section is added that pulls threads from ADO. */
        adoPR?: { repoId: string; prId: number; pseudoPR: PullRequest };
    } | undefined;
    private treeView: vscode.TreeView<PRTreeItem> | undefined;

    constructor(
        private client: AzureDevOpsClient,
        private globalState: vscode.Memento
    ) {
        this.selectedRepoIds = globalState.get<string[]>('favoriteRepoIds', []);
    }

    /** Allow the extension to give us the TreeView so we can update its title when focusing. */
    attachTreeView(view: vscode.TreeView<PRTreeItem>): void {
        this.treeView = view;
    }

    /** Switch the sidebar to show ONLY the changed files for one PR. */
    focusPR(pr: PullRequest): void {
        this.focusedPR = pr;
        vscode.commands.executeCommand('setContext', 'ninjaReviewer.prFocused', true);
        if (this.treeView) {
            this.treeView.title = `PR #${pr.pullRequestId}`;
            this.treeView.description = pr.title;
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    /** Return to the repos / PR list view. */
    clearFocus(): void {
        this.focusedPR = undefined;
        this.localChanges = undefined;
        vscode.commands.executeCommand('setContext', 'ninjaReviewer.prFocused', false);
        if (this.treeView) {
            this.treeView.title = 'Pull Requests';
            this.treeView.description = undefined;
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Show a flat list of pre-built file items (used by Clone & Review in the
     * worktree window, where diffs are computed locally instead of via ADO).
     * If `adoPR` is provided, a Comments section is added alongside Files,
     * fetching threads from Azure DevOps for that PR.
     */
    focusLocalChanges(
        title: string,
        subtitle: string | undefined,
        items: PRTreeItem[],
        adoPR?: { repoId: string; prId: number; pseudoPR: PullRequest },
    ): void {
        this.localChanges = { title, subtitle, items, adoPR };
        this.focusedPR = undefined;
        // Drop any cached threads so the Comments section refetches.
        if (adoPR) {
            this.threadsCache.delete(adoPR.prId);
        }
        vscode.commands.executeCommand('setContext', 'ninjaReviewer.prFocused', true);
        if (this.treeView) {
            this.treeView.title = title;
            this.treeView.description = subtitle;
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    /**
     * Look up a precomputed local file item by its ADO-style file path
     * (e.g. "/src/foo.ts"). Used so a comment click can re-execute the
     * exact diff command we built for that file.
     */
    findLocalFileCommand(filePath: string): vscode.Command | undefined {
        if (!this.localChanges) { return undefined; }
        const norm = (p: string) => p.replace(/^\//, '').replace(/\\/g, '/').toLowerCase();
        const target = norm(filePath);
        for (const item of this.localChanges.items) {
            const tip = typeof item.tooltip === 'string' ? item.tooltip : '';
            // Tooltip format from buildLocalFileItem: "<Status>: <relPath>"
            const match = tip.split(':').slice(1).join(':').trim();
            if (match && norm(match) === target) {
                return item.command;
            }
        }
        return undefined;
    }

    refresh(): void {
        this.changesCache.clear();
        this.threadsCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: PRTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PRTreeItem): Promise<PRTreeItem[]> {
        if (!element) {
            // Local-worktree mode: show the precomputed file list (flat).
            if (this.localChanges) {
                return this.localChanges.items;
            }
            // Focused mode: show the changed files for the selected PR (flat).
            // Comments live in the built-in Comments panel — users can drag
            // it into this sidebar via right-click → Move View.
            if (this.focusedPR) {
                return this.getChangedFiles(this.focusedPR, /*flat*/ true);
            }
            return this.getRepositories();
        }
        if (element.type === 'repo' && element.repoId) {
            return this.getPullRequests(element.repoId);
        }
        if (element.type === 'pr' && element.pr) {
            return this.getChangedFiles(element.pr);
        }
        return [];
    }

    private getFocusedSections(): PRTreeItem[] {
        const filesSection = new PRTreeItem(
            'Files',
            'section',
            vscode.TreeItemCollapsibleState.Expanded,
        );
        filesSection.sectionKind = 'files';
        filesSection.iconPath = new vscode.ThemeIcon('files');

        const commentsSection = new PRTreeItem(
            'Comments',
            'section',
            vscode.TreeItemCollapsibleState.Expanded,
        );
        commentsSection.sectionKind = 'comments';
        commentsSection.iconPath = new vscode.ThemeIcon('comment-discussion');

        return [filesSection, commentsSection];
    }

    private async getCommentItems(pr: PullRequest): Promise<PRTreeItem[]> {
        try {
            let threads = this.threadsCache.get(pr.pullRequestId);
            if (!threads) {
                console.log(`[Ninja Reviewer] Fetching threads for PR #${pr.pullRequestId} in repo ${pr.repository.id}`);
                threads = await this.client.getThreads(pr.repository.id, pr.pullRequestId);
                console.log(`[Ninja Reviewer] Got ${threads.length} threads`);
                this.threadsCache.set(pr.pullRequestId, threads);
            }

            // We also need iteration commits so clicking a thread can open the diff.
            const cachedChanges = this.changesCache.get(pr.pullRequestId);
            const iteration = cachedChanges?.iteration
                ?? (await this.ensureIterationLoaded(pr));
            const changes = cachedChanges?.changes
                ?? this.changesCache.get(pr.pullRequestId)?.changes
                ?? [];

            // Surface only file-anchored, non-deleted threads with at least one
            // visible comment. PR-level / system threads are skipped here.
            const visible = threads.filter(t =>
                !t.isDeleted
                && t.threadContext?.filePath
                && t.comments.some(c => !c.isDeleted && c.content?.trim())
            );

            console.log(`[Ninja Reviewer] ${visible.length} of ${threads.length} threads are file-anchored with visible content.`);

            if (visible.length === 0) {
                const total = threads.length;
                const label = total === 0
                    ? 'No comments on this PR'
                    : `No file-anchored comments (${total} non-file thread${total === 1 ? '' : 's'} hidden)`;
                return [new PRTreeItem(label, 'message')];
            }

            return visible.map(thread => {
                const filePath = thread.threadContext!.filePath;
                const fileName = filePath.split('/').pop() || filePath;
                const line = thread.threadContext!.rightFileStart?.line
                    ?? thread.threadContext!.leftFileStart?.line
                    ?? 1;
                const side = thread.threadContext!.rightFileStart ? 'right' : 'left';
                const firstComment = thread.comments.find(c => !c.isDeleted && c.content?.trim());
                const author = firstComment?.author.displayName ?? 'Unknown';
                const snippet = (firstComment?.content ?? '')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 80);

                const item = new PRTreeItem(snippet || '(empty comment)', 'comment');
                item.description = `${author} · ${fileName}:${line}`;
                item.tooltip = new vscode.MarkdownString(
                    `**${author}** on \`${filePath}\`:${line}\n\n${firstComment?.content ?? ''}`
                );
                item.iconPath = threadStatusIcon(thread.status);

                // In local-worktree mode, jump to the file on disk; otherwise
                // open the ADO diff for the matching change.
                if (this.localChanges?.adoPR) {
                    item.command = {
                        command: 'ninjaReviewer.openLocalCommentTarget',
                        title: 'Open Comment',
                        arguments: [{ filePath, line }],
                    };
                } else {
                    const change = changes.find(c =>
                        (c.item.path || '').replace(/^\//, '') === filePath.replace(/^\//, '')
                    );
                    if (change && iteration) {
                        item.command = {
                            command: 'ninjaReviewer.openDiff',
                            title: 'Open Comment',
                            arguments: [{
                                pr,
                                change,
                                sourceCommitId: iteration.sourceRefCommit.commitId,
                                targetCommitId: iteration.targetRefCommit.commitId,
                                goto: { line, side },
                            }],
                        };
                    }
                }
                return item;
            });
        } catch (err: any) {
            console.error('[Ninja Reviewer] getCommentItems failed:', err);
            return [new PRTreeItem(`Error loading comments: ${err.message}`, 'message')];
        }
    }

    private async ensureIterationLoaded(pr: PullRequest): Promise<Iteration | undefined> {
        try {
            const iterations = await this.client.getPullRequestIterations(
                pr.repository.id, pr.pullRequestId
            );
            const lastIteration = iterations[iterations.length - 1];
            const changes = await this.client.getPullRequestChanges(
                pr.repository.id, pr.pullRequestId, lastIteration.id
            );
            this.changesCache.set(pr.pullRequestId, { changes, iteration: lastIteration });
            return lastIteration;
        } catch {
            return undefined;
        }
    }

    private async getRepositories(): Promise<PRTreeItem[]> {
        const config = vscode.workspace.getConfiguration('ninjaReviewer');
        const org = config.get<string>('organization', '');
        const project = config.get<string>('project', '');

        if (!org || !project) {
            return [];
        }

        if (this.selectedRepoIds.length === 0) {
            return [new PRTreeItem(
                'No repositories selected. Click ★ above to pick favorites.',
                'message'
            )];
        }

        try {
            if (this.allRepos.length === 0) {
                this.allRepos = await this.client.listRepositories();
            }

            const selectedRepos = this.allRepos.filter(r => this.selectedRepoIds.includes(r.id));

            return selectedRepos.map(repo => {
                const item = new PRTreeItem(
                    repo.name,
                    'repo',
                    vscode.TreeItemCollapsibleState.Expanded
                );
                item.repoId = repo.id;
                item.iconPath = new vscode.ThemeIcon('repo');
                return item;
            });
        } catch (err: any) {
            return [new PRTreeItem(`Error: ${err.message}`, 'message')];
        }
    }

    private async getPullRequests(repoId: string): Promise<PRTreeItem[]> {
        try {
            const pullRequests = await this.client.listPullRequests(repoId);

            if (pullRequests.length === 0) {
                return [new PRTreeItem('No active pull requests', 'message')];
            }

            return pullRequests.map(pr => {
                const item = new PRTreeItem(
                    pr.title,
                    'pr',
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.pr = pr;
                item.description = pr.createdBy.displayName;
                item.tooltip = new vscode.MarkdownString(
                    `**${pr.title}**\n\n` +
                    `${pr.description || 'No description'}\n\n` +
                    `By: ${pr.createdBy.displayName}\n\n` +
                    `\`${pr.sourceRefName.replace('refs/heads/', '')}\` → \`${pr.targetRefName.replace('refs/heads/', '')}\``
                );
                item.command = {
                    command: 'ninjaReviewer.openPR',
                    title: 'Open PR Description',
                    arguments: [pr],
                };
                return item;
            });
        } catch (err: any) {
            return [new PRTreeItem(`Error: ${err.message}`, 'message')];
        }
    }

    private async getChangedFiles(pr: PullRequest, _flat = false): Promise<PRTreeItem[]> {
        try {
            let cached = this.changesCache.get(pr.pullRequestId);

            if (!cached) {
                const iterations = await this.client.getPullRequestIterations(
                    pr.repository.id, pr.pullRequestId
                );
                const lastIteration = iterations[iterations.length - 1];
                const changes = await this.client.getPullRequestChanges(
                    pr.repository.id, pr.pullRequestId, lastIteration.id
                );
                cached = { changes, iteration: lastIteration };
                this.changesCache.set(pr.pullRequestId, cached);
            }

            const { changes, iteration } = cached;

            const filtered = changes.filter(c => c.item.path && c.item.path !== '/');
            if (filtered.length === 0) {
                return [new PRTreeItem('No file changes in this PR', 'message')];
            }

            return filtered.map(change => {
                const fullPath = change.item.path.replace(/^\//, '');
                const fileName = fullPath.split('/').pop() || fullPath;
                const dirName = fullPath.includes('/')
                    ? fullPath.substring(0, fullPath.lastIndexOf('/'))
                    : '';
                const changeLabel = getChangeTypeLabel(change.changeType);

                const item = new PRTreeItem(fileName, 'file');
                // Source-Control-style: dimmed parent dir on the right.
                item.description = dirName || changeLabel;
                item.tooltip = `${changeLabel}: ${fullPath}`;
                item.iconPath = getChangeTypeIcon(change.changeType);
                item.command = {
                    command: 'ninjaReviewer.openDiff',
                    title: 'Open Diff',
                    arguments: [{
                        pr,
                        change,
                        sourceCommitId: iteration.sourceRefCommit.commitId,
                        targetCommitId: iteration.targetRefCommit.commitId,
                    }],
                };
                return item;
            });
        } catch (err: any) {
            return [new PRTreeItem(`Error: ${err.message}`, 'message')];
        }
    }

    async selectFavorites(): Promise<void> {
        try {
            this.allRepos = await this.client.listRepositories();
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to fetch repositories: ${err.message}`);
            return;
        }

        const picks = this.allRepos
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(repo => ({
                label: repo.name,
                description: repo.project.name,
                picked: this.selectedRepoIds.includes(repo.id),
                repoId: repo.id,
            }));

        const selected = await vscode.window.showQuickPick(picks, {
            canPickMany: true,
            placeHolder: 'Select repositories to show pull requests for',
            title: 'Favorite Repositories',
        });

        if (selected === undefined) {
            return;
        }

        this.selectedRepoIds = selected.map(s => s.repoId);
        await this.globalState.update('favoriteRepoIds', this.selectedRepoIds);
        this.refresh();
    }
}

export class PRTreeItem extends vscode.TreeItem {
    type: TreeItemType;
    pr?: PullRequest;
    repoId?: string;
    sectionKind?: SectionKind;

    constructor(
        label: string,
        type: TreeItemType,
        collapsibleState?: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState ?? vscode.TreeItemCollapsibleState.None);
        this.type = type;

        if (type === 'repo') {
            this.contextValue = 'repository';
        } else if (type === 'pr') {
            this.iconPath = new vscode.ThemeIcon('git-pull-request');
            this.contextValue = 'pullRequest';
        } else if (type === 'message') {
            this.contextValue = 'message';
        } else if (type === 'section') {
            this.contextValue = 'section';
        } else if (type === 'comment') {
            this.contextValue = 'comment';
        } else {
            this.contextValue = 'changedFile';
        }
    }
}

function threadStatusIcon(status: number): vscode.ThemeIcon {
    // 1 = active, 2 = fixed, 3 = wontFix, 4 = closed, 5 = byDesign, 6 = pending.
    switch (status) {
        case 2: case 4: case 5:
            return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
        case 3:
            return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.yellow'));
        case 6:
            return new vscode.ThemeIcon('clock', new vscode.ThemeColor('charts.blue'));
        case 1:
        default:
            return new vscode.ThemeIcon('comment', new vscode.ThemeColor('charts.orange'));
    }
}

function getChangeTypeLabel(changeType: number): string {
    if (changeType & 1) { return 'Added'; }
    if (changeType & 16) { return 'Deleted'; }
    if (changeType & 8) { return 'Renamed'; }
    if (changeType & 2) { return 'Modified'; }
    return 'Changed';
}

function getChangeTypeIcon(changeType: number): vscode.ThemeIcon {
    if (changeType & 1) { return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground')); }
    if (changeType & 16) { return new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground')); }
    if (changeType & 8) { return new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground')); }
    return new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
}
