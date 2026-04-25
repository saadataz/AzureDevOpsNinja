import * as vscode from 'vscode';
import { DiffContext } from './types';

export class HoverExplainerProvider implements vscode.HoverProvider {
    private cache = new Map<string, string>();
    private diffContexts = new Map<string, DiffContext>();

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

        const cacheKey = `${document.uri.toString()}:${position.line}`;
        if (this.cache.has(cacheKey)) {
            return this.createHover(this.cache.get(cacheKey)!);
        }

        // Gather surrounding context (5 lines before and after)
        const startLine = Math.max(0, position.line - 5);
        const endLine = Math.min(document.lineCount - 1, position.line + 5);
        const contextLines: string[] = [];
        for (let i = startLine; i <= endLine; i++) {
            const prefix = i === position.line ? '>>> ' : '    ';
            contextLines.push(`${prefix}${document.lineAt(i).text}`);
        }

        const diffCtx = this.diffContexts.get(document.uri.toString());
        const prInfo = diffCtx
            ? `This is from PR #${diffCtx.prId}: "${diffCtx.prTitle}" (${diffCtx.changeType} file: ${diffCtx.filePath})`
            : 'This is a code change from a pull request.';

        try {
            const explanation = await this.getExplanation(
                line.text,
                contextLines.join('\n'),
                prInfo,
                document.languageId,
                token
            );

            if (explanation) {
                this.cache.set(cacheKey, explanation);
                return this.createHover(explanation);
            }
        } catch (err: any) {
            if (token.isCancellationRequested) {
                return undefined;
            }
            return this.createHover(`*Could not generate explanation: ${err.message}*`);
        }

        return undefined;
    }

    private async getExplanation(
        lineText: string,
        surroundingCode: string,
        prContext: string,
        languageId: string,
        token: vscode.CancellationToken
    ): Promise<string | undefined> {
        // Try to get a Copilot model
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

        const model = models[0];

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
        const response = await model.sendRequest(messages, {}, token);

        let result = '';
        for await (const chunk of response.text) {
            result += chunk;
        }

        return result;
    }

    private createHover(explanation: string): vscode.Hover {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.supportHtml = true;
        md.appendMarkdown(`### 🥷 Ninja Reviewer\n\n`);
        md.appendMarkdown(explanation);
        return new vscode.Hover(md);
    }

    clearCache(): void {
        this.cache.clear();
    }
}
