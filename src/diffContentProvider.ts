import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOps';

export class DiffContentProvider implements vscode.TextDocumentContentProvider {
    private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this._onDidChange.event;

    private contentCache = new Map<string, string>();

    constructor(private client: AzureDevOpsClient) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const cacheKey = uri.toString();
        if (this.contentCache.has(cacheKey)) {
            return this.contentCache.get(cacheKey)!;
        }

        const params = new URLSearchParams(uri.query);
        const repoId = params.get('repo')!;
        const commitId = params.get('commit')!;
        const filePath = uri.path;

        try {
            const content = await this.client.getFileContent(repoId, filePath, commitId);
            this.contentCache.set(cacheKey, content);
            return content;
        } catch {
            return '';
        }
    }

    clearCache(): void {
        this.contentCache.clear();
    }
}
