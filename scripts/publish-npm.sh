#!/usr/bin/env bash
# Publishes the three v1.0.0 packages to npm in dependency order.
#
# Prereqs:
#   1. `bunx npm login` (or `npm login`) — must be logged in as a maintainer of @agent-trail scope
#   2. bun 1.3+ installed
#
# Order matters: core → server → cli, because CLI depends on both.
# Run each publish separately so a failure halts the chain.

set -euo pipefail

cd "$(dirname "$0")/.."

for pkg in core server cli; do
  echo ""
  echo "==================== @agent-trail/$pkg ===================="
  ( cd "packages/$pkg" && bun publish --access public )
  echo "✓ @agent-trail/$pkg published"
done

echo ""
echo "Done. Verify with:"
echo "  npm view @agent-trail/cli"
echo "  npm view @agent-trail/core"
echo "  npm view @agent-trail/server"
echo ""
echo "Then smoke test on a clean machine (or fresh tmp dir with bun globally installed):"
echo "  bunx @agent-trail/cli --demo"
