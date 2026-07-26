import { Hono } from "hono";
import {
  listAgents, readAgent, saveAgent, deleteAgent, scaffoldAgent, importAgentFromUrl,
  type LibraryEntry,
} from "../../../core/src/library/store.ts";
import { resolveProjectRoot } from "../../../core/src/storage/paths.ts";

// PRD_OPEN_SOURCE §4.1/§4.2 — team-shared library HTTP surface.
//   GET    /api/library                 — list
//   GET    /api/library/:name           — read (includes body)
//   POST   /api/library                 — create from body ({ markdown } or { name, description })
//   POST   /api/library/import          — fetch from a URL
//   DELETE /api/library/:name           — remove

export const libraryRouter = new Hono();

function stripBody(e: LibraryEntry) {
  const { body: _body, ...rest } = e;
  void _body;
  return rest;
}

libraryRouter.get("/library", (c) => {
  return c.json(listAgents(resolveProjectRoot()).map(stripBody));
});

libraryRouter.get("/library/:name", (c) => {
  const e = readAgent(resolveProjectRoot(), c.req.param("name"));
  if (!e) return c.json({ error: "not found" }, 404);
  return c.json(e);
});

libraryRouter.post("/library", async (c) => {
  const body = await c.req.json<{ markdown?: string; name?: string; description?: string; overwrite?: boolean }>()
    .catch(() => ({}));

  // Two shapes: paste a full markdown blob, or ask for a scaffold from
  // { name, description }. The scaffold path is what `library new` uses.
  const root = resolveProjectRoot();
  if (body.markdown?.trim()) {
    const { validateAgent } = await import("../../../core/src/library/store.ts");
    const v = validateAgent(body.markdown);
    if (!v.ok) return c.json({ error: v.error }, 400);
    const saved = saveAgent(root, v.entry, { overwrite: body.overwrite === true });
    if (!saved.ok) return c.json({ error: saved.error }, 409);
    return c.json({ ...v.entry, path: saved.path }, 201);
  }
  if (body.name) {
    const scaff = scaffoldAgent(body.name, body.description ?? "TODO: describe what this agent is good at");
    const saved = saveAgent(root, scaff, { overwrite: body.overwrite === true });
    if (!saved.ok) return c.json({ error: saved.error }, 409);
    return c.json({ ...scaff, path: saved.path }, 201);
  }
  return c.json({ error: "provide either { markdown } or { name, description? }" }, 400);
});

libraryRouter.post("/library/import", async (c) => {
  const body = await c.req.json<{ url?: string; overwrite?: boolean }>().catch(() => ({}));
  if (!body.url) return c.json({ error: "url is required" }, 400);
  const r = await importAgentFromUrl(resolveProjectRoot(), body.url, { overwrite: body.overwrite === true });
  if (!r.ok) return c.json({ error: r.error }, 502);
  return c.json(r.entry, 201);
});

libraryRouter.delete("/library/:name", (c) => {
  const removed = deleteAgent(resolveProjectRoot(), c.req.param("name"));
  if (!removed) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
