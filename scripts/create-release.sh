#!/usr/bin/env bash
# Creates the v1.1.1 GitHub Release and aligns the repo description + topics.
#
# Prereqs:
#   - `gh auth status` shows you logged in with `repo` scope
#   - the npm packages are ALREADY PUBLISHED — these notes tell people to run
#     `npx inventarium`, and a launch announcement whose first command 404s is
#     worse than no announcement
#
# Tag the release commit first:
#   git tag -a v1.1.1 -m "v1.1.1 — Inventarium" && git push origin v1.1.1

set -euo pipefail

REPO="${GH_REPO:-ahmd-nish/inventarium}"
TAG="${TAG:-v1.1.1}"
# Notes live in a reviewable file rather than a heredoc — easier to edit, and
# immune to the quoting traps of a heredoc inside a command substitution.
NOTES="$(dirname "$0")/../docs/release-notes-v1.1.1.md"

[ -f "$NOTES" ] || { echo "missing release notes: $NOTES" >&2; exit 1; }

gh release create "$TAG" \
  --repo "$REPO" \
  --title "v1.1.1 — Inventarium: the shared knowledge layer" \
  --notes-file "$NOTES"

echo "✓ Release $TAG created"

gh repo edit "$REPO" \
  --description "The kanban board where your team's AI coding agents share a brain. Parallel Claude Code execution under a TDD gate, with a knowledge layer that writes itself." \
  --homepage "https://github.com/$REPO#readme" \
  --add-topic ai --add-topic claude --add-topic claude-code --add-topic agents \
  --add-topic kanban --add-topic developer-tools --add-topic typescript --add-topic bun \
  --add-topic knowledge-graph --add-topic multiplayer

echo "✓ Repo description + topics updated"
echo ""
echo "Verify:"
echo "  gh release view $TAG --repo $REPO"
echo "  npx inventarium --demo"
