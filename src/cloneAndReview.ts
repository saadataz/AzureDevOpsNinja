import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { PullRequest } from './types';
import { PRTreeProvider, PRTreeItem } from './prTreeProvider';

const execFileAsync = promisify(execFile);

const PENDING_REVIEW_KEY = 'ninjaReviewer.pendingReview';
const LOCAL_CLONES_KEY = 'localClones';

export interface PendingReview {
    /** fsPath of the worktree (or fresh clone) we just opened. */
    folderPath: string;
    prId: number;
    prTitle: string;
    repoId: string;
    repoName: string;
    sourceBranch: string;
    targetBranch: string;
    sourceCommitId: string;
    targetCommitId: string;
    /** When true, folderPath is a worktree we created and may want to clean up later. */
    isWorktree: boolean;
}

interface LocalCloneMap {
    [repoIdOrName: string]: string;
}

/**
 * Entry point: clone the source branch (preferring a worktree off an existing
 * local clone) and open it in a new VS Code window.
 */
export async function cloneAndReviewPR(
    pr: PullRequest,
    context: vscode.ExtensionContext,
    remoteUrl: string | undefined
): Promise<void> {
    const globalState = context.globalState;
    const sourceBranch = pr.sourceRefName.replace('refs/heads/', '');
    const targetBranch = pr.targetRefName.replace('refs/heads/', '');
    const sourceCommitId = pr.lastMergeSourceCommit?.commitId ?? '';
    const targetCommitId = pr.lastMergeTargetCommit?.commitId ?? '';

    if (!await ensureGitAvailable()) {
        return;
    }

    const localClone = await getLocalClonePath(pr, globalState);

    let folderPath: string;
    let isWorktree: boolean;

    try {
        if (localClone) {
            folderPath = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Preparing worktree for PR #${pr.pullRequestId}…`,
                    cancellable: false,
                },
                (progress) => createWorktreeForPR(localClone, pr, sourceBranch, progress)
            );
            isWorktree = true;
        } else {
            if (!remoteUrl) {
                vscode.window.showErrorMessage(
                    `Cannot clone PR #${pr.pullRequestId}: no remote URL available.`
                );
                return;
            }
            folderPath = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Cloning ${pr.repository.name} for PR #${pr.pullRequestId}…`,
                    cancellable: false,
                },
                (progress) => cloneFreshForPR(remoteUrl, pr, sourceBranch, progress)
            );
            isWorktree = false;
        }
    } catch (err: any) {
        vscode.window.showErrorMessage(`Ninja Reviewer: ${err.message}`);
        return;
    }

    const pending: PendingReview = {
        folderPath,
        prId: pr.pullRequestId,
        prTitle: pr.title,
        repoId: pr.repository.id,
        repoName: pr.repository.name,
        sourceBranch,
        targetBranch,
        sourceCommitId,
        targetCommitId,
        isWorktree,
    };
    await pushPendingReview(globalState, pending);

    if (context.extensionMode === vscode.ExtensionMode.Development) {
        const launched = await tryLaunchDevHost(folderPath, context.extensionPath);
        if (!launched) {
            const choice = await vscode.window.showWarningMessage(
                'Ninja Reviewer is running in development mode. Opening a normal new window would not load the dev extension, so the PR diff cannot auto-open there.',
                'Open Diff in This Window',
                'Open New Window Anyway',
            );
            if (choice === 'Open Diff in This Window') {
                // Drop the pending entry and just open the diff here.
                await dropPendingReview(globalState, pending.folderPath);
                try {
                    await openPRDiffInWorktree(pending);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Ninja Reviewer: ${err.message}`);
                }
                return;
            }
            if (choice !== 'Open New Window Anyway') {
                return;
            }
            await vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.file(folderPath),
                { forceNewWindow: true }
            );
        }
        return;
    }

    await vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(folderPath),
        { forceNewWindow: true }
    );
}

/**
 * In Extension Development mode, regular new windows don't load the dev
 * extension. Launch a new Extension Development Host via the `code` CLI so
 * the new window also runs Ninja Reviewer.
 */
async function tryLaunchDevHost(folderPath: string, extensionPath: string): Promise<boolean> {
    const cli = findCodeCli();
    if (!cli) {
        return false;
    }
    try {
        const child = spawn(
            cli,
            [
                '--new-window',
                '--extensionDevelopmentPath', extensionPath,
                folderPath,
            ],
            { detached: true, stdio: 'ignore', shell: false }
        );
        child.on('error', () => { /* swallow — caller falls back */ });
        child.unref();
        return true;
    } catch {
        return false;
    }
}

function findCodeCli(): string | undefined {
    // execPath is the Electron binary; the CLI sits next to it under bin/.
    const execPath = process.execPath;
    const dir = path.dirname(execPath);

    const candidates = process.platform === 'win32'
        ? [
            path.join(dir, 'bin', 'code.cmd'),
            path.join(dir, 'bin', 'code-insiders.cmd'),
        ]
        : [
            path.join(dir, 'bin', 'code'),
            path.join(dir, 'bin', 'code-insiders'),
            '/usr/local/bin/code',
            '/usr/bin/code',
        ];

    for (const c of candidates) {
        if (fs.existsSync(c)) {
            return c;
        }
    }
    return undefined;
}

async function ensureGitAvailable(): Promise<boolean> {
    try {
        await execFileAsync('git', ['--version']);
        return true;
    } catch {
        vscode.window.showErrorMessage(
            'Ninja Reviewer: `git` was not found on PATH. Install Git to use Clone & Review.'
        );
        return false;
    }
}

async function getLocalClonePath(
    pr: PullRequest,
    globalState: vscode.Memento
): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('ninjaReviewer');
    const configured = config.get<LocalCloneMap>('localClones', {}) || {};
    const stored = globalState.get<LocalCloneMap>(LOCAL_CLONES_KEY, {}) || {};

    const candidate = configured[pr.repository.id]
        ?? configured[pr.repository.name]
        ?? stored[pr.repository.id]
        ?? stored[pr.repository.name];

    if (candidate && (await isGitRepo(candidate))) {
        // Reuse a known good local clone (worktree path).
        return candidate;
    }

    // No known local clone for this repo — fall through to a fresh clone
    // using the saved cloneDirectory. No extra prompt.
    return undefined;
}

async function isGitRepo(folder: string): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
            cwd: folder,
        });
        return stdout.trim() === 'true';
    } catch {
        return false;
    }
}

async function createWorktreeForPR(
    cloneRoot: string,
    pr: PullRequest,
    sourceBranch: string,
    progress: vscode.Progress<{ message?: string }>
): Promise<string> {
    const worktreesDir = await resolveWorktreesDir(cloneRoot);
    await fs.promises.mkdir(worktreesDir, { recursive: true });

    const worktreePath = path.join(
        worktreesDir,
        `pr-${pr.pullRequestId}-${sanitize(sourceBranch)}`
    );

    if (fs.existsSync(worktreePath)) {
        // Reuse: fetch latest, then update the worktree to match origin/<sourceBranch>.
        progress.report({ message: 'Fetching latest…' });
        await runGit(cloneRoot, ['fetch', 'origin', sourceBranch]);
        progress.report({ message: 'Updating existing worktree…' });
        await runGit(worktreePath, ['reset', '--hard', 'FETCH_HEAD']);
        return worktreePath;
    }

    progress.report({ message: `Fetching ${sourceBranch}…` });
    await runGit(cloneRoot, ['fetch', 'origin', sourceBranch]);

    progress.report({ message: 'Creating worktree…' });
    const worktreeBranch = `ninja-review/pr-${pr.pullRequestId}`;
    try {
        await runGit(cloneRoot, [
            'worktree', 'add', '-B', worktreeBranch, worktreePath, 'FETCH_HEAD',
        ]);
    } catch (err: any) {
        // If the branch already exists from a previous run, fall back without -B.
        await runGit(cloneRoot, ['worktree', 'add', worktreePath, 'FETCH_HEAD']);
    }

    return worktreePath;
}

async function resolveWorktreesDir(cloneRoot: string): Promise<string> {
    const config = vscode.workspace.getConfiguration('ninjaReviewer');
    const configured = config.get<string>('worktreesDirectory', '').trim();
    if (configured) {
        return configured;
    }
    return path.join(cloneRoot, '.ninja-worktrees');
}

async function cloneFreshForPR(
    remoteUrl: string,
    pr: PullRequest,
    sourceBranch: string,
    progress: vscode.Progress<{ message?: string }>
): Promise<string> {
    const config = vscode.workspace.getConfiguration('ninjaReviewer');
    const configuredDir = config.get<string>('cloneDirectory', '').trim();

    let parentDir = configuredDir;
    if (!parentDir) {
        const picked = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            title: 'Choose a default folder for Ninja Reviewer clones',
            openLabel: 'Use this folder',
        });
        if (!picked || picked.length === 0) {
            throw new Error('Cancelled.');
        }
        parentDir = picked[0].fsPath;

        // Persist as the default so we don't ask again. Best-effort:
        // try Global, fall back to Workspace if Global isn't writable.
        try {
            await config.update(
                'cloneDirectory',
                parentDir,
                vscode.ConfigurationTarget.Global
            );
            vscode.window.showInformationMessage(
                `Ninja Reviewer: future clones will go under ${parentDir}. Change in Settings → "ninjaReviewer.cloneDirectory".`
            );
        } catch {
            try {
                await config.update(
                    'cloneDirectory',
                    parentDir,
                    vscode.ConfigurationTarget.Workspace
                );
            } catch {
                // Non-fatal — we'll just ask again next time.
            }
        }
    }

    await fs.promises.mkdir(parentDir, { recursive: true });
    const target = path.join(
        parentDir,
        `${pr.repository.name}-pr-${pr.pullRequestId}-${sanitize(sourceBranch)}`
    );

    if (fs.existsSync(target)) {
        // Folder exists from a previous run. If it's a valid git repo of the
        // same remote, reuse it: fetch + reset to the latest source-branch tip.
        if (await isMatchingClone(target, remoteUrl)) {
            progress.report({ message: 'Fetching latest…' });
            try {
                await runGit(target, ['fetch', 'origin', sourceBranch]);
            } catch (err: any) {
                throw new Error(
                    `Existing clone at ${target} could not fetch ${sourceBranch}: ${err.message}`
                );
            }
            progress.report({ message: 'Updating existing clone…' });
            await runGit(target, ['checkout', '-B', sourceBranch, 'FETCH_HEAD']);
            return target;
        }

        // Not a matching clone — pick a unique sibling folder rather than
        // failing or clobbering whatever's there.
        const unique = await findUniqueTarget(target);
        progress.report({ message: `Cloning ${sourceBranch} into ${path.basename(unique)}…` });
        await runGit(undefined, [
            'clone',
            '--branch', sourceBranch,
            '--single-branch',
            remoteUrl,
            unique,
        ]);
        return unique;
    }

    progress.report({ message: `Cloning ${sourceBranch}…` });
    await runGit(undefined, [
        'clone',
        '--branch', sourceBranch,
        '--single-branch',
        remoteUrl,
        target,
    ]);

    return target;
}

async function isMatchingClone(folder: string, remoteUrl: string): Promise<boolean> {
    if (!(await isGitRepo(folder))) {
        return false;
    }
    try {
        const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
            cwd: folder,
        });
        return normalizeRemote(stdout.trim()) === normalizeRemote(remoteUrl);
    } catch {
        return false;
    }
}

function normalizeRemote(url: string): string {
    // Strip embedded credentials and trailing .git, lowercase host.
    let u = url.trim().replace(/\.git$/i, '');
    u = u.replace(/^(https?:\/\/)[^@/]*@/i, '$1'); // remove user:token@
    return u.toLowerCase();
}

async function findUniqueTarget(base: string): Promise<string> {
    for (let i = 2; i < 100; i++) {
        const candidate = `${base}-${i}`;
        if (!fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error(`Too many existing clones at ${base}-N.`);
}

function sanitize(name: string): string {
    return name.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 60);
}

async function runGit(cwd: string | undefined, args: string[]): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', args, {
            cwd,
            maxBuffer: 64 * 1024 * 1024,
        });
        return stdout;
    } catch (err: any) {
        const msg = (err.stderr || err.message || '').toString().trim();
        throw new Error(`git ${args[0]} failed: ${msg}`);
    }
}

// ---------------------------------------------------------------------------
// Cross-window handoff: persist a pending review and pick it up on activation
// in the new window.
// ---------------------------------------------------------------------------

async function pushPendingReview(
    globalState: vscode.Memento,
    pending: PendingReview
): Promise<void> {
    const list = globalState.get<PendingReview[]>(PENDING_REVIEW_KEY, []);
    list.push(pending);
    await globalState.update(PENDING_REVIEW_KEY, list);
}

async function dropPendingReview(
    globalState: vscode.Memento,
    folderPath: string
): Promise<void> {
    const list = globalState.get<PendingReview[]>(PENDING_REVIEW_KEY, []);
    const filtered = list.filter(p =>
        path.normalize(p.folderPath).toLowerCase() !==
        path.normalize(folderPath).toLowerCase()
    );
    if (filtered.length !== list.length) {
        await globalState.update(PENDING_REVIEW_KEY, filtered);
    }
}

/**
 * Called from extension activation. If the current workspace folder matches
 * a queued review, open the multi-file diff and consume the entry.
 */
export async function consumePendingReviewIfMatch(
    globalState: vscode.Memento,
    treeProvider: PRTreeProvider
): Promise<void> {
    const list = globalState.get<PendingReview[]>(PENDING_REVIEW_KEY, []);
    if (list.length === 0) {
        return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        return;
    }

    const currentPaths = folders.map(f => path.normalize(f.uri.fsPath).toLowerCase());

    const matchIdx = list.findIndex(p =>
        currentPaths.includes(path.normalize(p.folderPath).toLowerCase())
    );
    if (matchIdx === -1) {
        // Nothing matched the workspace, but if there's only one pending
        // review and the user just opened a folder, fall back to using it
        // — common when path casing or symlinks differ.
        if (list.length === 1 && currentPaths.length === 1) {
            const pending = list[0];
            list.splice(0, 1);
            await globalState.update(PENDING_REVIEW_KEY, list);
            try {
                await openPRDiffInWorktree(
                    { ...pending, folderPath: folders[0].uri.fsPath },
                    treeProvider
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(
                    `Ninja Reviewer: failed to open PR diff — ${err.message}`
                );
            }
        }
        return;
    }

    const pending = list[matchIdx];
    list.splice(matchIdx, 1);
    await globalState.update(PENDING_REVIEW_KEY, list);

    try {
        await openPRDiffInWorktree(pending, treeProvider);
    } catch (err: any) {
        vscode.window.showErrorMessage(
            `Ninja Reviewer: failed to open PR diff — ${err.message}`
        );
    }
}

/**
 * Manual command: prompt for a PR id / branch info and rebuild the diff for
 * the current workspace. Used when the auto-open misses (e.g. extension was
 * not active when the window opened).
 */
export async function showDiffForCurrentWorkspace(treeProvider: PRTreeProvider): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
        vscode.window.showWarningMessage('Ninja Reviewer: no folder is open.');
        return;
    }
    const folder = folders[0].uri.fsPath;

    if (!(await isGitInsideWorkTree(folder))) {
        vscode.window.showErrorMessage(`${folder} is not a git working tree.`);
        return;
    }

    const targetBranch = await vscode.window.showInputBox({
        prompt: 'Target branch to diff against (e.g. main)',
        value: 'main',
    });
    if (!targetBranch) { return; }

    const pending: PendingReview = {
        folderPath: folder,
        prId: 0,
        prTitle: `${path.basename(folder)} vs ${targetBranch}`,
        repoId: '',
        repoName: path.basename(folder),
        sourceBranch: 'HEAD',
        targetBranch,
        sourceCommitId: '',
        targetCommitId: '',
        isWorktree: false,
    };
    try {
        await openPRDiffInWorktree(pending, treeProvider);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Ninja Reviewer: ${err.message}`);
    }
}

async function isGitInsideWorkTree(folder: string): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: folder });
        return stdout.trim() === 'true';
    } catch {
        return false;
    }
}

async function openPRDiffInWorktree(
    pending: PendingReview,
    treeProvider: PRTreeProvider,
): Promise<void> {
    const folder = pending.folderPath;

    // Make sure we have the target ref locally so we can compute merge-base.
    try {
        await runGit(folder, ['fetch', 'origin', pending.targetBranch]);
    } catch {
        // Non-fatal: the existing fetch state may already include it.
    }
    let baseRef: string;
    try {
        const { stdout } = await execFileAsync('git', [
            'merge-base', 'HEAD', `origin/${pending.targetBranch}`,
        ], { cwd: folder });
        baseRef = stdout.trim();
    } catch {
        baseRef = pending.targetCommitId || `origin/${pending.targetBranch}`;
    }

    if (!baseRef) {
        throw new Error('Could not determine merge-base for diff.');
    }

    // List changed files between base and HEAD.
    const { stdout: nameStatus } = await execFileAsync('git', [
        'diff', '--name-status', `${baseRef}...HEAD`,
    ], { cwd: folder, maxBuffer: 64 * 1024 * 1024 });

    const entries = parseNameStatus(nameStatus);
    if (entries.length === 0) {
        vscode.window.showInformationMessage(
            `PR #${pending.prId}: no changes between ${pending.targetBranch} and ${pending.sourceBranch}.`
        );
        return;
    }

    const headSha = (await runGit(folder, ['rev-parse', 'HEAD'])).trim();
    const gitApi = await getBuiltInGitApi();

    const items: PRTreeItem[] = entries.map(e =>
        buildLocalFileItem(e, folder, baseRef, headSha, gitApi, pending.prId, pending.repoId)
    );

    const title = pending.prId
        ? `PR #${pending.prId}`
        : `${pending.repoName} \u2192 ${pending.targetBranch}`;

    // For real PRs (not the manual "current workspace" diff) we have an ADO
    // PR id, so we can also pull comments via the API. Build a pseudo PR
    // object that satisfies the AzureDevOpsClient.getThreads call path.
    const adoPR = pending.prId && pending.repoId
        ? {
            repoId: pending.repoId,
            prId: pending.prId,
            pseudoPR: {
                pullRequestId: pending.prId,
                title: pending.prTitle,
                description: '',
                status: 'active',
                createdBy: { displayName: '', uniqueName: '' },
                creationDate: new Date().toISOString(),
                sourceRefName: `refs/heads/${pending.sourceBranch}`,
                targetRefName: `refs/heads/${pending.targetBranch}`,
                repository: {
                    id: pending.repoId,
                    name: pending.repoName,
                    project: { id: '', name: '' },
                },
            } as PullRequest,
        }
        : undefined;

    treeProvider.focusLocalChanges(title, pending.prTitle, items, adoPR);

    // Reveal the Ninja Reviewer view container so the file list is visible immediately.
    await vscode.commands.executeCommand('workbench.view.extension.ninjaReviewer');
}

function buildLocalFileItem(
    entry: DiffEntry,
    folder: string,
    baseRef: string,
    headSha: string,
    gitApi: { toGitUri?(uri: vscode.Uri, ref: string): vscode.Uri } | undefined,
    prId: number,
    repoId: string,
): PRTreeItem {
    const relPath = (entry.headPath ?? entry.path).replace(/^\//, '');
    const fileName = path.basename(relPath);
    const dirName = relPath.includes('/')
        ? relPath.substring(0, relPath.lastIndexOf('/'))
        : '';

    const headFsPath = path.join(folder, entry.headPath ?? entry.path);
    const baseFsPath = path.join(folder, entry.basePath ?? entry.path);
    const headUri = vscode.Uri.file(headFsPath);

    const originalUri = entry.status === 'A' || !gitApi
        ? undefined
        : toGitUri(gitApi, vscode.Uri.file(baseFsPath), baseRef);
    const modifiedUri = entry.status === 'D' || !gitApi
        ? undefined
        : toGitUri(gitApi, headUri, headSha);

    const label = statusLabel(entry.status);
    const title = `${fileName} (PR #${prId}: ${label})`;

    let command: vscode.Command;
    if (entry.status === 'A') {
        command = { title: 'Open', command: 'vscode.open', arguments: [headUri] };
    } else if (entry.status === 'D') {
        command = {
            title: 'Open',
            command: 'vscode.open',
            arguments: [originalUri ?? headUri],
        };
    } else if (originalUri && modifiedUri) {
        // Use our own command so we can open the diff AND load PR comments
        // onto the git: URIs (read-only) in the Clone & Review window.
        command = {
            title: 'Open Diff',
            command: 'ninjaReviewer.openLocalDiff',
            arguments: [{
                originalUri,
                modifiedUri,
                title,
                repoId,
                prId,
                filePath: '/' + relPath,
            }],
        };
    } else {
        command = { title: 'Open', command: 'vscode.open', arguments: [headUri] };
    }

    const item = new PRTreeItem(fileName, 'file');
    item.description = dirName || label;
    item.tooltip = `${label}: ${relPath}`;
    item.iconPath = statusIcon(entry.status);
    item.command = command;
    return item;
}

function statusLabel(status: string): string {
    switch (status) {
        case 'A': return 'Added';
        case 'M': return 'Modified';
        case 'D': return 'Deleted';
        case 'R': return 'Renamed';
        case 'C': return 'Copied';
        case 'T': return 'Type Changed';
        default: return 'Changed';
    }
}

function statusIcon(status: string): vscode.ThemeIcon {
    switch (status) {
        case 'A': return new vscode.ThemeIcon('diff-added', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
        case 'D': return new vscode.ThemeIcon('diff-removed', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
        case 'R': return new vscode.ThemeIcon('diff-renamed', new vscode.ThemeColor('gitDecoration.renamedResourceForeground'));
        default:  return new vscode.ThemeIcon('diff-modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
    }
}

interface DiffEntry {
    status: string;     // A, M, D, R, C, T
    path: string;       // representative path (head if exists, else base)
    basePath?: string;  // path on base side (for renames)
    headPath?: string;  // path on head side
}

function parseNameStatus(out: string): DiffEntry[] {
    const lines = out.split(/\r?\n/).filter(l => l.length > 0);
    const entries: DiffEntry[] = [];
    for (const line of lines) {
        const parts = line.split('\t');
        const status = parts[0][0]; // R100 -> R
        if (status === 'R' || status === 'C') {
            const basePath = parts[1];
            const headPath = parts[2];
            entries.push({ status, path: headPath, basePath, headPath });
        } else {
            const p = parts[1];
            entries.push({
                status,
                path: p,
                basePath: status === 'A' ? undefined : p,
                headPath: status === 'D' ? undefined : p,
            });
        }
    }
    return entries;
}

// ---------------------------------------------------------------------------
// Built-in Git extension wiring (for git: URIs the diff editor understands).
// ---------------------------------------------------------------------------

interface GitExtensionApiShim {
    getAPI(version: 1): { toGitUri?(uri: vscode.Uri, ref: string): vscode.Uri };
}

async function getBuiltInGitApi(): Promise<{ toGitUri?(uri: vscode.Uri, ref: string): vscode.Uri } | undefined> {
    const ext = vscode.extensions.getExtension<GitExtensionApiShim>('vscode.git');
    if (!ext) {
        return undefined;
    }
    if (!ext.isActive) {
        await ext.activate();
    }
    return ext.exports.getAPI(1);
}

function toGitUri(
    api: { toGitUri?(uri: vscode.Uri, ref: string): vscode.Uri },
    uri: vscode.Uri,
    ref: string
): vscode.Uri {
    if (api.toGitUri) {
        return api.toGitUri(uri, ref);
    }
    // Fallback: build the same URI shape the git extension uses.
    const params = { path: uri.fsPath, ref };
    return uri.with({ scheme: 'git', path: uri.path, query: JSON.stringify(params) });
}
