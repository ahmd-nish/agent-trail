#!/usr/bin/env bash
# Creates the v1.0.0 GitHub Release (tag already exists from commit 45f9423).
# Updates the repo description + topics to match README reality.
#
# Prereq: `gh auth status` must show you logged in with `repo` scope.

set -euo pipefail

REPO="${GH_REPO:-ahmd-nish/inventarium}"

gh release create v1.0.0 \
  --repo "$REPO" \
  --title "v1.0.0 — initial open-source drop" \
  --notes "$(cat <<'EOF'
The kanban board where your team's AI coding agents share a brain.

Parallel Claude Code executions in isolated git worktrees, under a TDD gate, with human decision tickets and a live SSE activity feed. Everything from Phase 2 (compat layer, crash-resume, auto-PR, CI mode), Phase 3 (context store, decisions, teammate flow), Phase 4 (library, planner auto-match, repo-map, file-footprint parallelism), and Phase 5 (Ralph iteration memory, loop metrics, deploy agent) shipped.

**Install (requires Bun ≥ 1.1 globally):**
\`\`\`
bunx inventarium --demo
\`\`\`

**Highlights**
- 6-column kanban with parallel worktrees (file-footprint-aware scheduler)
- TDD gate: write_tests → implement → verify_tests
- \`ask_human\` decision loop with persistent tickets
- Live activity feed with typewriter text, sounds, and a Scout mascot quip engine
- Context orchestrator: L0 constitution + per-task L1 packs, iteration memory, thrash detection
- Model router with tier-escalation on repeat failure + per-task \$ budgets
- Board loop, deploy agent with healthcheck + auto-rollback
- Board MCP server so Claude Code can drive the board itself

**Next:** [Shared Knowledge Layer](https://github.com/ahmd-nish/inventarium/blob/main/docs/knowledgelayer.md) — the multiplayer / live-session / cross-machine team-brain layer is the current build focus.
EOF
)"

echo "✓ Release created"

# Update repo description + topics
gh repo edit "$REPO" \
  --description "The kanban board where your team's AI coding agents share a brain. Multiplayer-first, execution-derived team context." \
  --add-topic inventarium \
  --add-topic claude-code \
  --add-topic coding-agents \
  --add-topic kanban \
  --add-topic mcp \
  --add-topic multiplayer-ai \
  --add-topic tdd \
  --add-topic bun \
  --add-topic typescript

echo "✓ Repo description + topics updated"
