# Azure DevOps Ninja 🥷

**Azure DevOps tools for the AI-native world.** Review pull requests directly inside VS Code, with AI-powered hover explanations on every line of code.

![Azure DevOps Ninja](resources/icon.png)

> ⚡ This extension is **vibe-coded** — built end-to-end with GitHub Copilot in a flow state. Expect rough edges; PRs and issues welcome.

## Features

- **PR sidebar** — Browse pull requests across your favorite repos in a dedicated activity bar view (Repos → PRs → Files).
- **Native diff viewer** — Open any changed file as a real VS Code diff, with full syntax highlighting.
- **AI hover explanations** — Hover any line of changed code to get an instant *What / Why / Impact* explanation from GitHub Copilot's language model.
- **Comments** — Read, reply to, and add new PR comments inline using VS Code's native commenting UI.
- **PR description page** — Rich webview with the PR description (Markdown), reviewer avatars, vote buttons (Approve / Approve w/ Suggestions / Wait / Reject / Reset), and PR-level comment threads.
- **Clone & Review locally** — One click to clone the source branch (or create a git worktree of an existing clone) so you can review the PR in your real workspace.
- **Microsoft sign-in** — Uses VS Code's built-in Microsoft authentication. No PATs to manage.

## Requirements

- VS Code **1.90+**
- An **Azure DevOps** organization & project
- **GitHub Copilot** (for AI hover explanations — the rest works without it)

## Getting Started

1. Install **Azure DevOps Ninja** from the Marketplace.
2. Click the ninja icon in the activity bar.
3. Run **Ninja Reviewer: Configure Organization** and enter your org + project.
4. Sign in with your Microsoft account when prompted.
5. Run **Select Favorite Repositories** to pick which repos to track.
6. Expand a repo → expand a PR → click any file to open the diff.
7. **Hover** over any changed line for an AI explanation.

## Commands

| Command | Description |
| --- | --- |
| `Ninja Reviewer: Configure Organization` | Set the Azure DevOps organization and project. |
| `Ninja Reviewer: Sign In` | Sign in with your Microsoft account. |
| `Ninja Reviewer: Select Favorite Repositories` | Choose which repos appear in the sidebar. |
| `Ninja Reviewer: Refresh` | Reload PRs, diffs, and comments. |
| `Ninja Reviewer: Clone Source Branch & Review Locally` | Clone (or worktree) the PR's source branch into a new VS Code window. |
| `Ninja Reviewer: Show PR Diff for Current Workspace` | Open the diff for the PR matching the current workspace's branch. |

## Settings

| Setting | Description |
| --- | --- |
| `ninjaReviewer.organization` | Azure DevOps organization name or URL. |
| `ninjaReviewer.project` | Azure DevOps project name. |
| `ninjaReviewer.cloneDirectory` | Default parent folder for fresh clones from *Clone & Review*. |
| `ninjaReviewer.worktreesDirectory` | Folder where PR review worktrees are created. Defaults to `<clone>/.ninja-worktrees`. |
| `ninjaReviewer.localClones` | Map of repository ID or name → local clone path, for worktree-based reviews. |

## Privacy

- Authentication is handled by VS Code's built-in Microsoft auth provider — credentials never touch this extension.
- Code, diffs, and PR metadata are sent to GitHub Copilot's language model **only** when you hover a line to request an explanation.
- Avatar images are fetched through the extension (with your auth token) so VS Code can render them; they are cached in memory only.

## Known Limitations

- Only Azure DevOps Services (`dev.azure.com`) is tested. On-prem Azure DevOps Server may work but is unverified.
- Hover explanations require an active GitHub Copilot subscription.

## License

[MIT](LICENSE)
