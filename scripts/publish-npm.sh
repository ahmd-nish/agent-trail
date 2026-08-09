#!/usr/bin/env bash
# Publishes the three v1.0.0 packages to npm in dependency order.
#
# Prereqs:
#   1. `bunx npm login` (or `npm login`) — must be logged in as a maintainer of @inventarium scope
#   2. bun 1.3+ installed
#
# Order matters: core → server → cli, because CLI depends on both.
# Run each publish separately so a failure halts the chain.

set -euo pipefail

cd "$(dirname "$0")/.."

# dir:published-name — the CLI is unscoped so `npx inventarium` works.
for entry in "core:@inventarium/core" "server:@inventarium/server" "cli:inventarium"; do
  dir="${entry%%:*}"; name="${entry##*:}"
  echo ""
  echo "==================== $name ===================="
  ( cd "packages/$dir" && npm publish --access public )
  echo "✓ $name published"
done

echo ""
echo "Done. Verify with:"
echo "  npm view inventarium"
echo "  npm view @inventarium/core"
echo "  npm view @inventarium/server"
echo ""
echo "Then smoke test on a clean machine (or fresh tmp dir with bun globally installed):"
echo "  npx inventarium --demo"
