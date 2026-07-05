# Security

## What agent-trail actually does

agent-trail spawns the `claude` CLI (or another AI coding agent) in a subprocess and lets it run with **write access to your working directory**. That's the whole point — the agent needs to write code to accomplish tasks. It's important you know this before you install.

Concretely, a running agent-trail can:

- Read any file the current user can read
- Write, edit, and delete files in the project directory
- Create git branches, worktrees, and commits
- Run shell commands (test runners, `bun install`, etc.) via the agent's tool calls
- Reach the network via the agent's `WebFetch` / `WebSearch` tools (subject to the agent's own restrictions)

By default the permission mode is `acceptEdits` — routine edits flow through, but the agent still asks for irreversible operations. You can widen this per-board (`bypassPermissions`) or narrow it (`plan`, `default`) in Board Settings. **Never run agent-trail with `bypassPermissions` on a machine that holds credentials you can't rotate.**

## Local-only telemetry

agent-trail stores everything in a local SQLite file (`agent-trail.db`) in the directory you ran it from. Nothing is sent to Anthropic servers by this tool. The `claude` CLI is a separate process — its telemetry policy is [documented by Anthropic](https://claude.ai/docs).

## Sandbox recommendations

If you're using agent-trail on anything sensitive, one of these:

1. **A disposable git branch + worktree.** agent-trail auto-creates a worktree per task, but that's still inside your repo. Use a fresh branch you can throw away.
2. **A docker container or VM.** Mount the project read-write, mount everything else read-only.
3. **A dedicated system user.** Give it access to only the project directory.

## Reporting a vulnerability

Please email **security@agent-trail.dev** (replace with your real address before publishing) with:

- A clear description of the issue and its impact
- Steps to reproduce
- Any suggested fix or mitigation

We aim to acknowledge reports within 48 hours and ship a fix within 14 days for anything genuinely exploitable. Public disclosure happens after users have had a chance to upgrade.

Please do NOT:

- Open a public GitHub issue for a security bug
- Post the details to social media before we've had a chance to patch
- Test the vulnerability against installations you don't own
