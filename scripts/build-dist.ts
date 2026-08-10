#!/usr/bin/env bun
// Builds the publishable CLI tarball.
//
// The monorepo source imports and spawns ACROSS package boundaries
// (`../../core/src/...`, `../../server/src/index.ts`). Those paths exist in the
// workspace and do not exist in a published tarball, so shipping raw source
// produces a package that installs fine and then fails at run time — which is
// exactly what inventarium@1.1.0 did.
//
// So the published artifact is two self-contained bundles plus the built web UI.
import { $ } from "bun";
import { existsSync, mkdirSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const cliPkg = join(root, "packages/cli");
const dist = join(cliPkg, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log("→ building web UI");
await $`bun run --cwd ${join(root, "packages/web")} build`.quiet();
const webDist = join(root, "packages/web/dist");
if (!existsSync(join(webDist, "index.html"))) throw new Error("web build produced no index.html");

console.log("→ bundling server");
await $`bun build ${join(root, "packages/server/src/index.ts")} --target=bun --outfile=${join(dist, "server.js")}`.quiet();

console.log("→ bundling cli");
await $`bun build ${join(cliPkg, "src/index.ts")} --target=bun --outfile=${join(dist, "cli.js")}`.quiet();

// Runtime assets. Bundling inlines code, not files read at run time — shipping
// without these is what made inventarium@1.1.0 install cleanly and then crash
// on `ENOENT: schema.sql`.
console.log("→ bundling ask-human MCP script + runner");
await $`bun build ${join(root, "packages/core/src/mcp/ask-human.ts")} --target=bun --outfile=${join(dist, "ask-human.js")}`.quiet();
await $`bun build ${join(root, "packages/runner/src/index.ts")} --target=bun --outfile=${join(dist, "runner.js")}`.quiet();

console.log("→ copying runtime assets");
cpSync(join(root, "packages/core/src/storage/schema.sql"), join(dist, "schema.sql"));

// The bundled server resolves the UI via `../web/dist` relative to itself.
console.log("→ copying web assets");
cpSync(webDist, join(cliPkg, "web/dist"), { recursive: true });

console.log("✓ dist ready:", dist);
