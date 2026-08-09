#!/usr/bin/env bash
# Files the 10 drafted good-first-issues from .github/GOOD_FIRST_ISSUES.md as
# GitHub issues, labelled `good first issue`. Idempotent-ish: run once.
#
# Prereq: `gh auth status` must show you logged in with `repo` scope.
# Verify with: gh label list --repo ahmd-nish/inventarium

set -euo pipefail

REPO="${GH_REPO:-ahmd-nish/inventarium}"
LABEL="good first issue"

create() {
  local title="$1"
  local body="$2"
  echo "→ $title"
  gh issue create --repo "$REPO" --title "$title" --body "$body" --label "$LABEL"
}

create "Add a Ruby test-runner detector" "\
\`packages/core/src/adapters/test-runner.ts\` auto-detects bun/jest/vitest/pytest/npm. Add rspec/minitest for Ruby projects: detect via \`Gemfile\` or the \`test/\` layout, invoke \`bundle exec rspec\` or \`rake test\`, parse pass/fail counts. Add fixtures + tests in \`test-runner.test.ts\`.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#1)"

create "Add a Go test-runner detector" "\
Same shape as the Ruby detector, but for \`go.mod\` projects. Invoke \`go test ./...\`, parse the \`--- PASS: TestFoo\` / \`--- FAIL: TestBar\` lines.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#2)"

create "Ship a \`security-reviewer\` bundled subagent" "\
Add \`packages/cli/agents/security-reviewer.md\` with clear rules for auditing a diff for common issues (input validation at boundaries, secret leaks, unsafe deserialisation). Follow the shape of the existing 6 subagents.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#3)"

create "Ship a \`docs-writer\` bundled subagent" "\
Add \`packages/cli/agents/docs-writer.md\` — an agent tuned for writing README sections, API docs, and inline JSDoc without over-explaining. Emphasize concrete examples.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#4)"

create "Add a \`--version\` flag to the CLI" "\
\`packages/cli/src/index.ts\` doesn't print the version yet. Read it from \`packages/cli/package.json\` and print on \`--version\` / \`-v\`. Add to the help text.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#5)"

create "Colorize the \`inventarium status\` output by column count" "\
\`cmdStatus\` in \`packages/cli/src/index.ts\` prints status counts. If \`in_progress > 0\`, green the number; if \`blocked > 0\`, red. Uses the existing \`c.*\` ANSI helpers.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#6)"

create "Add an example PRD for a Slack bot" "\
Drop a real, planner-ready PRD at \`packages/cli/examples/slack-bot-prd.md\` following the shape of \`sample-prd.md\`. Bonus: run the planner on it and check the resulting DAG feels sensible.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#7)"

create "Add keyboard shortcut for \"run all\"" "\
The board's \"run all\" button is at the top of \`packages/web/src/App.tsx\`. Bind it to a keyboard shortcut (e.g. \`Cmd+Shift+R\`) in \`packages/web/src/lib/hotkeys.ts\`. Show the shortcut in the button's \`title\`.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#8)"

create "Add a \"copy diff\" button to the artifact display" "\
When a task has a \`git_diff\` artifact, the task detail shows the content. Add a \"copy\" button that puts the diff on the clipboard. See \`packages/web/src/components/task-detail/\` for the current artifact view.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#9)"

create "Add an \`inventarium export <boardId>\` CLI subcommand" "\
The server has \`/api/boards/:id/export\`. Wire a CLI subcommand that writes the JSON to stdout so users can pipe boards into other tools. Follow the \`cmdStatus\` / \`cmdPlan\` shape in the CLI.

Source: [.github/GOOD_FIRST_ISSUES.md](../blob/main/.github/GOOD_FIRST_ISSUES.md#10)"

echo ""
echo "✓ 10 good-first-issues filed on $REPO"
