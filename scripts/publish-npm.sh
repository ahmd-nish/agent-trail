#!/usr/bin/env bash
# Publishes the `inventarium` CLI to npm.
#
# ONE package, deliberately. core and server import across package boundaries
# with relative paths, so they are not consumable as standalone libraries — a
# dependent would hit the same ENOENT the CLI did at 1.1.0. The CLI bundles
# them instead, which is why it is the only publishable artifact.
#
# prepublishOnly runs scripts/build-dist.ts, which bundles cli + server +
# ask-human + runner, copies schema.sql, and builds the web UI.
#
# Prereq: an npm credential that can publish (2FA or a granular token with
# bypass-2fa enabled).

set -euo pipefail
cd "$(dirname "$0")/.."

( cd packages/cli && npm publish --access public )

VERSION="$(node -p "require('./packages/cli/package.json').version")"
echo ""
echo "✓ inventarium@$VERSION published"
echo ""
echo "Verify on a machine that has never seen this repo:"
echo "  npx inventarium@$VERSION --demo"
