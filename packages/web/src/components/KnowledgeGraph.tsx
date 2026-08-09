import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Visual explorer for the knowledge graph (§J).
//
// Canvas + a small force simulation written inline rather than pulling in d3 or
// cytoscape: the whole point of this repo's dependency posture is that a graph
// view should not cost a 200KB library. ~120 lines of physics buys pan, zoom,
// drag, hover and click.

interface GraphNode {
  id: string;
  kind: "event" | "file" | "module" | "symbol";
  label: string;
  eventType?: string;
  actor?: string;
  confidence?: string;
  validFrom?: string;
  body?: string;
  paths?: string[];
  degree: number;
  // simulation state
  x?: number; y?: number; vx?: number; vy?: number;
}

interface GraphEdge { source: string; target: string; kind: string; weight: number; resolver: string }
interface Facets { types: Array<{ value: string; count: number }>; actors: Array<{ value: string; count: number }> }

const KIND_COLOR: Record<string, string> = {
  event: "#7dd3fc",
  file: "#86efac",
  module: "#fcd34d",
  symbol: "#c4b5fd",
};

const EVENT_TYPE_COLOR: Record<string, string> = {
  decision: "#f472b6",
  convention: "#a78bfa",
  gotcha: "#fb923c",
  failed_attempt: "#f87171",
  fix: "#4ade80",
  artifact_summary: "#38bdf8",
  steer: "#fbbf24",
  handoff: "#2dd4bf",
};

function nodeColor(n: GraphNode): string {
  if (n.kind === "event" && n.eventType && EVENT_TYPE_COLOR[n.eventType]) return EVENT_TYPE_COLOR[n.eventType]!;
  return KIND_COLOR[n.kind] ?? "#94a3b8";
}

function nodeRadius(n: GraphNode): number {
  return Math.min(18, 5 + Math.sqrt(n.degree) * 2.4);
}

export function KnowledgeGraph() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [facets, setFacets] = useState<Facets>({ types: [], actors: [] });
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<string>("");
  const [actorFilter, setActorFilter] = useState<string>("");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);

  // View transform + interaction, kept in refs so the animation loop never
  // re-subscribes and React never re-renders per frame.
  const camera = useRef({ x: 0, y: 0, scale: 1 });
  const dragging = useRef<{ node: GraphNode | null; panning: boolean; lastX: number; lastY: number }>({
    node: null, panning: false, lastX: 0, lastY: 0,
  });
  const hovered = useRef<GraphNode | null>(null);
  const simNodes = useRef<GraphNode[]>([]);
  const simEdges = useRef<GraphEdge[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (actorFilter) params.set("actor", actorFilter);
      if (query.trim()) params.set("q", query.trim());
      if (focus) params.set("focus", focus);
      const res = await fetch(`/api/knowledge/graph?${params}`);
      if (!res.ok) throw new Error(`graph request failed: ${res.status}`);
      const data = await res.json() as { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; facets?: Facets };
      // Seed positions on a circle — a random cloud takes far longer to
      // untangle and looks broken while it does.
      const seeded = data.nodes.map((n, i) => {
        const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
        const r = 120 + (i % 7) * 26;
        return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
      });
      setNodes(seeded);
      setEdges(data.edges);
      setTruncated(data.truncated);
      if (data.facets) setFacets(data.facets);
      simNodes.current = seeded;
      simEdges.current = data.edges;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [typeFilter, actorFilter, query, focus]);

  useEffect(() => { void load(); }, [load]);

  // ── Force simulation + render loop ────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let alpha = 1;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const step = () => {
      const ns = simNodes.current;
      const es = simEdges.current;
      const byId = new Map(ns.map((n) => [n.id, n]));

      if (alpha > 0.005) {
        // Repulsion. O(n^2) is fine at the 400-node cap and avoids a quadtree
        // we would otherwise have to maintain and debug.
        for (let i = 0; i < ns.length; i++) {
          const a = ns[i]!;
          for (let j = i + 1; j < ns.length; j++) {
            const b = ns[j]!;
            let dx = (b.x! - a.x!), dy = (b.y! - a.y!);
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
            if (d2 > 90000) continue;                 // ignore distant pairs
            const f = 900 / d2;
            const d = Math.sqrt(d2);
            a.vx! -= (dx / d) * f; a.vy! -= (dy / d) * f;
            b.vx! += (dx / d) * f; b.vy! += (dy / d) * f;
          }
        }
        // Springs
        for (const e of es) {
          const a = byId.get(e.source), b = byId.get(e.target);
          if (!a || !b) continue;
          const dx = b.x! - a.x!, dy = b.y! - a.y!;
          const d = Math.max(1, Math.hypot(dx, dy));
          const f = (d - 90) * 0.015;
          a.vx! += (dx / d) * f; a.vy! += (dy / d) * f;
          b.vx! -= (dx / d) * f; b.vy! -= (dy / d) * f;
        }
        // Centring + damping
        for (const n of ns) {
          if (dragging.current.node === n) continue;
          n.vx! -= n.x! * 0.0015;
          n.vy! -= n.y! * 0.0015;
          n.vx! *= 0.86; n.vy! *= 0.86;
          n.x! += n.vx!; n.y! += n.vy!;
        }
        alpha *= 0.994;
      }

      // ── draw ──
      const rect = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.save();
      ctx.translate(rect.width / 2 + camera.current.x, rect.height / 2 + camera.current.y);
      ctx.scale(camera.current.scale, camera.current.scale);

      ctx.lineWidth = 1;
      for (const e of es) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (!a || !b) continue;
        const active = hovered.current
          && (hovered.current.id === a.id || hovered.current.id === b.id);
        ctx.strokeStyle = active ? "rgba(125,211,252,0.85)" : (e.kind === "produced_by" ? "rgba(148,163,184,0.35)" : "rgba(100,116,139,0.28)");
        ctx.setLineDash(e.kind === "produced_by" ? [4, 3] : []);
        ctx.beginPath();
        ctx.moveTo(a.x!, a.y!);
        ctx.lineTo(b.x!, b.y!);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const n of ns) {
        const r = nodeRadius(n);
        const isSel = selected?.id === n.id;
        const isHov = hovered.current?.id === n.id;
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, r, 0, Math.PI * 2);
        ctx.fillStyle = nodeColor(n);
        ctx.globalAlpha = isSel || isHov ? 1 : 0.85;
        ctx.fill();
        ctx.globalAlpha = 1;
        if (isSel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
        // Label only what is readable — everything else is noise at this zoom.
        if (camera.current.scale > 0.75 || r > 10 || isHov || isSel) {
          ctx.fillStyle = "rgba(226,232,240,0.92)";
          ctx.font = "11px ui-monospace, monospace";
          const label = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
          ctx.fillText(label, n.x! + r + 4, n.y! + 3.5);
        }
      }
      ctx.restore();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - rect.width / 2 - camera.current.x) / camera.current.scale,
        y: (clientY - rect.top - rect.height / 2 - camera.current.y) / camera.current.scale,
      };
    };
    const pick = (clientX: number, clientY: number): GraphNode | null => {
      const { x, y } = toWorld(clientX, clientY);
      let best: GraphNode | null = null, bestD = Infinity;
      for (const n of simNodes.current) {
        const d = Math.hypot(n.x! - x, n.y! - y);
        if (d < nodeRadius(n) + 4 && d < bestD) { best = n; bestD = d; }
      }
      return best;
    };

    const onDown = (ev: MouseEvent) => {
      const hit = pick(ev.clientX, ev.clientY);
      dragging.current = { node: hit, panning: !hit, lastX: ev.clientX, lastY: ev.clientY };
      if (hit) { setSelected(hit); alpha = Math.max(alpha, 0.3); }
    };
    const onMove = (ev: MouseEvent) => {
      const d = dragging.current;
      if (d.node) {
        const { x, y } = toWorld(ev.clientX, ev.clientY);
        d.node.x = x; d.node.y = y; d.node.vx = 0; d.node.vy = 0;
        alpha = Math.max(alpha, 0.2);
      } else if (d.panning) {
        camera.current.x += ev.clientX - d.lastX;
        camera.current.y += ev.clientY - d.lastY;
        d.lastX = ev.clientX; d.lastY = ev.clientY;
      } else {
        const prev = hovered.current;
        hovered.current = pick(ev.clientX, ev.clientY);
        canvas.style.cursor = hovered.current ? "pointer" : "grab";
        if (prev !== hovered.current) alpha = Math.max(alpha, 0.02);
      }
    };
    const onUp = () => { dragging.current = { node: null, panning: false, lastX: 0, lastY: 0 }; };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      camera.current.scale = Math.min(4, Math.max(0.15, camera.current.scale * factor));
    };

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [nodes, edges, selected]);

  const stats = useMemo(() => {
    const events = nodes.filter((n) => n.kind === "event").length;
    return { events, code: nodes.length - events, edges: edges.length };
  }, [nodes, edges]);

  const chip = (active: boolean): React.CSSProperties => ({
    padding: "2px 8px", borderRadius: 999, fontSize: 11, cursor: "pointer",
    border: `1px solid ${active ? "var(--green, #4ade80)" : "var(--border, #334155)"}`,
    background: active ? "rgba(74,222,128,0.12)" : "transparent",
    color: active ? "var(--green, #4ade80)" : "var(--fg-faded, #94a3b8)",
  });

  return (
    <div style={{ display: "flex", height: "calc(100vh - 160px)", gap: 12 }}>
      <div style={{ flex: 1, position: "relative", border: "1px solid var(--border, #334155)", borderRadius: 8, overflow: "hidden" }}>
        <div style={{
          position: "absolute", top: 10, left: 10, zIndex: 2, display: "flex",
          flexWrap: "wrap", gap: 6, alignItems: "center", maxWidth: "calc(100% - 20px)",
        }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search knowledge…"
            style={{
              padding: "4px 8px", fontSize: 12, borderRadius: 6, width: 190,
              border: "1px solid var(--border, #334155)", background: "var(--bg, #0f172a)", color: "var(--fg, #e2e8f0)",
            }}
          />
          <span style={chip(!typeFilter)} onClick={() => setTypeFilter("")}>all types</span>
          {facets.types.map((t) => (
            <span key={t.value} style={chip(typeFilter === t.value)} onClick={() => setTypeFilter(typeFilter === t.value ? "" : t.value)}>
              {t.value} {t.count}
            </span>
          ))}
          {facets.actors.length > 1 && facets.actors.map((a) => (
            <span key={a.value} style={chip(actorFilter === a.value)} onClick={() => setActorFilter(actorFilter === a.value ? "" : a.value)}>
              @{a.value}
            </span>
          ))}
          {focus && (
            <span style={{ ...chip(true), background: "rgba(56,189,248,0.15)", borderColor: "#38bdf8", color: "#38bdf8" }}
              onClick={() => setFocus(null)}>
              ✕ focused
            </span>
          )}
        </div>

        <div style={{
          position: "absolute", bottom: 10, left: 10, zIndex: 2, fontSize: 11,
          color: "var(--fg-faded, #94a3b8)", fontFamily: "ui-monospace, monospace",
        }}>
          {loading ? "loading…" : `${stats.events} events · ${stats.code} code nodes · ${stats.edges} edges`}
          {truncated && <span style={{ color: "#fbbf24" }}> · truncated (filter to see more)</span>}
          <div style={{ opacity: 0.7 }}>drag to pan · scroll to zoom · click a node</div>
        </div>

        {error && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#f87171", fontSize: 13 }}>
            {error}
          </div>
        )}
        {!loading && !error && nodes.length === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--fg-faded, #94a3b8)", fontSize: 13, textAlign: "center", padding: 24 }}>
            <div>
              <div style={{ marginBottom: 6 }}>No knowledge graph yet.</div>
              <div style={{ fontSize: 11, opacity: 0.8 }}>
                Run a task — decisions, failures and contracts become nodes automatically.
              </div>
            </div>
          </div>
        )}
        <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", cursor: "grab" }} />
      </div>

      <aside style={{
        width: 320, flexShrink: 0, overflowY: "auto", fontSize: 12,
        border: "1px solid var(--border, #334155)", borderRadius: 8, padding: 12,
      }}>
        {!selected ? (
          <div style={{ color: "var(--fg-faded, #94a3b8)" }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--fg, #e2e8f0)" }}>Knowledge graph</div>
            <p style={{ lineHeight: 1.5 }}>
              Coloured nodes are knowledge events — decisions, gotchas, failed attempts,
              capability contracts. Grey-green nodes are the code they govern.
            </p>
            <p style={{ lineHeight: 1.5 }}>
              Solid edges are <code>governs</code>; dashed are <code>produced_by</code>.
              Click any node to inspect it, then focus to see only its neighbourhood.
            </p>
            <div style={{ marginTop: 12, display: "grid", gap: 4 }}>
              {Object.entries(EVENT_TYPE_COLOR).map(([k, v]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: v, display: "inline-block" }} />
                  <span>{k}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{
                fontSize: 10, textTransform: "uppercase", letterSpacing: 0.6,
                color: nodeColor(selected),
              }}>
                {selected.eventType ?? selected.kind}
              </span>
              <span style={{ cursor: "pointer", color: "var(--fg-faded, #94a3b8)" }} onClick={() => setSelected(null)}>✕</span>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 8, lineHeight: 1.4, wordBreak: "break-word" }}>
              {selected.label}
            </div>
            {selected.actor && (
              <div style={{ color: "var(--fg-faded, #94a3b8)", marginBottom: 8 }}>
                {selected.actor}{selected.validFrom ? ` · ${selected.validFrom.slice(0, 10)}` : ""}
                {selected.confidence ? ` · ${selected.confidence}` : ""}
              </div>
            )}
            {selected.body && (
              <pre style={{
                whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, lineHeight: 1.5,
                background: "rgba(148,163,184,0.08)", padding: 8, borderRadius: 6, maxHeight: 260, overflow: "auto",
              }}>{selected.body}</pre>
            )}
            {selected.paths && selected.paths.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ color: "var(--fg-faded, #94a3b8)", marginBottom: 4 }}>governs</div>
                {selected.paths.map((p) => <div key={p} style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{p}</div>)}
              </div>
            )}
            <button
              onClick={() => setFocus(selected.id)}
              style={{
                marginTop: 12, width: "100%", padding: "6px 10px", fontSize: 12, cursor: "pointer",
                borderRadius: 6, border: "1px solid var(--border, #334155)",
                background: "transparent", color: "var(--fg, #e2e8f0)",
              }}
            >
              Focus on this node
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
