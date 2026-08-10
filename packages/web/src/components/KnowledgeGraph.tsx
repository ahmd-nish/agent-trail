import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Visual explorer for the knowledge graph (§J).
//
// Canvas + a small force simulation written inline rather than pulling in d3 or
// cytoscape: a graph view should not cost a 200KB dependency in a repo with
// this dependency posture.
//
// Two bugs this file exists to have fixed:
//   1. The canvas measured itself ONCE. Mounted inside a container that was
//      briefly zero-height (behind a modal, during a tab switch), it stayed
//      0px forever and rendered nothing — while the stats line cheerfully
//      reported "5 events · 8 edges". A ResizeObserver fixes it.
//   2. Nothing ever fit the camera to the content, so nodes that drifted
//      outside the viewport read as an empty graph. It now auto-fits.

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
  x?: number; y?: number; vx?: number; vy?: number;
}

interface GraphEdge { source: string; target: string; kind: string; weight: number; resolver: string }
interface Facets { types: Array<{ value: string; count: number }>; actors: Array<{ value: string; count: number }> }

const KIND_COLOR: Record<string, string> = {
  event: "#7dd3fc", file: "#86efac", module: "#fcd34d", symbol: "#c4b5fd",
};

const EVENT_TYPE_COLOR: Record<string, string> = {
  decision: "#f472b6", convention: "#a78bfa", gotcha: "#fb923c",
  failed_attempt: "#f87171", fix: "#4ade80", artifact_summary: "#38bdf8",
  steer: "#fbbf24", handoff: "#2dd4bf",
};

const KIND_GLYPH: Record<string, string> = { file: "◧", module: "▣", symbol: "ƒ" };

function nodeColor(n: GraphNode): string {
  if (n.kind === "event" && n.eventType && EVENT_TYPE_COLOR[n.eventType]) return EVENT_TYPE_COLOR[n.eventType]!;
  return KIND_COLOR[n.kind] ?? "#94a3b8";
}
function nodeRadius(n: GraphNode): number {
  return Math.min(20, 6 + Math.sqrt(n.degree) * 2.6);
}
/** A human ruling is worth more visual weight than an LLM inference. */
function nodeGlow(n: GraphNode): number {
  if (n.confidence === "ruling") return 18;
  if (n.confidence === "observed") return 9;
  return 0;
}

export function KnowledgeGraph() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [facets, setFacets] = useState<Facets>({ types: [], actors: [] });
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  const camera = useRef({ x: 0, y: 0, scale: 1 });
  const dragging = useRef<{ node: GraphNode | null; panning: boolean; lastX: number; lastY: number }>({
    node: null, panning: false, lastX: 0, lastY: 0,
  });
  const hovered = useRef<GraphNode | null>(null);
  const simNodes = useRef<GraphNode[]>([]);
  const simEdges = useRef<GraphEdge[]>([]);
  const adjacency = useRef<Map<string, Set<string>>>(new Map());
  const wantFit = useRef(true);
  const pulses = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const selectedId = useRef<string | null>(null);
  const kickRef = useRef<() => void>(() => {});

  useEffect(() => { selectedId.current = selected?.id ?? null; }, [selected]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (actorFilter) params.set("actor", actorFilter);
      if (query.trim()) params.set("q", query.trim());
      if (focus) params.set("focus", focus);
      const res = await fetch(`/api/knowledge/graph?${params}`);
      if (!res.ok) throw new Error(`graph request failed: ${res.status}`);
      const data = await res.json() as { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean; facets?: Facets };

      // Seed on a circle — a random cloud takes far longer to untangle and
      // looks broken while it does.
      const seeded = data.nodes.map((n, i) => {
        const a = (i / Math.max(1, data.nodes.length)) * Math.PI * 2;
        const r = 130 + (i % 7) * 30;
        return { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 };
      });

      const adj = new Map<string, Set<string>>();
      for (const e of data.edges) {
        if (!adj.has(e.source)) adj.set(e.source, new Set());
        if (!adj.has(e.target)) adj.set(e.target, new Set());
        adj.get(e.source)!.add(e.target);
        adj.get(e.target)!.add(e.source);
      }

      setNodes(seeded); setEdges(data.edges); setTruncated(data.truncated);
      if (data.facets) setFacets(data.facets);
      simNodes.current = seeded; simEdges.current = data.edges; adjacency.current = adj;
      wantFit.current = true;
      kickRef.current();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [typeFilter, actorFilter, query, focus]);

  useEffect(() => { void load(); }, [load]);

  // ── Simulation + render ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    const shell = shellRef.current;
    if (!canvas || !shell) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let alpha = 1;
    let t = 0;
    let w = 0, h = 0;

    // Measure continuously. Measuring once is what left this canvas 0px wide
    // when it mounted behind a modal.
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = shell.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;   // not laid out yet
      if (Math.abs(rect.width - w) < 0.5 && Math.abs(rect.height - h) < 0.5) return;
      w = rect.width; h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      wantFit.current = true;
    };
    const ro = new ResizeObserver(measure);
    ro.observe(shell);
    measure();

    /** Frame every node, so content is never off-screen. */
    const fit = () => {
      const ns = simNodes.current;
      if (ns.length === 0 || w < 2) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of ns) {
        minX = Math.min(minX, n.x!); maxX = Math.max(maxX, n.x!);
        minY = Math.min(minY, n.y!); maxY = Math.max(maxY, n.y!);
      }
      const pad = 110;
      const sx = w / Math.max(60, maxX - minX + pad);
      const sy = h / Math.max(60, maxY - minY + pad);
      camera.current.scale = Math.min(2.2, Math.max(0.2, Math.min(sx, sy)));
      camera.current.x = -((minX + maxX) / 2) * camera.current.scale;
      camera.current.y = -((minY + maxY) / 2) * camera.current.scale;
    };

    const kick = () => { alpha = 1; };
    kickRef.current = kick;

    const step = () => {
      t += 1;
      const ns = simNodes.current;
      const es = simEdges.current;
      const byId = new Map(ns.map((n) => [n.id, n]));

      if (alpha > 0.004) {
        for (let i = 0; i < ns.length; i++) {
          const a = ns[i]!;
          for (let j = i + 1; j < ns.length; j++) {
            const b = ns[j]!;
            let dx = b.x! - a.x!, dy = b.y! - a.y!;
            let d2 = dx * dx + dy * dy;
            if (d2 < 0.01) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 0.01; }
            if (d2 > 120000) continue;
            const f = 1100 / d2;
            const d = Math.sqrt(d2);
            a.vx! -= (dx / d) * f; a.vy! -= (dy / d) * f;
            b.vx! += (dx / d) * f; b.vy! += (dy / d) * f;
          }
        }
        for (const e of es) {
          const a = byId.get(e.source), b = byId.get(e.target);
          if (!a || !b) continue;
          const dx = b.x! - a.x!, dy = b.y! - a.y!;
          const d = Math.max(1, Math.hypot(dx, dy));
          const f = (d - 100) * 0.016;
          a.vx! += (dx / d) * f; a.vy! += (dy / d) * f;
          b.vx! -= (dx / d) * f; b.vy! -= (dy / d) * f;
        }
        for (const n of ns) {
          if (dragging.current.node === n) continue;
          n.vx! -= n.x! * 0.0016; n.vy! -= n.y! * 0.0016;
          n.vx! *= 0.86; n.vy! *= 0.86;
          n.x! += n.vx!; n.y! += n.vy!;
        }
        alpha *= 0.99;
        if (alpha <= 0.004 && wantFit.current) { fit(); wantFit.current = false; }
      } else if (wantFit.current) {
        fit(); wantFit.current = false;
      }

      // ── draw ──
      if (w < 2) { raf = requestAnimationFrame(step); return; }
      ctx.clearRect(0, 0, w, h);

      const hov = hovered.current;
      const selId = selectedId.current;
      const focusId = hov?.id ?? selId;
      const near = focusId ? adjacency.current.get(focusId) : undefined;
      const isLit = (id: string) => !focusId || id === focusId || !!near?.has(id);

      ctx.save();
      ctx.translate(w / 2 + camera.current.x, h / 2 + camera.current.y);
      ctx.scale(camera.current.scale, camera.current.scale);

      // Edges. A lit edge gets a travelling dash so the graph reads as alive
      // rather than a static diagram.
      for (const e of es) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (!a || !b) continue;
        const lit = isLit(a.id) && isLit(b.id) && !!focusId;
        ctx.lineWidth = lit ? 1.8 : 1;
        ctx.strokeStyle = lit
          ? "rgba(125,211,252,0.9)"
          : focusId ? "rgba(100,116,139,0.12)"
          : (e.kind === "produced_by" ? "rgba(148,163,184,0.3)" : "rgba(100,116,139,0.26)");
        if (e.kind === "produced_by") { ctx.setLineDash([4, 3]); ctx.lineDashOffset = 0; }
        else if (lit) { ctx.setLineDash([6, 6]); ctx.lineDashOffset = -t * 0.35; }
        else ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(a.x!, a.y!); ctx.lineTo(b.x!, b.y!); ctx.stroke();
      }
      ctx.setLineDash([]);

      // Click ripples.
      pulses.current = pulses.current.filter((p) => p.t < 1);
      for (const p of pulses.current) {
        p.t += 0.035;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 10 + p.t * 46, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(125,211,252,${(1 - p.t) * 0.5})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      for (const n of ns) {
        const r = nodeRadius(n);
        const sel = selId === n.id;
        const isHov = hov?.id === n.id;
        const lit = isLit(n.id);
        const colour = nodeColor(n);

        // Gentle breathing so a settled graph still feels alive.
        const breathe = 1 + Math.sin((t + n.x!) * 0.03) * 0.03;
        const rr = r * (sel || isHov ? 1.22 : breathe);

        const glow = nodeGlow(n) * (sel || isHov ? 1.6 : 1);
        if (glow > 0 && lit) {
          ctx.shadowColor = colour;
          ctx.shadowBlur = glow;
        }
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, rr, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.globalAlpha = lit ? 1 : 0.16;
        ctx.fill();
        ctx.shadowBlur = 0;

        if (sel) {
          ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.2; ctx.stroke();
        }

        // Code nodes carry a glyph so kind is readable without the legend.
        if (n.kind !== "event" && camera.current.scale > 0.5) {
          ctx.globalAlpha = lit ? 0.85 : 0.15;
          ctx.fillStyle = "rgba(2,6,23,0.85)";
          ctx.font = `${Math.max(8, rr)}px ui-monospace, monospace`;
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(KIND_GLYPH[n.kind] ?? "", n.x!, n.y! + 0.5);
          ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        }

        if (camera.current.scale > 0.6 || r > 11 || isHov || sel) {
          ctx.globalAlpha = lit ? 0.95 : 0.12;
          ctx.fillStyle = "rgba(226,232,240,0.95)";
          ctx.font = `${sel || isHov ? "bold " : ""}11px ui-monospace, monospace`;
          const label = n.label.length > 34 ? `${n.label.slice(0, 33)}…` : n.label;
          ctx.fillText(label, n.x! + rr + 5, n.y! + 3.5);
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const toWorld = (cx: number, cy: number) => {
      const rect = shell.getBoundingClientRect();
      return {
        x: (cx - rect.left - rect.width / 2 - camera.current.x) / camera.current.scale,
        y: (cy - rect.top - rect.height / 2 - camera.current.y) / camera.current.scale,
      };
    };
    const pick = (cx: number, cy: number): GraphNode | null => {
      const { x, y } = toWorld(cx, cy);
      let best: GraphNode | null = null, bestD = Infinity;
      for (const n of simNodes.current) {
        const d = Math.hypot(n.x! - x, n.y! - y);
        if (d < nodeRadius(n) + 6 && d < bestD) { best = n; bestD = d; }
      }
      return best;
    };

    const onDown = (ev: MouseEvent) => {
      const hit = pick(ev.clientX, ev.clientY);
      dragging.current = { node: hit, panning: !hit, lastX: ev.clientX, lastY: ev.clientY };
      if (hit) {
        setSelected(hit);
        pulses.current.push({ x: hit.x!, y: hit.y!, t: 0 });
        alpha = Math.max(alpha, 0.25);
      }
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
        if (prev !== hovered.current) setHoverLabel(hovered.current?.label ?? null);
        canvas.style.cursor = hovered.current ? "pointer" : "grab";
      }
    };
    const onUp = () => { dragging.current = { node: null, panning: false, lastX: 0, lastY: 0 }; };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      camera.current.scale = Math.min(4, Math.max(0.12, camera.current.scale * factor));
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.target instanceof HTMLInputElement) return;
      if (ev.key === "f") { wantFit.current = true; fit(); }
      if (ev.key === "r") { kick(); wantFit.current = true; }
      if (ev.key === "Escape") setSelected(null);
    };

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKey);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, [nodes, edges]);

  const stats = useMemo(() => {
    const events = nodes.filter((n) => n.kind === "event").length;
    return { events, code: nodes.length - events, edges: edges.length };
  }, [nodes, edges]);

  const chip = (active: boolean, colour?: string): React.CSSProperties => ({
    padding: "3px 9px", borderRadius: 999, fontSize: 11, cursor: "pointer",
    fontFamily: "ui-monospace, monospace", whiteSpace: "nowrap",
    border: `1px solid ${active ? (colour ?? "var(--green, #4ade80)") : "var(--border, #334155)"}`,
    background: active ? `${colour ?? "#4ade80"}1f` : "transparent",
    color: active ? (colour ?? "var(--green, #4ade80)") : "var(--fg-faded, #94a3b8)",
    transition: "all 120ms ease",
  });

  const btn: React.CSSProperties = {
    padding: "3px 8px", fontSize: 11, cursor: "pointer", borderRadius: 6,
    border: "1px solid var(--border, #334155)", background: "rgba(15,23,42,0.75)",
    color: "var(--fg-faded, #94a3b8)", fontFamily: "ui-monospace, monospace",
  };

  return (
    <div style={{ display: "flex", height: "calc(100vh - 160px)", gap: 12 }}>
      <div
        ref={shellRef}
        style={{
          flex: 1, position: "relative", minWidth: 0,
          border: "1px solid var(--border, #334155)", borderRadius: 8, overflow: "hidden",
          background: "radial-gradient(1200px 600px at 50% 40%, rgba(56,189,248,0.06), transparent 70%)",
        }}
      >
        {/* Filters */}
        <div style={{
          position: "absolute", top: 10, left: 10, right: 10, zIndex: 2,
          display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", pointerEvents: "auto",
        }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search knowledge…"
            style={{
              padding: "5px 9px", fontSize: 12, borderRadius: 6, width: 180,
              border: "1px solid var(--border, #334155)", background: "rgba(15,23,42,0.85)",
              color: "var(--fg, #e2e8f0)", fontFamily: "ui-monospace, monospace",
            }}
          />
          <span style={chip(!typeFilter && !actorFilter)} onClick={() => { setTypeFilter(""); setActorFilter(""); }}>all</span>
          {facets.types.map((t) => (
            <span key={t.value} style={chip(typeFilter === t.value, EVENT_TYPE_COLOR[t.value])}
              onClick={() => setTypeFilter(typeFilter === t.value ? "" : t.value)}>
              {t.value} {t.count}
            </span>
          ))}
          {facets.actors.length > 1 && facets.actors.map((a) => (
            <span key={a.value} style={chip(actorFilter === a.value, "#38bdf8")}
              onClick={() => setActorFilter(actorFilter === a.value ? "" : a.value)}>
              @{a.value}
            </span>
          ))}
          {focus && (
            <span style={chip(true, "#38bdf8")} onClick={() => setFocus(null)}>✕ focused</span>
          )}
          <span style={{ flex: 1 }} />
          <button style={btn} onClick={() => { wantFit.current = true; }} title="fit to view (f)">⤢ fit</button>
          <button style={btn} onClick={() => { kickRef.current(); wantFit.current = true; }} title="re-run layout (r)">↻ relayout</button>
        </div>

        {/* Live readout */}
        <div style={{
          position: "absolute", bottom: 10, left: 12, zIndex: 2, fontSize: 11,
          color: "var(--fg-faded, #94a3b8)", fontFamily: "ui-monospace, monospace", pointerEvents: "none",
        }}>
          {loading ? "loading…" : (
            <>
              <span style={{ color: "#38bdf8" }}>{stats.events}</span> events ·{" "}
              <span style={{ color: "#86efac" }}>{stats.code}</span> code ·{" "}
              <span style={{ color: "#94a3b8" }}>{stats.edges}</span> edges
              {truncated && <span style={{ color: "#fbbf24" }}> · truncated</span>}
            </>
          )}
          <div style={{ opacity: 0.65, marginTop: 2 }}>
            {hoverLabel ? `▸ ${hoverLabel}` : "drag pan · scroll zoom · click node · f fit · r relayout"}
          </div>
        </div>

        {error && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#f87171", fontSize: 13 }}>
            {error}
          </div>
        )}

        {!loading && !error && nodes.length === 0 && (
          <div style={{
            position: "absolute", inset: 0, display: "grid", placeItems: "center",
            textAlign: "center", padding: 24, pointerEvents: "none",
          }}>
            <div style={{ fontFamily: "ui-monospace, monospace" }}>
              <div style={{ fontSize: 34, opacity: 0.5, marginBottom: 10 }}>◌ ─ ◧ ─ ▣</div>
              <div style={{ color: "var(--fg, #e2e8f0)", marginBottom: 6, fontSize: 13 }}>
                {query || typeFilter || actorFilter ? "Nothing matches those filters." : "No knowledge yet."}
              </div>
              <div style={{ fontSize: 11, color: "var(--fg-faded, #94a3b8)", lineHeight: 1.6 }}>
                {query || typeFilter || actorFilter
                  ? "Clear the filters to see the whole graph."
                  : <>Run a task, or seed from history with<br /><code style={{ color: "#38bdf8" }}>inventarium knowledge backfill</code></>}
              </div>
            </div>
          </div>
        )}

        <canvas ref={canvasRef} style={{ display: "block", cursor: "grab" }} />
      </div>

      {/* Inspector */}
      <aside style={{
        width: 320, flexShrink: 0, overflowY: "auto", fontSize: 12,
        border: "1px solid var(--border, #334155)", borderRadius: 8, padding: 12,
        fontFamily: "ui-monospace, monospace",
      }}>
        {!selected ? (
          <div style={{ color: "var(--fg-faded, #94a3b8)" }}>
            <div style={{ fontWeight: 600, marginBottom: 8, color: "var(--fg, #e2e8f0)" }}>Knowledge graph</div>
            <p style={{ lineHeight: 1.6 }}>
              Coloured nodes are knowledge events. <span style={{ color: "#86efac" }}>◧ files</span>,{" "}
              <span style={{ color: "#fcd34d" }}>▣ modules</span> and{" "}
              <span style={{ color: "#c4b5fd" }}>ƒ symbols</span> are the code they govern.
            </p>
            <p style={{ lineHeight: 1.6 }}>
              Hover a node to light up its neighbourhood. Brighter halos are human rulings;
              dimmer are observations.
            </p>
            <div style={{ marginTop: 12, display: "grid", gap: 5 }}>
              {facets.types.length === 0
                ? Object.entries(EVENT_TYPE_COLOR).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", alignItems: "center", gap: 7, opacity: 0.45 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 999, background: v }} />
                      <span>{k}</span>
                    </div>
                  ))
                : facets.types.map((t) => (
                    <div key={t.value}
                      onClick={() => setTypeFilter(typeFilter === t.value ? "" : t.value)}
                      style={{
                        display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
                        color: typeFilter === t.value ? "var(--fg, #e2e8f0)" : undefined,
                      }}>
                      <span style={{
                        width: 9, height: 9, borderRadius: 999,
                        background: EVENT_TYPE_COLOR[t.value] ?? "#94a3b8",
                      }} />
                      <span style={{ flex: 1 }}>{t.value}</span>
                      <span style={{ opacity: 0.6 }}>{t.count}</span>
                    </div>
                  ))}
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: 0.7, color: nodeColor(selected) }}>
                {selected.eventType ?? selected.kind}
              </span>
              <span style={{ cursor: "pointer", color: "var(--fg-faded, #94a3b8)" }} onClick={() => setSelected(null)}>✕</span>
            </div>
            <div style={{ fontWeight: 600, marginBottom: 8, lineHeight: 1.45, wordBreak: "break-word", fontFamily: "inherit" }}>
              {selected.label}
            </div>
            {selected.actor && (
              <div style={{ color: "var(--fg-faded, #94a3b8)", marginBottom: 8 }}>
                {selected.actor}{selected.validFrom ? ` · ${selected.validFrom.slice(0, 10)}` : ""}
                {selected.confidence ? ` · ${selected.confidence}` : ""}
              </div>
            )}
            <div style={{ color: "var(--fg-faded, #94a3b8)", marginBottom: 8 }}>
              {selected.degree} connection{selected.degree === 1 ? "" : "s"}
            </div>
            {selected.body && (
              <pre style={{
                whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 11, lineHeight: 1.55,
                background: "rgba(148,163,184,0.08)", padding: 9, borderRadius: 6,
                maxHeight: 250, overflow: "auto",
              }}>{selected.body}</pre>
            )}
            {selected.paths && selected.paths.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={{ color: "var(--fg-faded, #94a3b8)", marginBottom: 4 }}>governs</div>
                {selected.paths.map((p) => <div key={p} style={{ fontSize: 11 }}>{p}</div>)}
              </div>
            )}
            <button onClick={() => setFocus(selected.id)} style={{ ...btn, marginTop: 12, width: "100%", padding: "7px 10px", fontSize: 12 }}>
              Focus on this node
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
