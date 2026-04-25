import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOps';
import { PullRequest, ChangeEntry, Iteration, Repository } from './types';

type TreeItemType = 'repo' | 'pr' | 'file' | 'message';

export class PRTreeProvider implements vscode.TreeDataProvider<PRTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<PRTreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private changesCache = new Map<number, { changes: ChangeEntry[]; iteration: Iteration }>();
    private selectedRepoIds: string[] = [];
    private allRepos: Repository[] = [];

    constructor(
        private client: AzureDevOpsClient,
        private globalState: vscode.Memento
    ) {
        this.selectedRepoIds = globalState.get<string[]>('favoriteRepoIds', []);
    }

    refresh(): void {
        this.changesCache.clear();
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: PRTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PRTreeItem): Promise<PRTreeItem[]> {
        if (!element) {
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
                    `#${pr.pullRequestId}: ${pr.title}`,
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

    private async getChangedFiles(pr: PullRequest): Promise<PRTreeItem[]> {
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

            return changes
                .filter(c => c.item.path && c.item.path !== '/')
                .map(change => {
                    const fileName = change.item.path.split('/').pop() || change.item.path;
                    const changeLabel = getChangeTypeLabel(change.changeType);

                    const item = new PRTreeItem(fileName, 'file');
                    item.description = `${changeLabel} — ${change.item.path}`;
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
        } else {
            this.contextValue = 'changedFile';
        }
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
