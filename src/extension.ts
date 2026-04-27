import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOps';
import { PRTreeProvider } from './prTreeProvider';
import { DiffContentProvider } from './diffContentProvider';
import { HoverExplainerProvider } from './hoverExplainer';
import { PRCommentController } from './commentController';
import { PullRequest, ChangeEntry } from './types';
import { marked } from 'marked';

export function activate(context: vscode.ExtensionContext) {
    const client = new AzureDevOpsClient();
    const treeProvider = new PRTreeProvider(client, context.globalState);
    const diffProvider = new DiffContentProvider(client);
    const hoverProvider = new HoverExplainerProvider(client);
    const commentController = new PRCommentController(client);

    context.subscriptions.push({ dispose: () => commentController.dispose() });

    // Register content provider for virtual documents (PR file diffs)
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('ninja-reviewer', diffProvider)
    );

    // Register tree view in the sidebar
    context.subscriptions.push(
        vscode.window.createTreeView('ninjaReviewer.prList', {
            treeDataProvider: treeProvider,
            showCollapseAll: true,
        })
    );

    // Register hover provider — only activates on our custom scheme
    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ scheme: 'ninja-reviewer' }, hoverProvider)
    );

    // --- Commands ---

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.signIn', async () => {
            await client.signIn();
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.refresh', async () => {
            diffProvider.clearCache();
            hoverProvider.clearCache();
            treeProvider.refresh();
            await commentController.refreshAllComments();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.selectFavorites', () => {
            treeProvider.selectFavorites();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.configure', async () => {
            const config = vscode.workspace.getConfiguration('ninjaReviewer');

            const org = await vscode.window.showInputBox({
                prompt: 'Enter your Azure DevOps organization name',
                placeHolder: 'e.g., myorg or https://dev.azure.com/myorg',
                value: config.get<string>('organization', ''),
            });
            if (org === undefined) { return; }

            const project = await vscode.window.showInputBox({
                prompt: 'Enter your Azure DevOps project name',
                placeHolder: 'e.g., MyProject',
                value: config.get<string>('project', ''),
            });
            if (project === undefined) { return; }

            await config.update('organization', org, vscode.ConfigurationTarget.Global);
            await config.update('project', project, vscode.ConfigurationTarget.Global);

            vscode.window.showInformationMessage(`Ninja Reviewer configured for ${org}/${project}`);
            treeProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.openDiff', async (args: {
            pr: PullRequest;
            change: ChangeEntry;
            sourceCommitId: string;
            targetCommitId: string;
        }) => {
            const { pr, change, sourceCommitId, targetCommitId } = args;
            const filePath = change.item.path;
            const repoId = pr.repository.id;
            const repoName = pr.repository.name;
            const sourceBranch = pr.sourceRefName.replace('refs/heads/', '');
            const changeType = getChangeTypeString(change.changeType);

            // URIs for base (target branch) and head (source branch) versions
            const baseUri = vscode.Uri.parse(
                `ninja-reviewer:${filePath}?repo=${repoId}&commit=${targetCommitId}`
            );
            const headUri = vscode.Uri.parse(
                `ninja-reviewer:${filePath}?repo=${repoId}&commit=${sourceCommitId}`
            );

            // Store context so the hover provider knows which PR/file this is
            const diffContext = {
                prId: pr.pullRequestId,
                prTitle: pr.title,
                filePath,
                changeType,
                repoId,
                repoName,
                sourceBranch,
                sourceCommitId,
                targetCommitId,
            };
            hoverProvider.registerDiffContext(baseUri.toString(), diffContext);
            hoverProvider.registerDiffContext(headUri.toString(), diffContext);
            commentController.registerDiffContext(baseUri.toString(), diffContext);
            commentController.registerDiffContext(headUri.toString(), diffContext);

            const fileName = filePath.split('/').pop();
            const title = `${fileName} (PR #${pr.pullRequestId}: ${changeType})`;

            if (changeType === 'Added') {
                await vscode.window.showTextDocument(headUri);
            } else if (changeType === 'Deleted') {
                await vscode.window.showTextDocument(baseUri);
            } else {
                await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, title);
            }

            // Load existing PR comments into the diff
            await commentController.loadComments(baseUri, headUri, diffContext);
        })
    );

    // Handle replies to comment threads (both new and existing)
    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.replyComment', async (reply: vscode.CommentReply) => {
            await commentController.handleReply(reply);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.refreshComments', async () => {
            await commentController.refreshAllComments();
        })
    );

    // Open an arbitrary file from ADO at a given branch/line, without cloning.
    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.openFileFromAdo', async (args: {
            repoId: string;
            path: string;
            branch?: string;
            line?: number;
            column?: number;
        }) => {
            if (!args || !args.repoId || !args.path) {
                return;
            }
            const branch = args.branch || 'main';
            const uri = vscode.Uri.parse(
                `ninja-reviewer:${args.path}?repo=${encodeURIComponent(args.repoId)}&branch=${encodeURIComponent(branch)}`
            );

            // Build a selection so showTextDocument scrolls to the right place
            // immediately, instead of opening at line 1 and then scrolling.
            let selection: vscode.Range | undefined;
            if (typeof args.line === 'number' && args.line > 0) {
                const lineIdx = args.line - 1;
                const colIdx = typeof args.column === 'number' && args.column > 0 ? args.column - 1 : 0;
                const pos = new vscode.Position(lineIdx, colIdx);
                selection = new vscode.Range(pos, pos);
            }

            const editor = await vscode.window.showTextDocument(uri, {
                preview: true,
                selection,
            });

            if (selection) {
                // Clamp to actual line count once the document is loaded, then
                // re-reveal in case the editor opened before content was ready.
                const safeLine = Math.min(selection.start.line, Math.max(0, editor.document.lineCount - 1));
                const lineRange = editor.document.lineAt(safeLine).range;
                editor.selection = new vscode.Selection(lineRange.start, lineRange.start);
                editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.openPR', (pr: PullRequest) => {
            const orgUrl = client.getOrgUrl();
            const project = client.getProject();
            const repoName = pr.repository.name;
            const adoUrl = `${orgUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`;

            const panel = vscode.window.createWebviewPanel(
                'ninjaReviewer.prDescription',
                `PR #${pr.pullRequestId}`,
                vscode.ViewColumn.One,
                { enableScripts: true }
            );

            panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.type === 'vote') {
                    try {
                        await client.submitVote(pr.repository.id, pr.pullRequestId, msg.vote);
                        const labels: Record<number, string> = {
                            10: 'Approved', 5: 'Approved with suggestions',
                            0: 'Vote reset', [-5]: 'Waiting for author', [-10]: 'Rejected'
                        };
                        vscode.window.showInformationMessage(`PR #${pr.pullRequestId}: ${labels[msg.vote] ?? 'Vote submitted'}`);
                        panel.webview.postMessage({ type: 'voteSuccess', vote: msg.vote });
                    } catch (err: any) {
                        vscode.window.showErrorMessage(`Vote failed: ${err.message}`);
                    }
                }
            });

            const sourceBranch = pr.sourceRefName.replace('refs/heads/', '');
            const targetBranch = pr.targetRefName.replace('refs/heads/', '');
            const createdDate = new Date(pr.creationDate).toLocaleDateString(undefined, {
                year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
            });
            const description = pr.description
                ? marked.parse(pr.description)
                : '<em>No description provided.</em>';

            panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); line-height: 1.6; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 16px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; font-weight: 500; }
  .branch { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-family: var(--vscode-editor-font-family, monospace); }
  .arrow { margin: 0 6px; }
  .description { margin: 16px 0; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .description h1, .description h2, .description h3 { margin-top: 12px; margin-bottom: 4px; }
  .description p { margin: 6px 0; }
  .description ul, .description ol { padding-left: 24px; }
  .description code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
  .description pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow-x: auto; }
  .description pre code { padding: 0; background: none; }
  .description blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border); margin: 8px 0; padding: 4px 12px; color: var(--vscode-descriptionForeground); }
  .description table { border-collapse: collapse; margin: 8px 0; }
  .description th, .description td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .description img { max-width: 100%; }
  a { color: var(--vscode-textLink-foreground); }
  a:hover { color: var(--vscode-textLink-activeForeground); }
  .open-link { display: inline-block; margin-top: 16px; padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); text-decoration: none; border-radius: 4px; }
  .open-link:hover { background: var(--vscode-button-hoverBackground); }
  .vote-section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--vscode-panel-border); }
  .vote-section h2 { font-size: 1.1em; margin-bottom: 10px; }
  .vote-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
  .vote-btn { padding: 6px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-size: 0.9em; }
  .vote-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .vote-btn.approve { background: #2ea043; color: #fff; border-color: #2ea043; }
  .vote-btn.approve:hover { background: #238636; }
  .vote-btn.approve-suggestions { background: #1a7f37; color: #fff; border-color: #1a7f37; }
  .vote-btn.approve-suggestions:hover { background: #166b2d; }
  .vote-btn.wait { background: #d29922; color: #fff; border-color: #d29922; }
  .vote-btn.wait:hover { background: #bb8009; }
  .vote-btn.reject { background: #da3633; color: #fff; border-color: #da3633; }
  .vote-btn.reject:hover { background: #c62828; }
  .vote-btn.reset { background: var(--vscode-button-secondaryBackground); }
  .vote-btn.active { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .vote-status { margin-top: 8px; font-size: 0.9em; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <h1>${escapeHtml(pr.title)}</h1>
  <div class="meta">
    <strong>${escapeHtml(pr.createdBy.displayName)}</strong> &middot; ${createdDate}<br>
    <span class="badge branch">${escapeHtml(sourceBranch)}</span>
    <span class="arrow">\u2192</span>
    <span class="badge branch">${escapeHtml(targetBranch)}</span>
    &middot; ${escapeHtml(repoName)}
  </div>
  <div class="description">${description}</div>

  <div class="vote-section">
    <h2>Vote</h2>
    <div class="vote-buttons">
      <button class="vote-btn approve" onclick="submitVote(10)">✅ Approve</button>
      <button class="vote-btn approve-suggestions" onclick="submitVote(5)">👍 Approve with Suggestions</button>
      <button class="vote-btn wait" onclick="submitVote(-5)">⏳ Wait for Author</button>
      <button class="vote-btn reject" onclick="submitVote(-10)">❌ Reject</button>
      <button class="vote-btn reset" onclick="submitVote(0)">↩ Reset Vote</button>
    </div>
    <div class="vote-status" id="voteStatus"></div>
  </div>

  <a class="open-link" href="${adoUrl}">Open in Azure DevOps \u2197</a>

  <script>
    const vscode = acquireVsCodeApi();
    function submitVote(vote) {
      document.querySelectorAll('.vote-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('voteStatus').textContent = 'Submitting...';
      vscode.postMessage({ type: 'vote', vote });
    }
    window.addEventListener('message', e => {
      if (e.data.type === 'voteSuccess') {
        const labels = { 10: '✅ Approved', 5: '👍 Approved with Suggestions', 0: '↩ Vote Reset', '-5': '⏳ Waiting for Author', '-10': '❌ Rejected' };
        document.getElementById('voteStatus').textContent = labels[e.data.vote] || 'Vote submitted';
      }
    });
  </script>
</body>
</html>`;
        })
    );
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getChangeTypeString(changeType: number): string {
    if (changeType & 1) { return 'Added'; }
    if (changeType & 16) { return 'Deleted'; }
    if (changeType & 8) { return 'Renamed'; }
    if (changeType & 2) { return 'Modified'; }
    return 'Changed';
}

export function deactivate() {}
