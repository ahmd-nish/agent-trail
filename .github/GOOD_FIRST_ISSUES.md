# Good first issues

10 concrete starter tasks. Each is scoped so a first-time contributor can land a PR in an afternoon.

## 1. Add a Ruby test-runner detector
`packages/core/src/adapters/test-runner.ts` auto-detects bun/jest/vitest/pytest/npm. Add rspec/minitest for Ruby projects: detect via `Gemfile` or the `test/` layout, invoke `bundle exec rspec` or `rake test`, parse pass/fail counts. Add fixtures + tests in `test-runner.test.ts`.

## 2. Add a Go test-runner detector
Same shape as #1, but for `go.mod` projects. Invoke `go test ./...`, parse the `--- PASS: TestFoo` / `--- FAIL: TestBar` lines.

## 3. Ship a `security-reviewer` bundled subagent
Add `packages/cli/agents/security-reviewer.md` with clear rules for auditing a diff for common issues (input validation at boundaries, secret leaks, unsafe deserialisation). Follow the shape of the existing 6 subagents.

## 4. Ship a `docs-writer` bundled subagent
Add `packages/cli/agents/docs-writer.md` — an agent tuned for writing README sections, API docs, and inline JSDoc without over-explaining. Emphasize concrete examples.

## 5. Add a `--version` flag to the CLI
`packages/cli/src/index.ts` doesn't print the version yet. Read it from `packages/cli/package.json` and print on `--version` / `-v`. Add to the help text.

## 6. Colorize the `inventarium status` output by column count
`cmdStatus` in `packages/cli/src/index.ts` prints status counts. If `in_progress > 0`, green the number; if `blocked > 0`, red. Uses the existing `c.*` ANSI helpers.

## 7. Add an example PRD for a Slack bot
Drop a real, planner-ready PRD at `packages/cli/examples/slack-bot-prd.md` following the shape of `sample-prd.md`. Bonus: run the planner on it and check the resulting DAG feels sensible.

## 8. Add keyboard shortcut for "run all"
The board's "run all" button is at the top of `packages/web/src/App.tsx`. Bind it to a keyboard shortcut (e.g. `Cmd+Shift+R`) in `packages/web/src/lib/hotkeys.ts`. Show the shortcut in the button's `title`.

## 9. Add a "copy diff" button to the artifact display
When a task has a `git_diff` artifact, the task detail shows the content. Add a "copy" button that puts the diff on the clipboard. See `packages/web/src/components/task-detail/` for the current artifact view.

## 10. Add a `inventarium export <boardId>` CLI subcommand
The server has `/api/boards/:id/export`. Wire a CLI subcommand that writes the JSON to stdout so users can pipe boards into other tools. Follow the `cmdStatus` / `cmdPlan` shape in the CLI.

---

Guidelines:
- One issue = one PR. Don't bundle.
- Tests go with the code, not in a follow-up.
- Ask on the issue if the scope isn't clear — better to align first than rework a PR.
