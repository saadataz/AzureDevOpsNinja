import * as vscode from 'vscode';
import { AzureDevOpsClient } from './azureDevOps';
import { ChangeEntry, Iteration, PullRequest } from './types';

/** A single grouped change identified by the AI. */
export interface WalkthroughKeyChange {
    title: string;
    description: string;
    files: string[]; // ADO-style paths (with leading "/")
}

export interface WalkthroughResult {
    summary: string;
    keyChanges: WalkthroughKeyChange[];
    /** Files included in the prompt — used for the "All changed files" section. */
    files: WalkthroughFile[];
    iteration: Iteration;
    /** True if at least one file was skipped because it was too large / binary. */
    truncated: boolean;
    /** Name of the LM that generated the walkthrough. */
    modelLabel: string;
}

export interface WalkthroughFile {
    path: string;
    changeType: number;
    change: ChangeEntry;
    skippedReason?: string;
}

const MAX_FILE_BYTES = 1_000_000;            // Per-file content cap before diffing.
const MAX_DIFF_LINES_PER_FILE = 2000;       // Lines of diff sent to the model per file.
const MAX_FILES_IN_PROMPT = 40;            // Hard cap to keep token usage bounded.
const MAX_TOTAL_PROMPT_CHARS = 90_000;     // Final safety net on the assembled prompt.

/**
 * Fetch the PR's latest iteration changes, compute compact per-file diffs,
 * and ask the Language Model API to produce a structured walkthrough.
 */
export async function generateWalkthrough(
    client: AzureDevOpsClient,
    pr: PullRequest,
    token: vscode.CancellationToken,
    progress?: vscode.Progress<{ message?: string; increment?: number }>,
): Promise<WalkthroughResult> {
    progress?.report({ message: 'Loading changed files…' });
    const iterations = await client.getPullRequestIterations(pr.repository.id, pr.pullRequestId);
    if (iterations.length === 0) {
        throw new Error('PR has no iterations.');
    }
    const iteration = iterations[iterations.length - 1];
    const changes = await client.getPullRequestChanges(
        pr.repository.id, pr.pullRequestId, iteration.id,
    );
    const fileChanges = changes.filter(c => c.item.path && c.item.path !== '/');
    if (fileChanges.length === 0) {
        throw new Error('PR has no file changes.');
    }

    // Decide which files to send. Cap the total set; prefer modified/added
    // over deleted (deletions carry less code-review value).
    const sorted = [...fileChanges].sort((a, b) => priority(a) - priority(b));
    const selected = sorted.slice(0, MAX_FILES_IN_PROMPT);
    const truncated = selected.length < fileChanges.length;

    progress?.report({ message: `Fetching contents (${selected.length} files)…` });
    const files: WalkthroughFile[] = [];
    const diffs: { path: string; changeType: number; diff: string }[] = [];

    for (let i = 0; i < selected.length; i++) {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
        const change = selected[i];
        const filePath = change.item.path;
        progress?.report({
            message: `Diffing ${filePath} (${i + 1}/${selected.length})…`,
            increment: 100 / selected.length / 2,
        });

        const fileEntry: WalkthroughFile = { path: filePath, changeType: change.changeType, change };
        try {
            const [base, head] = await Promise.all([
                isAdded(change.changeType)
                    ? Promise.resolve('')
                    : safeGetFile(client, pr.repository.id, filePath, iteration.targetRefCommit.commitId),
                isDeleted(change.changeType)
                    ? Promise.resolve('')
                    : safeGetFile(client, pr.repository.id, filePath, iteration.sourceRefCommit.commitId),
            ]);

            if (looksBinary(base) || looksBinary(head)) {
                fileEntry.skippedReason = 'binary';
            } else if (base.length > MAX_FILE_BYTES || head.length > MAX_FILE_BYTES) {
                fileEntry.skippedReason = 'too large';
            } else {
                const diff = buildSimpleDiff(base, head, MAX_DIFF_LINES_PER_FILE);
                diffs.push({ path: filePath, changeType: change.changeType, diff });
            }
        } catch (err: any) {
            fileEntry.skippedReason = `fetch failed: ${err.message ?? err}`;
        }
        files.push(fileEntry);
    }

    if (diffs.length === 0) {
        throw new Error('No diffs available to summarize (all files were skipped).');
    }

    progress?.report({ message: 'Selecting language model…', increment: 5 });
    const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!model) {
        throw new Error(
            'No language model available. Install GitHub Copilot or another chat provider, then retry.',
        );
    }

    progress?.report({ message: `Asking ${model.name}…`, increment: 5 });
    const prompt = buildPrompt(pr, diffs);
    const response = await model.sendRequest(
        [
            vscode.LanguageModelChatMessage.User(
                'You are an expert code reviewer producing concise, accurate walkthroughs of pull requests for a developer audience. Always answer in the exact format requested. Group related file changes into a small number of key changes (typically 2–6).',
            ),
            vscode.LanguageModelChatMessage.User(prompt),
        ],
        {},
        token,
    );

    let text = '';
    for await (const fragment of response.text) {
        text += fragment;
    }

    const parsed = parseWalkthrough(text);
    return {
        summary: parsed.summary,
        keyChanges: parsed.keyChanges,
        files,
        iteration,
        truncated,
        modelLabel: model.name,
    };
}

// ----- helpers ---------------------------------------------------------

function priority(c: ChangeEntry): number {
    // Lower number = higher priority. Modified > Added > Renamed > Deleted.
    if (isDeleted(c.changeType)) { return 3; }
    if (c.changeType & 8) { return 2; }      // renamed
    if (c.changeType & 1) { return 1; }      // added
    return 0;                                // modified / other
}

function isAdded(changeType: number): boolean {
    return (changeType & 1) !== 0 && (changeType & 2) === 0;
}

function isDeleted(changeType: number): boolean {
    return (changeType & 16) !== 0;
}

async function safeGetFile(
    client: AzureDevOpsClient, repoId: string, path: string, commit: string,
): Promise<string> {
    try {
        return await client.getFileContent(repoId, path, commit, 'commit');
    } catch {
        return '';
    }
}

function looksBinary(text: string): boolean {
    if (!text) { return false; }
    // Quick heuristic: NUL byte or a high ratio of non-printable chars.
    if (text.includes('\u0000')) { return true; }
    let nonPrintable = 0;
    const sample = text.slice(0, 4000);
    for (let i = 0; i < sample.length; i++) {
        const c = sample.charCodeAt(i);
        if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 127) {
            nonPrintable++;
        }
    }
    return nonPrintable / Math.max(1, sample.length) > 0.1;
}

/**
 * Produce a tiny "added/removed" view of two file versions. Not a true
 * unified diff, but gives the model enough signal without pulling in a
 * diff library.
 */
function buildSimpleDiff(before: string, after: string, maxLines: number): string {
    const beforeLines = before.split(/\r?\n/);
    const afterLines = after.split(/\r?\n/);
    const beforeSet = new Map<string, number>();
    for (const l of beforeLines) { beforeSet.set(l, (beforeSet.get(l) ?? 0) + 1); }
    const afterSet = new Map<string, number>();
    for (const l of afterLines) { afterSet.set(l, (afterSet.get(l) ?? 0) + 1); }

    const removed: string[] = [];
    for (const l of beforeLines) {
        const a = afterSet.get(l) ?? 0;
        if (a > 0) {
            afterSet.set(l, a - 1);
        } else {
            removed.push(l);
        }
    }
    const added: string[] = [];
    const beforeRemaining = new Map(beforeSet);
    for (const l of afterLines) {
        const b = beforeRemaining.get(l) ?? 0;
        if (b > 0) {
            beforeRemaining.set(l, b - 1);
        } else {
            added.push(l);
        }
    }

    const half = Math.max(1, Math.floor(maxLines / 2));
    const lines: string[] = [];
    if (removed.length > 0) {
        lines.push(`--- removed (${removed.length} line${removed.length === 1 ? '' : 's'}) ---`);
        for (const l of removed.slice(0, half)) {
            lines.push('- ' + l);
        }
        if (removed.length > half) {
            lines.push(`… (${removed.length - half} more removed lines)`);
        }
    }
    if (added.length > 0) {
        lines.push(`+++ added (${added.length} line${added.length === 1 ? '' : 's'}) +++`);
        for (const l of added.slice(0, half)) {
            lines.push('+ ' + l);
        }
        if (added.length > half) {
            lines.push(`… (${added.length - half} more added lines)`);
        }
    }
    if (lines.length === 0) {
        lines.push('(no textual changes detected — likely whitespace or rename)');
    }
    return lines.join('\n');
}

function changeLabel(changeType: number): string {
    if (changeType & 1 && !(changeType & 2)) { return 'Added'; }
    if (changeType & 16) { return 'Deleted'; }
    if (changeType & 8) { return 'Renamed'; }
    if (changeType & 2) { return 'Modified'; }
    return 'Changed';
}

function buildPrompt(
    pr: PullRequest,
    diffs: { path: string; changeType: number; diff: string }[],
): string {
    const header = [
        `Pull Request: ${pr.title}`,
        `Repository: ${pr.repository.name}`,
        `Branch: ${pr.sourceRefName.replace('refs/heads/', '')} -> ${pr.targetRefName.replace('refs/heads/', '')}`,
        '',
        'PR description:',
        (pr.description || '(no description)').slice(0, 4000),
        '',
        'Below are the file-by-file changes. Each entry shows the file path,',
        'the change type, and a compact list of removed/added lines.',
        '',
    ].join('\n');

    let body = '';
    for (const d of diffs) {
        const block = [
            '====================================================================',
            `FILE: ${d.path}`,
            `CHANGE: ${changeLabel(d.changeType)}`,
            '--------------------------------------------------------------------',
            d.diff,
            '',
        ].join('\n');
        if ((header.length + body.length + block.length) > MAX_TOTAL_PROMPT_CHARS) {
            body += '\n[Remaining files omitted to fit context window.]\n';
            break;
        }
        body += block;
    }

    const instructions = [
        '',
        'Produce a walkthrough using EXACTLY this Markdown structure:',
        '',
        '## Summary',
        '<2-3 sentences describing the overall purpose and scope of the PR>',
        '',
        '## Key Changes',
        '',
        '### <Short, action-oriented title for change group 1>',
        '<2-4 sentence explanation of what changed and why>',
        'Files: <comma-separated list of file paths from the FILE: lines above>',
        '',
        '### <Title for change group 2>',
        '<explanation>',
        'Files: <files>',
        '',
        '(Repeat for each logical group of changes — typically 2 to 6 groups.)',
        '',
        'Rules:',
        '- Group related files into the same change when possible.',
        '- Use file paths exactly as they appear after "FILE:" (keep the leading slash).',
        '- Do not invent files that were not listed.',
        '- Keep titles under 80 characters.',
        '- Do not add sections beyond Summary and Key Changes.',
    ].join('\n');

    return header + body + instructions;
}

function parseWalkthrough(text: string): { summary: string; keyChanges: WalkthroughKeyChange[] } {
    const summaryMatch = text.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##\s|$)/i);
    const summary = (summaryMatch?.[1] ?? '').trim();

    const keyMatch = text.match(/##\s*Key Changes\s*\n([\s\S]*)$/i);
    const body = keyMatch?.[1] ?? '';

    const keyChanges: WalkthroughKeyChange[] = [];
    // Split on "### " headers.
    const sections = body.split(/\n###\s+/);
    // First chunk before any "###" is preamble, skip it.
    for (let i = 1; i < sections.length; i++) {
        const sec = sections[i];
        const lines = sec.split('\n');
        const title = (lines.shift() ?? '').trim();
        if (!title) { continue; }
        let filesLine = '';
        const descLines: string[] = [];
        for (const line of lines) {
            const m = line.match(/^\s*Files?\s*:\s*(.+)$/i);
            if (m) {
                filesLine = m[1].trim();
            } else {
                descLines.push(line);
            }
        }
        const description = descLines.join('\n').trim();
        const files = filesLine
            ? filesLine.split(/[,\n]/).map(s => s.trim().replace(/^[`"']|[`"']$/g, '')).filter(Boolean)
            : [];
        keyChanges.push({ title, description, files });
    }

    if (!summary && keyChanges.length === 0) {
        // Fallback: just return the raw response as the summary so the user
        // sees something rather than a confusing empty page.
        return { summary: text.trim() || '(empty response)', keyChanges: [] };
    }
    return { summary: summary || '(no summary returned)', keyChanges };
}
