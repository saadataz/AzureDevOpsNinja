import * as vscode from 'vscode';
import { PullRequest, ChangeEntry, Iteration, Repository, CommentThread, CodeSearchResult } from './types';

export class AzureDevOpsClient {
    private _token: string | undefined;

    async getToken(): Promise<string> {
        const session = await vscode.authentication.getSession('microsoft', [
            '499b84ac-1321-427f-aa17-267ca6975798/user_impersonation'
        ], { createIfNone: true });

        this._token = session.accessToken;
        return this._token;
    }

    async signIn(): Promise<void> {
        await this.getToken();
        vscode.window.showInformationMessage('Ninja Reviewer: Signed in successfully!');
    }

    getOrgUrl(): string {
        const config = vscode.workspace.getConfiguration('ninjaReviewer');
        let org = config.get<string>('organization', '');

        if (org.startsWith('https://')) {
            return org.replace(/\/$/, '');
        }
        if (org.includes('.visualstudio.com')) {
            return `https://${org}`;
        }
        return `https://dev.azure.com/${org}`;
    }

    getProject(): string {
        return vscode.workspace.getConfiguration('ninjaReviewer').get<string>('project', '');
    }

    private async apiFetch<T>(url: string): Promise<T> {
        const token = await this.getToken();
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Azure DevOps API error (${response.status}): ${text}`);
        }

        return response.json() as Promise<T>;
    }

    private async apiPost<T>(url: string, body: unknown): Promise<T> {
        const token = await this.getToken();
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Azure DevOps API error (${response.status}): ${text}`);
        }

        return response.json() as Promise<T>;
    }

    async listRepositories(): Promise<Repository[]> {
        const project = this.getProject();
        const data = await this.apiFetch<{ value: Repository[] }>(
            `${this.getOrgUrl()}/${project}/_apis/git/repositories?api-version=7.1`
        );
        return data.value;
    }

    async getFavoriteRepositoryIds(): Promise<string[]> {
        const project = this.getProject();
        const data = await this.apiFetch<{ value: Array<{ artifactId: string; artifactType: string }> }>(
            `${this.getOrgUrl()}/${project}/_apis/favorites?type=Microsoft.TeamFoundation.Git.Repository&scope=Project&api-version=7.1-preview.1`
        );
        return data.value.map(f => f.artifactId);
    }

    async listPullRequests(repositoryId?: string): Promise<PullRequest[]> {
        const project = this.getProject();
        let url: string;
        if (repositoryId) {
            url = `${this.getOrgUrl()}/${project}/_apis/git/repositories/${repositoryId}/pullrequests?searchCriteria.status=active&api-version=7.1`;
        } else {
            url = `${this.getOrgUrl()}/${project}/_apis/git/pullrequests?searchCriteria.status=active&api-version=7.1`;
        }
        const data = await this.apiFetch<{ value: PullRequest[] }>(url);
        return data.value;
    }

    async listPullRequestsForFavorites(): Promise<PullRequest[]> {
        const favoriteRepoIds = await this.getFavoriteRepositoryIds();
        if (favoriteRepoIds.length === 0) {
            return [];
        }
        const results = await Promise.all(
            favoriteRepoIds.map(repoId => this.listPullRequests(repoId))
        );
        return results.flat();
    }

    async getPullRequestIterations(repoId: string, prId: number): Promise<Iteration[]> {
        const project = this.getProject();
        const data = await this.apiFetch<{ value: Iteration[] }>(
            `${this.getOrgUrl()}/${project}/_apis/git/repositories/${repoId}/pullrequests/${prId}/iterations?api-version=7.1`
        );
        return data.value;
    }

    async getPullRequestChanges(repoId: string, prId: number, iterationId: number): Promise<ChangeEntry[]> {
        const project = this.getProject();
        const data = await this.apiFetch<{ changeEntries: ChangeEntry[] }>(
            `${this.getOrgUrl()}/${project}/_apis/git/repositories/${repoId}/pullrequests/${prId}/iterations/${iterationId}/changes?api-version=7.1`
        );
        return data.changeEntries;
    }

    async getFileContent(
        repoId: string,
        path: string,
        version: string,
        versionType: 'commit' | 'branch' = 'commit'
    ): Promise<string> {
        const project = this.getProject();
        const token = await this.getToken();

        const url = `${this.getOrgUrl()}/${project}/_apis/git/repositories/${repoId}/items?path=${encodeURIComponent(path)}&versionDescriptor[version]=${encodeURIComponent(version)}&versionDescriptor[versionType]=${versionType}&api-version=7.1`;

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`,
            },
        });

        if (!response.ok) {
            if (response.status === 404) {
                return '';
            }
            throw new Error(`Failed to get file content: ${response.status}`);
        }

        return response.text();
    }

    /**
     * Search for code across one or more repositories using the ADO almsearch API.
     * Requires the "Code Search" extension to be enabled on the organization.
     */
    async searchCode(
        searchText: string,
        opts: {
            repositoryName?: string;
            branch?: string;
            path?: string;
            extensions?: string[];
            codeElements?: string[]; // e.g. ['def', 'ref']
            top?: number;
        } = {}
    ): Promise<CodeSearchResult[]> {
        const project = this.getProject();
        const org = this.getOrgUrl()
            .replace('https://dev.azure.com', 'https://almsearch.dev.azure.com')
            .replace('.visualstudio.com', '.almsearch.visualstudio.com');
        const token = await this.getToken();

        const filters: Record<string, string[]> = { Project: [project] };
        if (opts.repositoryName) { filters.Repository = [opts.repositoryName]; }
        if (opts.branch) { filters.Branch = [opts.branch]; }
        if (opts.path) { filters.Path = [opts.path]; }
        if (opts.extensions && opts.extensions.length > 0) {
            filters.CodeElement = filters.CodeElement || [];
            // ADO uses "ext" inside the search text; here we keep filters minimal.
        }
        if (opts.codeElements && opts.codeElements.length > 0) {
            filters.CodeElement = opts.codeElements;
        }

        const url = `${org}/${project}/_apis/search/codesearchresults?api-version=7.1-preview.1`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                searchText,
                $top: opts.top ?? 50,
                $skip: 0,
                filters,
                includeFacets: false,
            }),
        });

        if (!response.ok) {
            // Code Search extension may not be installed; degrade gracefully.
            return [];
        }

        const data = await response.json() as { results?: CodeSearchResult[] };
        return data.results ?? [];
    }

    async getThreads(repoId: string, prId: number): Promise<CommentThread[]> {
        const project = this.getProject();
        const data = await this.apiFetch<{ value: CommentThread[] }>(
            `${this.getOrgUrl()}/${project}/_apis/git/repositories/${repoId}/pullrequests/${prId}/threads?api-version=7.1`
        );
        return data.value;
    }

    async createThread(
        repoId: string,
        prId: number,
        filePath: string,
        line: number,
        content: string
    ): Promise<CommentThread> {
        const project = this.getProject();
        return this.apiPost<CommentThread>(
            `${this.getOrgUrl()}/${project}/_apis/git/repositories/${repoId}/pullrequests/${prId}/threads?api-version=7.1`,
            {
                comments: [{ parentCommentId: 0, content, commentType: 1 }],
                threadContext: {
                    filePath,
                    rightFileStart: { line, offset: 1 },
                    rightFileEnd: { line, offset: 1 },
                },
                status: 1, // active
            }
        );
    }

    async replyToThread(
        repoId: string,
        prId: number,
        threadId: number,
        content: string
    ): Promise<void> {
        const project = this.getProject();
        await this.apiPost(
            `${this.getOrgUrl()}/${project}/_apis/git/repositories/${repoId}/pullrequests/${prId}/threads/${threadId}/comments?api-version=7.1`,
            { parentCommentId: 0, content, commentType: 1 }
        );
    }

    private cachedUserId: string | undefined;

    async getCurrentUserId(): Promise<string> {
        if (this.cachedUserId) { return this.cachedUserId; }
        const data = await this.apiFetch<{ authenticatedUser: { id: string } }>(
            `${this.getOrgUrl()}/_apis/connectionData`
        );
        this.cachedUserId = data.authenticatedUser.id;
        return this.cachedUserId;
    }

    async submitVote(repoId: string, prId: number, vote: number): Promise<void> {
        const project = this.getProject();
        const userId = await this.getCurrentUserId();
        const token = await this.getToken();
        const url = `${this.getOrgUrl()}/${project}/_apis/git/repositories/${repoId}/pullrequests/${prId}/reviewers/${userId}?api-version=7.1`;
        const response = await fetch(url, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ vote }),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to submit vote: ${response.status} ${text}`);
        }
    }
}
