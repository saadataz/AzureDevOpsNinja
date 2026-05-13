import * as vscode from 'vscode';
import * as path from 'path';
import { AzureDevOpsClient } from './azureDevOps';
import { PRTreeProvider, AssignedPRTreeProvider } from './prTreeProvider';
import { DiffContentProvider } from './diffContentProvider';
import { HoverExplainerProvider } from './hoverExplainer';
import { PRCommentController } from './commentController';
import { PullRequest, ChangeEntry } from './types';
import { cloneAndReviewPR, consumePendingReviewIfMatch, showDiffForCurrentWorkspace } from './cloneAndReview';
import { generateWalkthrough, WalkthroughResult } from './walkthrough';
import { marked } from 'marked';

export function activate(context: vscode.ExtensionContext) {
    const client = new AzureDevOpsClient();
    const treeProvider = new PRTreeProvider(client, context.globalState);
    const assignedProvider = new AssignedPRTreeProvider(client);
    const diffProvider = new DiffContentProvider(client);
    const hoverProvider = new HoverExplainerProvider(client);
    const commentController = new PRCommentController(client);

    context.subscriptions.push({ dispose: () => commentController.dispose() });

    // If this window was opened by a previous "Clone & Review" action,
    // show the PR diff automatically.
    void consumePendingReviewIfMatch(context.globalState, treeProvider);

    // Register content provider for virtual documents (PR file diffs)
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('ninja-reviewer', diffProvider)
    );

    // Register tree view in the sidebar
    const treeView = vscode.window.createTreeView('ninjaReviewer.prList', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    treeProvider.attachTreeView(treeView);
    context.subscriptions.push(treeView);

    // Separate "Assigned to Me" accordion in the same activity-bar container.
    const assignedView = vscode.window.createTreeView('ninjaReviewer.assignedToMe', {
        treeDataProvider: assignedProvider,
    });
    context.subscriptions.push(assignedView);

    // Start in the unfocused (PR list) state.
    vscode.commands.executeCommand('setContext', 'ninjaReviewer.prFocused', false);

    // Back-to-list command (shown as an arrow in the view title when focused).
    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.backToList', () => {
            treeProvider.clearFocus();
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
            assignedProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.refresh', async () => {
            diffProvider.clearCache();
            hoverProvider.clearCache();
            treeProvider.refresh();
            assignedProvider.refresh();
            await commentController.refreshAllComments();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.refreshAssigned', () => {
            assignedProvider.refresh();
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
            assignedProvider.refresh();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.openDiff', async (args: {
            pr: PullRequest;
            change: ChangeEntry;
            sourceCommitId: string;
            targetCommitId: string;
            goto?: { line: number; side?: 'left' | 'right' };
        }) => {
            const { pr, change, sourceCommitId, targetCommitId, goto } = args;
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

            // Optional: jump the cursor to a specific line (used when opening
            // from a comment in the sidebar).
            if (goto && goto.line > 0) {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const lineIdx = Math.max(0, Math.min(goto.line - 1, editor.document.lineCount - 1));
                    const range = editor.document.lineAt(lineIdx).range;
                    editor.selection = new vscode.Selection(range.start, range.start);
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                }
                // Expand the matching comment thread so the user sees it inline.
                commentController.revealThread(diffContext, goto.line, goto.side ?? 'right');
            }
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

    // Toggle inline / side-by-side layout for the current diff editor.
    // Wraps VS Code's built-in workspace setting so users can flip it from
    // the diff editor's title bar without diving into Settings.
    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.toggleDiffLayout', async () => {
            const cfg = vscode.workspace.getConfiguration('diffEditor');
            const current = cfg.get<boolean>('renderSideBySide', true);
            await cfg.update(
                'renderSideBySide',
                !current,
                vscode.ConfigurationTarget.Global
            );
            vscode.window.setStatusBarMessage(
                `Diff layout: ${!current ? 'Side-by-side' : 'Inline'}`,
                2000
            );
        })
    );

    // Used by comment items in the sidebar when running in a Clone & Review
    // workspace: open the local diff (git: scheme) for the comment's file
    // and jump to the comment's line.
    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.openLocalCommentTarget', async (args: {
            filePath: string; line: number;
        }) => {
            const folders = vscode.workspace.workspaceFolders ?? [];
            if (folders.length === 0) {
                vscode.window.showWarningMessage('Ninja Reviewer: no folder is open.');
                return;
            }

            const lineIdx = Math.max(0, (args.line || 1) - 1);

            // Reuse the diff command already built for the matching file in
            // the Files section so we get the right git: URIs.
            const fileCmd = treeProvider.findLocalFileCommand(args.filePath);
            if (fileCmd && fileCmd.command && fileCmd.arguments) {
                await vscode.commands.executeCommand(fileCmd.command, ...fileCmd.arguments);
            } else {
                // Fallback: open the working-copy file.
                const root = folders[0].uri.fsPath;
                const rel = args.filePath.replace(/^\//, '');
                const fullPath = path.join(root, rel);
                await vscode.window.showTextDocument(vscode.Uri.file(fullPath), { preview: false });
            }

            // Move the cursor in whichever editor is now active and reveal it.
            const editor = vscode.window.activeTextEditor;
            if (editor) {
                const safeLine = Math.min(lineIdx, Math.max(0, editor.document.lineCount - 1));
                const range = editor.document.lineAt(safeLine).range;
                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
            }
        })
    );

    // Open a diff between two git: URIs (Clone & Review window) AND load
    // any PR comment threads from ADO so they appear inline.
    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.openLocalDiff', async (args: {
            originalUri: vscode.Uri;
            modifiedUri: vscode.Uri;
            title: string;
            repoId: string;
            prId: number;
            filePath: string;
        }) => {
            // VS Code may serialize URIs as plain objects when passed through
            // commands. Re-parse defensively.
            const baseUri = args.originalUri instanceof vscode.Uri
                ? args.originalUri
                : vscode.Uri.from(args.originalUri as any);
            const headUri = args.modifiedUri instanceof vscode.Uri
                ? args.modifiedUri
                : vscode.Uri.from(args.modifiedUri as any);

            await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, args.title);

            const sourceBranch = '';
            const ctx = {
                prId: args.prId,
                prTitle: '',
                filePath: args.filePath,
                changeType: 'Modified',
                repoId: args.repoId,
                repoName: '',
                sourceBranch,
                sourceCommitId: '',
                targetCommitId: '',
            };
            commentController.registerDiffContext(baseUri.toString(), ctx);
            commentController.registerDiffContext(headUri.toString(), ctx);
            await commentController.loadComments(baseUri, headUri, ctx);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.cloneAndReview', async (arg: PullRequest | { pr: PullRequest }) => {
            const pr: PullRequest | undefined =
                (arg as any)?.pullRequestId !== undefined
                    ? (arg as PullRequest)
                    : (arg as { pr: PullRequest })?.pr;
            if (!pr) {
                vscode.window.showErrorMessage('Ninja Reviewer: no pull request selected.');
                return;
            }

            // The PR endpoint returns a trimmed repository object without
            // remoteUrl. Resolve it: PR -> full repo lookup -> constructed URL.
            let remoteUrl = (pr.repository as { remoteUrl?: string }).remoteUrl;
            if (!remoteUrl) {
                try {
                    const fullRepo = await client.getRepository(pr.repository.id);
                    remoteUrl = fullRepo.remoteUrl;
                } catch {
                    // Ignore — fall through to constructed URL.
                }
            }
            if (!remoteUrl) {
                const org = client.getOrgUrl();
                const project = encodeURIComponent(client.getProject());
                const repo = encodeURIComponent(pr.repository.name);
                remoteUrl = `${org}/${project}/_git/${repo}`;
            }

            await cloneAndReviewPR(pr, context, remoteUrl, treeProvider);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.showDiffForCurrentWorkspace', async () => {
            await showDiffForCurrentWorkspace(treeProvider);
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
        vscode.commands.registerCommand('ninjaReviewer.openPR', async (prArg: PullRequest) => {
            // The PR row in the sidebar is already expandable to show its
            // changed files inline, so we don't reshape the tree here — just
            // open the PR description webview.

            // The PR objects from the list endpoints carry a TRUNCATED
            // description (~400 chars). Fetch the full PR by id so the
            // webview shows the complete body.
            let pr = prArg;
            try {
                pr = await client.getPullRequest(prArg.repository.id, prArg.pullRequestId);
            } catch {
                // Fall back to the list-supplied object if the detail fetch fails.
            }

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
                } else if (msg.type === 'cloneAndReview') {
                    await vscode.commands.executeCommand('ninjaReviewer.cloneAndReview', pr);
                } else if (msg.type === 'generateWalkthrough') {
                    await vscode.commands.executeCommand('ninjaReviewer.generateWalkthrough', pr);
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
  body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); line-height: 1.6; overflow-wrap: anywhere; word-break: break-word; }
  h1 { font-size: 1.4em; margin-bottom: 4px; overflow-wrap: anywhere; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 16px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; font-weight: 500; }
  .branch { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-family: var(--vscode-editor-font-family, monospace); }
  .arrow { margin: 0 6px; }
  .description { margin: 16px 0; padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; overflow-wrap: anywhere; }
  .description h1, .description h2, .description h3 { margin-top: 12px; margin-bottom: 4px; }
  .description p { margin: 6px 0; }
  .description ul, .description ol { padding-left: 24px; }
  .description code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
  .description pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow-x: auto; white-space: pre; word-break: normal; overflow-wrap: normal; }
  .description pre code { padding: 0; background: none; white-space: pre; }
  .description blockquote { border-left: 3px solid var(--vscode-textBlockQuote-border); margin: 8px 0; padding: 4px 12px; color: var(--vscode-descriptionForeground); }
  .description table { border-collapse: collapse; margin: 8px 0; }
  .description th, .description td { border: 1px solid var(--vscode-panel-border); padding: 4px 8px; }
  .description img { max-width: 100%; }
  a { color: var(--vscode-textLink-foreground); }
  a:hover { color: var(--vscode-textLink-activeForeground); }

  /* Two-column layout: description on the left, vote column on the right.
     Collapses to a single column on narrow panels. */
  .layout { display: flex; gap: 20px; align-items: flex-start; }
  .main-col { flex: 1 1 auto; min-width: 0; }
  .side-col { flex: 0 0 220px; position: sticky; top: 20px; }
  @media (max-width: 720px) {
    .layout { flex-direction: column; }
    .side-col { position: static; flex-basis: auto; width: 100%; }
  }

  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .open-link { display: inline-block; padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); text-decoration: none; border-radius: 4px; border: none; cursor: pointer; font-size: 0.9em; font-family: inherit; }
  .open-link:hover { background: var(--vscode-button-hoverBackground); }

  .vote-section { padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .vote-section h2 { font-size: 1.1em; margin: 0 0 10px 0; }
  .vote-buttons { display: flex; flex-direction: column; gap: 8px; }
  .vote-btn { padding: 6px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-size: 0.9em; text-align: left; width: 100%; }
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

  <div class="layout">
    <div class="main-col">
      <div class="actions">
        <a class="open-link" href="${adoUrl}">Open in Azure DevOps \u2197</a>
        <button class="open-link" onclick="cloneAndReview()">🥷 Clone &amp; Review Locally</button>
        <button class="open-link" onclick="generateWalkthrough()">🤖 Generate AI Walkthrough</button>
      </div>
      <div class="description">${description}</div>
    </div>

    <div class="side-col">
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
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function submitVote(vote) {
      document.querySelectorAll('.vote-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById('voteStatus').textContent = 'Submitting...';
      vscode.postMessage({ type: 'vote', vote });
    }
    function cloneAndReview() {
      vscode.postMessage({ type: 'cloneAndReview' });
    }
    function generateWalkthrough() {
      vscode.postMessage({ type: 'generateWalkthrough' });
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

    // Generate an AI walkthrough of the PR's code changes and show it in a
    // new webview, with clickable file rows that open the existing diff view.
    context.subscriptions.push(
        vscode.commands.registerCommand('ninjaReviewer.generateWalkthrough', async (pr: PullRequest) => {
            if (!pr) {
                vscode.window.showErrorMessage('Ninja Reviewer: no pull request selected.');
                return;
            }

            let result: WalkthroughResult;
            try {
                result = await vscode.window.withProgress(
                    {
                        location: vscode.ProgressLocation.Notification,
                        title: `Generating walkthrough for PR #${pr.pullRequestId}…`,
                        cancellable: true,
                    },
                    (progress, token) => generateWalkthrough(client, pr, token, progress),
                );
            } catch (err: any) {
                if (err instanceof vscode.CancellationError) { return; }
                vscode.window.showErrorMessage(`Walkthrough failed: ${err?.message ?? err}`);
                return;
            }

            const walkPanel = vscode.window.createWebviewPanel(
                'ninjaReviewer.prWalkthrough',
                `Walkthrough: PR #${pr.pullRequestId}`,
                vscode.ViewColumn.One,
                { enableScripts: true },
            );

            walkPanel.webview.onDidReceiveMessage(async (msg) => {
                if (msg?.type === 'openFile' && typeof msg.path === 'string') {
                    const change = result.files.find(f => f.path === msg.path)?.change;
                    if (!change) {
                        vscode.window.showWarningMessage(
                            `Ninja Reviewer: file "${msg.path}" was not part of the indexed changes.`
                        );
                        return;
                    }
                    await vscode.commands.executeCommand('ninjaReviewer.openDiff', {
                        pr,
                        change,
                        sourceCommitId: result.iteration.sourceRefCommit.commitId,
                        targetCommitId: result.iteration.targetRefCommit.commitId,
                    });
                }
            });

            walkPanel.webview.html = renderWalkthroughHtml(pr, result);
        })
    );
}

/** Build the HTML for the walkthrough webview. */
function renderWalkthroughHtml(pr: PullRequest, result: WalkthroughResult): string {
    const summaryHtml = marked.parse(result.summary || '_No summary returned._');
    const fileToChange = new Map(result.files.map(f => [f.path, f]));

    const renderFileChip = (filePath: string): string => {
        const known = fileToChange.has(filePath);
        const display = filePath.replace(/^\//, '');
        const safe = escapeHtml(filePath);
        const label = escapeHtml(display);
        if (!known) {
            return `<span class="file-chip unknown" title="Not in PR change set">${label}</span>`;
        }
        return `<button class="file-chip" data-path="${safe}" onclick="openFile(this.dataset.path)">${label}</button>`;
    };

    const keyChangesHtml = result.keyChanges.length === 0
        ? '<p><em>The model did not return any grouped changes.</em></p>'
        : result.keyChanges.map((kc, idx) => {
            const descHtml = marked.parse(kc.description || '');
            const fileList = kc.files.length === 0
                ? ''
                : `<div class="file-row">${kc.files.map(renderFileChip).join('')}</div>`;
            return `
              <section class="key-change">
                <h3>${idx + 1}. ${escapeHtml(kc.title)}</h3>
                <div class="kc-desc">${descHtml}</div>
                ${fileList}
              </section>
            `;
        }).join('\n');

    // List of all files that were considered, in case the user wants to
    // jump to one the AI did not surface explicitly.
    const allFilesHtml = result.files.map(f => {
        const display = f.path.replace(/^\//, '');
        const status = changeTypeString(f.changeType);
        const reason = f.skippedReason ? ` <span class="skipped">(${escapeHtml(f.skippedReason)})</span>` : '';
        return `
          <li>
            <button class="file-chip" data-path="${escapeHtml(f.path)}" onclick="openFile(this.dataset.path)">${escapeHtml(display)}</button>
            <span class="status">${status}</span>${reason}
          </li>
        `;
    }).join('');

    const truncatedNote = result.truncated
        ? '<p class="note">Note: only a subset of files was sent to the model to fit its context window.</p>'
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); line-height: 1.6; overflow-wrap: anywhere; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-bottom: 16px; }
  h2 { font-size: 1.15em; margin-top: 24px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .summary { padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-textBlockQuote-background); }
  .key-change { padding: 12px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin: 12px 0; }
  .key-change h3 { margin: 0 0 6px 0; font-size: 1.05em; }
  .kc-desc p { margin: 6px 0; }
  .file-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .file-chip { display: inline-flex; align-items: center; padding: 3px 8px; border-radius: 12px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; cursor: pointer; }
  .file-chip:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .file-chip.unknown { cursor: default; opacity: 0.7; }
  ul.files { list-style: none; padding: 0; margin: 8px 0; }
  ul.files li { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
  .status { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .skipped { color: var(--vscode-errorForeground); font-size: 0.8em; }
  .note { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.9em; }
  code { font-family: var(--vscode-editor-font-family, monospace); background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
  <h1>Walkthrough — PR #${pr.pullRequestId}</h1>
  <div class="meta">
    ${escapeHtml(pr.title)} · generated by <code>${escapeHtml(result.modelLabel)}</code>
  </div>
  ${truncatedNote}

  <h2>Summary</h2>
  <div class="summary">${summaryHtml}</div>

  <h2>Key Changes</h2>
  ${keyChangesHtml}

  <h2>All Changed Files (${result.files.length})</h2>
  <ul class="files">${allFilesHtml}</ul>

  <script>
    const vscode = acquireVsCodeApi();
    function openFile(path) {
      vscode.postMessage({ type: 'openFile', path });
    }
  </script>
</body>
</html>`;
}

function changeTypeString(changeType: number): string {
    if (changeType & 1 && !(changeType & 2)) { return 'Added'; }
    if (changeType & 16) { return 'Deleted'; }
    if (changeType & 8) { return 'Renamed'; }
    if (changeType & 2) { return 'Modified'; }
    return 'Changed';
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
